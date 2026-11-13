import type { AgentThreadInteractionScope } from '@shared/api/agentThreadInteraction'
import { authorizeAgentThreadScope } from './agentThreadScope'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { BrowserWindow, webContents } from 'electron'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { AGENT_LOCAL_FILE_LIMITS, AgentLocalFileError } from '@shared/api/svcAgentLocalFiles'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import { createDocumentUtilityExtractor } from '../agentLocalFiles/documents/documentUtilityProcess'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import { withCanvasFileTools } from './canvasFileTools'
import {
  validateFilesReadGlob,
  matchesFilesReadGlob,
  selectFilesReadJson,
  boundFilesReadJson
} from '../magicAgentPlatform2/toolHost/files'

export type CanvasPathReadLimits = {
  maxBytes?: number
  maxStringLength?: number
  timeoutMs?: number
  /** Main-owned routing for read-only tools; never sourced from remote request flags. */
  operation?: 'tree' | 'glob' | 'json'
  pattern?: string
  pointer?: string
  maxFiles?: number
  maxDepth?: number
  maxEntries?: number
}
export type CanvasPathReadHandler = (
  filePath: string,
  signal?: AbortSignal,
  limits?: CanvasPathReadLimits
) => Promise<{ content: string; metadata?: Record<string, unknown> }>

// Bound concurrent local reads per renderer, not a user-confirmation gate.
const pendingSenders = new Set<number>()

/** Main-only capability for the desktop's default read-only local filesystem access.
 * No per-path prompt or path mention is required. Renderer/route validation, OS
 * permissions, cancellation, file identity and bounded output checks still apply.
 * The legacy factory name is retained for existing main-process call sites.
 */
