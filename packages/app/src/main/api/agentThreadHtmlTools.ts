import Ajv from 'ajv'
import { HTML_APP_INPUT_SCHEMA } from '@shared/api/agentThreadHtml'
import { cloneBoundedMcpJson } from '@shared/api/agentThreadMcp'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { agentThreadHtmlApps } from './agentThreadHtmlApps'
const validate = new Ajv({ strict: false, ownProperties: true }).compile(HTML_APP_INPUT_SCHEMA)
export function createThreadHtmlProvider(options: { request: LLMChatReq; invocation: ServiceInvocationContext; enabled(): boolean; assertLive(): void; signal: AbortSignal }) {
  const owner = {}, releases: Array<(success: boolean) => void> = [], replays = new Map<string, { input: string; result: Promise<unknown> }>()
  let active = true, calls = 0, busy = false
  const check = (signal: AbortSignal) => { signal.throwIfAborted(); options.assertLive(); if (!active || !options.enabled()) throw new Error('Isolated HTML apps are disabled or request ended.') }
  return {
    release(success: boolean) { if (!active) return; active = false; for (const release of releases.splice(0)) release(success) },
    async call(raw: Record<string, unknown>, signal?: AbortSignal, callId?: string): Promise<unknown> {
      const combined = AbortSignal.any([options.signal, ...(signal ? [signal] : [])]); check(combined)
      const input = cloneBoundedMcpJson(raw, 400000) as Record<string, unknown>
      if (!validate(input)) throw new Error('Invalid isolated HTML app arguments.')
      const serialized = JSON.stringify(input), prior = callId ? replays.get(callId) : undefined
      if (prior) { if (prior.input !== serialized) throw new Error('HTML tool replay conflict.'); return prior.result }
      if (busy || ++calls > 12) throw new Error('HTML tool is busy or request budget exhausted.')
      busy = true
      const result = agentThreadHtmlApps.invoke(input, options.request, options.invocation, owner, combined, () => check(combined), release => releases.push(release)).finally(() => { busy = false })
      if (callId) replays.set(callId, { input: serialized, result })
      return result
    }
  }
}
