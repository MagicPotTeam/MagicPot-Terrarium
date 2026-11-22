import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ManagedFirstRunDependencies, ManagedFirstRunEnvironment } from '../magicAgentPlatform2/agents/managedFirstRunLifecycle'
import { captureManagedData } from '../magicAgentPlatform2/agents/managedRuntimeSnapshot'
import { getConfig, onConfigCommitted } from '../config/config'
import { getBuildEnv } from '../config/buildEnv'
import { AssistantSessionStore } from '../assistantRuntime/sessionStore'
import { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'
import { captureManagedFirstRunPane } from './agentThreadManagedFirstRunScope'

/** Real MAIN preparation dependency, not enabled in normal boot and never an IPC
 * input. The existing lifecycle reserves its exact owner before calling it. Pane
 * data and this environment do not replace either explicit birth/start approval. */
export const prepareManagedFirstRunEnvironment: ManagedFirstRunDependencies['prepare'] = async (_intent, ownerSignal, inputSource) => {
  ownerSignal.throwIfAborted()
  if (!inputSource) throw Error('Managed first-run requires its original MAIN pane invocation.')
  const source = captureManagedData(inputSource)
  if (Object.keys(source).some(key => !['pane', 'invocation'].includes(key))) throw Error('Unexpected managed first-run source data.')
  const pane = captureManagedFirstRunPane(source.pane, source.invocation, 'startManagedFirstRun')
  const lifetime = new AbortController()
  let disposed = false, unsubscribe = () => {}
  const revokeOwner = () => lifetime.abort(ownerSignal.reason ?? Error('Managed first-run owner ended.'))
  const revokePane = () => lifetime.abort(pane.signal.reason ?? Error('Managed first-run pane ended.'))
  const revokeConfig = () => lifetime.abort(Error('Managed first-run configuration changed.'))
  const assertCurrent = () => {
    if (disposed) throw Error('Managed first-run preparation has been disposed.')
    lifetime.signal.throwIfAborted(); ownerSignal.throwIfAborted(); pane.assertLive()
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    unsubscribe()
    ownerSignal.removeEventListener('abort', revokeOwner); pane.signal.removeEventListener('abort', revokePane)
    // Do not dispose the pane binding: it belongs to the UI document, and a late
    // original owner must never retire the next conversation/revision's binding.
    lifetime.abort(Error('Managed first-run preparation disposed.'))
  }
  try {
    ownerSignal.addEventListener('abort', revokeOwner, { once: true })
    pane.signal.addEventListener('abort', revokePane, { once: true })
    unsubscribe = onConfigCommitted(revokeConfig)
    if (ownerSignal.aborted) revokeOwner()
    if (pane.signal.aborted) revokePane()
    assertCurrent()
    const config = captureManagedData(getConfig())
    assertCurrent()
    const data = getBuildEnv().pathMap.data
    if (typeof data !== 'string' || !data) throw Error('Managed first-run private storage root is unavailable.')
    // Fresh internal path only; never the ordinary default session store or a
    // renderer-selected file. Constructor/planning performs no persistence I/O.
    const store = new AssistantSessionStore(path.join(data, 'managed-first-runs', `${randomUUID()}.json`))
    const facade = MagicAgentPlatformSvcImpl.createManagedTextFirstRunService(store)
    assertCurrent()
    const environment: ManagedFirstRunEnvironment = Object.freeze({
      config, configVersion: `managed-pane-config:${randomUUID()}`,
      document: captureManagedData({ ...pane.document, paneRoute: source.pane.route }),
      actor: pane.actor, signal: lifetime.signal, facade, assertCurrent, dispose
    })
    return environment
  } catch (error) { dispose(); throw error }
}