export function createCanvasPathReadHandler(
  request: LLMChatReq,
  invocation?: ServiceInvocationContext
): CanvasPathReadHandler | undefined {
  if (!invocation || withCanvasFileTools(request, invocation) === request) return undefined
  try { return createScopedCanvasPathReadHandler({ route: request.route!, conversationId: request.conversationId! }, invocation) }
  catch { return undefined } // Legacy optional-chat callback declines stale identity; side entry remains strict.
}
/** Reuses bounded passive file access after exact service/scope authorization. */
export function createScopedCanvasPathReadHandler(thread: AgentThreadInteractionScope, invocation: ServiceInvocationContext): CanvasPathReadHandler | undefined {
  authorizeAgentThreadScope(thread, invocation, invocation.methodName.split('.').at(-1)!)
  const senderId = invocation.senderId!
  const sender = webContents.fromId(senderId)
  const parent = sender && BrowserWindow.fromWebContents(sender)
  if (
    !sender ||
    !parent ||
    sender.id !== senderId ||
    parent.webContents !== sender ||
    sender.isDestroyed() ||
    parent.isDestroyed()
  )
    return undefined
  const originalUrl = sender.getURL()
  if (originalUrl !== invocation.frameUrl || originalUrl !== invocation.senderUrl) return undefined
  const identity = { ...invocation }
  const scope = {
    projectId: thread.route.scopeId!,
    paneId: thread.route.threadId!,
    sessionId: thread.conversationId
  }

  return async (filePath, signal, limits = {}) => {
    if (
      typeof filePath !== 'string' ||
      !filePath ||
      filePath.length > 4096 ||
      !path.isAbsolute(filePath) ||
      /^[\\/]{2}/.test(filePath) ||
      /[\p{Cc}\p{Cs}]/u.test(filePath) ||
      filePath.split(/[\\/]/).includes('..') ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(filePath))
    )
      throw new AgentLocalFileError('PATH_DENIED')
    // All absolute local paths use the same default read-only policy.
    filePath = path.resolve(filePath)
    const glob = limits.operation === 'glob'
    const json = limits.operation === 'json'
    const tree = limits.operation === 'tree' || glob
    const pattern = glob ? validateFilesReadGlob(limits.pattern || '') : undefined
    const maxFiles = Math.max(
      1,
      Math.min(
        AGENT_LOCAL_FILE_LIMITS.listEntries,
        Math.floor(
          Number.isFinite(limits.maxFiles) ? limits.maxFiles! : AGENT_LOCAL_FILE_LIMITS.listEntries
        )
      )
    )
    // Directory listing is deliberately smaller than workspace traversal and
    // cannot read file bodies. These ceilings apply to the whole invocation.
    const maxDepth = Math.max(
      0,
      Math.min(3, Math.floor(Number.isFinite(limits.maxDepth) ? limits.maxDepth! : glob ? 3 : 0))
    )
    const maxEntries = Math.max(
      1,
      Math.min(
        AGENT_LOCAL_FILE_LIMITS.listEntries,
        Math.floor(
          Number.isFinite(limits.maxEntries)
            ? limits.maxEntries!
            : AGENT_LOCAL_FILE_LIMITS.listEntries
        )
      )
    )
    // Keep file/document byte limits unchanged while removing per-path prompts.
    const documentPath = /\.(?:pdf|docx|xlsx|pptx)$/i.test(filePath)
    const byteCeiling = documentPath
      ? AGENT_LOCAL_FILE_LIMITS.documentBytes
      : AGENT_LOCAL_FILE_LIMITS.fileBytes
    const maxBytes = Math.max(
      1,
      Math.min(
        byteCeiling,
        Math.floor(Number.isFinite(limits.maxBytes) ? limits.maxBytes! : byteCeiling)
      )
    )
    const maxChars = Math.max(
      1,
      Math.min(
        tree ? AGENT_LOCAL_FILE_LIMITS.returnedBytes : 1024 * 1024,
        Math.floor(
          Number.isFinite(limits.maxStringLength)
            ? limits.maxStringLength!
            : tree
              ? AGENT_LOCAL_FILE_LIMITS.returnedBytes
              : 1024 * 1024
        )
      )
    )
    const timeoutMs = Math.max(
      1,
      Math.min(10_000, Math.floor(Number.isFinite(limits.timeoutMs) ? limits.timeoutMs! : 10_000))
    )
    if (pendingSenders.has(senderId)) throw new AgentLocalFileError('BUSY')
    const controller = new AbortController()
    let grants: LocalFileReadGrants | undefined
    let documents: ReturnType<typeof createDocumentUtilityExtractor> | undefined
    const abort = () => {
      controller.abort(new AgentLocalFileError('CANCELLED'))
      grants?.revokeSender(senderId)
    }
    const changed = () => {
      controller.abort(new AgentLocalFileError('SCOPE_CHANGED'))
      grants?.revokeSender(senderId)
    }
    const check = () => {
      if (signal?.aborted && !controller.signal.aborted) abort()
      if (controller.signal.aborted) throw controller.signal.reason
      if (
        sender.isDestroyed() ||
        parent.isDestroyed() ||
        parent.webContents !== sender ||
        sender.getURL() !== originalUrl
      )
        throw new AgentLocalFileError('SCOPE_CHANGED')
      authorizeMagicAgentApprovalRenderer({
        ...identity,
        senderUrl: sender.getURL(),
        frameUrl: sender.getURL()
      })
    }
    pendingSenders.add(senderId)
    signal?.addEventListener('abort', abort, { once: true })
    sender.on('did-start-navigation', changed)
    sender.on('render-process-gone', changed)
    sender.on('destroyed', changed)
    const timer = setTimeout(() => {
      controller.abort(new AgentLocalFileError('TIMEOUT'))
      grants?.revokeSender(senderId)
    }, timeoutMs)
    try {
      check()
      if (!tree) documents = createDocumentUtilityExtractor()
      // This main-owned instance is never shared with the grant-based chooser IPC.
      // Local canvas Agent tools can view ordinary local paths, including hidden
      // project/config directories, without a filename allowlist or a prompt.
      grants = new LocalFileReadGrants(documents, { allLocalPaths: true })
      const grant = await grants.authorize(senderId, scope, filePath, tree ? 'directory' : 'file')
      check()
      if (tree) {
        const entries: Array<{ path: string; type: 'file' | 'directory' }> = []
        const started = Date.now()
        let truncated = false
        let characters = filePath.length + 160
        const walk = async (relativePath: string, depth: number): Promise<void> => {
          check()
          const listed = await grants!.list(
            senderId,
            scope,
            {
              grantId: grant.id,
              requestId: randomUUID(),
              relativePath
            },
            { maxEntries: maxEntries - entries.length }
          )
          check()
          truncated ||= listed.truncated
          for (const entry of listed.entries) {
            check()
            if (entries.length >= maxEntries) {
              truncated = true
              break
            }
            const relative = relativePath ? `${relativePath}/${entry.name}` : entry.name
            const item = { path: relative, type: entry.kind }
            const size = JSON.stringify(item).length + 1
            if (characters + size > maxChars) {
              truncated = true
              break
            }
            entries.push(item)
            characters += size
            if (entry.kind === 'directory' && depth < maxDepth && entries.length < maxEntries) {
              await walk(relative, depth + 1)
            } else if (entry.kind === 'directory') truncated = true
          }
        }
        await walk('', 0)
        check()
        grants.assertDeliveryAuthorized(senderId, scope, grant.id)
        const results = pattern
          ? entries.filter((entry) => matchesFilesReadGlob(pattern, entry.path))
          : entries
        const returned = glob ? results.slice(0, maxFiles) : results
        const content = JSON.stringify({
          root: filePath,
          ...(glob ? { pattern } : { path: '.' }),
          entries: returned,
          entryCount: returned.length,
          truncated: truncated || returned.length < results.length,
          nameFiltering: false,
          linksSkipped: true,
          durationMs: Date.now() - started
        })
        if (
          content.length > maxChars ||
          Buffer.byteLength(content, 'utf8') > AGENT_LOCAL_FILE_LIMITS.returnedBytes
        )
          throw new AgentLocalFileError('TEXT_TOO_LARGE')
        return { content, metadata: { source: 'local-directory', readOnly: true } }
      }
      const result = await grants.read(
        senderId,
        scope,
        {
          grantId: grant.id,
          requestId: randomUUID(),
          relativePath: ''
        },
        { maxBytes }
      )
      check()
      grants.assertDeliveryAuthorized(senderId, scope, grant.id)
      if (!json && result.content.length > maxChars) throw new AgentLocalFileError('TEXT_TOO_LARGE')
      if (json) {
        let parsed: unknown
        try {
          parsed = JSON.parse(result.content.replace(/^\uFEFF/, ''), (key, value) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key))
              throw new Error('JSON prototype keys are not allowed.')
            return value
          })
        } catch {
          throw new Error('File does not contain valid safe JSON.')
        }
        const selected = selectFilesReadJson(parsed, limits.pointer)
        const bounded = boundFilesReadJson(
          selected,
          Math.max(
            0,
            Math.min(12, Math.floor(Number.isFinite(limits.maxDepth) ? limits.maxDepth! : 12))
          ),
          Math.max(
            1,
            Math.min(
              10000,
              Math.floor(Number.isFinite(limits.maxEntries) ? limits.maxEntries! : 10000)
            )
          ),
          limits.maxStringLength === undefined ? 16384 : maxChars
        )
        const content = JSON.stringify({
          path: filePath,
          pointer: limits.pointer,
          value: bounded.value,
          bytes: result.sizeBytes,
          truncated: bounded.truncated,
          sha256: createHash('sha256').update(result.content).digest('hex')
        })
        if (Buffer.byteLength(content, 'utf8') > AGENT_LOCAL_FILE_LIMITS.responseBytes)
          throw new AgentLocalFileError('TEXT_TOO_LARGE')
        return { content, metadata: { source: 'local-file', readOnly: true } }
      }
      return {
        content: JSON.stringify(result),
        metadata: { source: 'local-file', readOnly: true }
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      sender.removeListener('did-start-navigation', changed)
      sender.removeListener('render-process-gone', changed)
      sender.removeListener('destroyed', changed)
      grants?.revokeSender(senderId)
      documents?.dispose()
      pendingSenders.delete(senderId)
    }
  }
}
