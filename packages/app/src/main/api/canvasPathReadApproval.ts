import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { app, BrowserWindow, dialog, webContents } from 'electron'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { AGENT_LOCAL_FILE_LIMITS, AgentLocalFileError } from '@shared/api/svcAgentLocalFiles'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import { createDocumentUtilityExtractor } from '../agentLocalFiles/documents/documentUtilityProcess'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'
import { withCanvasFileTools } from './canvasFileTools'

export type CanvasPathReadLimits = {
  maxBytes?: number
  maxStringLength?: number
  timeoutMs?: number
}
export type CanvasPathReadHandler = (
  filePath: string,
  signal?: AbortSignal,
  limits?: CanvasPathReadLimits
) => Promise<{ content: string; metadata?: Record<string, unknown> }>

// One user-consent prompt per renderer, not a persistent filesystem grant.
const pendingSenders = new Set<number>()
const visible = (value: string): string =>
  value.replace(
    /[\p{Cc}\p{Cf}\p{Cs}]/gu,
    (char) => `[U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}]`
  )

/** Main-only capability. Never serialized in an IPC/HTTP request or added to remote skills.
 * A path in chat is not consent: the native, default-deny prompt authorizes one exact read.
 * LocalFileReadGrants retains all credential, link, identity, type and byte-limit checks.
 */
export function createCanvasPathReadHandler(
  request: LLMChatReq,
  invocation?: ServiceInvocationContext
): CanvasPathReadHandler | undefined {
  if (!invocation || withCanvasFileTools(request, invocation) === request) return undefined
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
    projectId: request.route!.scopeId!,
    paneId: request.route!.threadId!,
    sessionId: request.conversationId!
  }
  const profile = visible(String(request.profileId || '').slice(0, 256))

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
    // Display and authorize the same normalized local path; no pre-consent file access.
    filePath = path.resolve(filePath)
    // The absolute-path bridge shares the grant reader's split policy: plain
    // text remains at 1 MiB, while supported document containers may reach 8 MiB.
    // Extension inspection is only used to choose a ceiling; the grant reader
    // still verifies the actual file type before opening or extracting it.
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
        1024 * 1024,
        Math.floor(Number.isFinite(limits.maxStringLength) ? limits.maxStringLength! : 1024 * 1024)
      )
    )
    const timeoutMs = Math.max(
      1,
      Math.min(10_000, Math.floor(Number.isFinite(limits.timeoutMs) ? limits.timeoutMs! : 10_000))
    )
    let readTimer: ReturnType<typeof setTimeout> | undefined
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
    }, 60_000)
    try {
      check()
      const zh = app.getLocale().toLowerCase().startsWith('zh')
      const choice = await dialog.showMessageBox(parent, {
        type: 'question',
        title: zh ? '允许读取此文件？' : 'Allow reading this file?',
        message: visible(filePath),
        detail: zh
          ? `项目：${scope.projectId}\n线程：${scope.paneId}\n会话：${scope.sessionId}\n模型配置：${profile}\n\n文件内容会发送给当前模型并存入本对话。仅允许读取此文件一次，不授权所在目录。`
          : `Project: ${scope.projectId}\nThread: ${scope.paneId}\nConversation: ${scope.sessionId}\nModel profile: ${profile}\n\nThe contents will be sent to the current model and saved in this conversation. Allow one read of this exact file only, not its directory.`,
        buttons: zh ? ['拒绝', '仅本次读取'] : ['Deny', 'Read once'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        signal: controller.signal
      })
      check()
      if (choice.response !== 1) throw new AgentLocalFileError('GRANT_DENIED')
      readTimer = setTimeout(() => {
        controller.abort(new AgentLocalFileError('TIMEOUT'))
        grants?.revokeSender(senderId)
      }, timeoutMs)
      documents = createDocumentUtilityExtractor()
      grants = new LocalFileReadGrants(documents)
      const grant = await grants.authorize(senderId, scope, filePath, 'file')
      check()
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
      if (result.content.length > maxChars) throw new AgentLocalFileError('TEXT_TOO_LARGE')
      return {
        content: JSON.stringify(result),
        metadata: { source: 'approved-local-file', readOnly: true }
      }
    } finally {
      clearTimeout(timer)
      clearTimeout(readTimer)
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
