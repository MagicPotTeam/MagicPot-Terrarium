/* eslint-disable no-control-regex -- Reject control bytes before opening a native path chooser. */
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { dialog, type BrowserWindow } from 'electron'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import {
  AGENT_LOCAL_FILE_ERRORS,
  AGENT_LOCAL_FILE_LIMITS,
  AgentLocalFileError,
  cancelLocalFileRequestSchema,
  chooseLocalFileRequestSchema,
  listLocalFilesRequestSchema,
  parseAgentLocalFileValue,
  readLocalFileRequestSchema,
  revokeLocalFilesRequestSchema,
  setLocalFileScopeRequestSchema,
  type AgentLocalFileErrorCode,
  type AgentLocalFileGrant,
  type AgentLocalFileScope,
  type AgentLocalFilesSvc,
  type CancelLocalFileRequest,
  type ChooseLocalFileRequest,
  type ListLocalFilesRequest,
  type ListLocalFilesResponse,
  type ReadLocalFileRequest,
  type ReadLocalFileResponse,
  type RevokeLocalFilesRequest,
  type SetLocalFileScopeRequest
} from '@shared/api/svcAgentLocalFiles'
import { LocalFileReadGrants } from '../agentLocalFiles/readGrants'
import { authorizeMagicAgentApprovalRenderer } from '../magicAgentRuntime/trustedRouteBinding'

type PendingChooser = {
  scope: AgentLocalFileScope
  requestId: string
  cancelled: boolean
  timedOut: boolean
  deadline: number
}

function safeError(error: unknown): AgentLocalFileError | ServiceValidationError {
  if (error instanceof ServiceValidationError) {
    return new ServiceValidationError('Local file service value')
  }
  if (error instanceof AgentLocalFileError && Object.hasOwn(AGENT_LOCAL_FILE_ERRORS, error.code)) {
    return new AgentLocalFileError(error.code as AgentLocalFileErrorCode)
  }
  return new AgentLocalFileError('IO_ERROR')
}

function sameScope(a: AgentLocalFileScope, b: AgentLocalFileScope): boolean {
  return a.projectId === b.projectId && a.paneId === b.paneId && a.sessionId === b.sessionId
}

function validateSuggestedPath(value: string): void {
  if (
    /[\u0000-\u001f\u007f]/.test(value) ||
    /^[\\/]{2}/.test(value) ||
    !path.isAbsolute(value) ||
    (process.platform === 'win32' ? !/^[A-Za-z]:[\\/]/.test(value) : value.includes('\\'))
  ) {
    throw new AgentLocalFileError('PATH_DENIED')
  }
  const components = value.slice(path.parse(value).root.length).split(/[\\/]/)
  if (
    components.some(
      (part) =>
        /[<>:"|?*]/.test(part) ||
        /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part.replace(/[. ]+$/, ''))
    )
  ) {
    throw new AgentLocalFileError('PATH_DENIED')
  }
}

function checkPending(pending: PendingChooser): void {
  if (pending.timedOut || performance.now() >= pending.deadline) {
    pending.cancelled = true
    throw new AgentLocalFileError('TIMEOUT')
  }
  if (pending.cancelled) throw new AgentLocalFileError('CANCELLED')
}

export class AgentLocalFilesSvcImpl implements AgentLocalFilesSvc {
  private readonly pendingChoosers = new Map<number, PendingChooser>()
  // Main-held active binding; tokens/operations are invalidated on pane/session transition.
  // Renderer announces lifecycle, but cannot create file authority without the native chooser.
  private readonly activeScopes = new Map<
    number,
    { scope: AgentLocalFileScope; parent: BrowserWindow; revision: number }
  >()
  private readonly watchedSenders = new Set<number>()

  constructor(
    private readonly grants = new LocalFileReadGrants(),
    private readonly getMainWindow: () => BrowserWindow | null = () => null
  ) {}

  private authorize(
    method: keyof AgentLocalFilesSvc,
    invocation?: ServiceInvocationContext,
    scope?: AgentLocalFileScope
  ): { parent: BrowserWindow; senderId: number } {
    try {
      if (
        !invocation ||
        invocation.methodName !== `svcAgentLocalFiles.${method}` ||
        !Number.isSafeInteger(invocation.senderId)
      ) {
        throw new AgentLocalFileError('GRANT_DENIED')
      }
      authorizeMagicAgentApprovalRenderer(invocation)
      const parent = this.getMainWindow()
      if (
        !parent ||
        parent.isDestroyed() ||
        parent.webContents.isDestroyed() ||
        parent.webContents.id !== invocation.senderId
      ) {
        throw new AgentLocalFileError('GRANT_DENIED')
      }
      const url = parent.webContents.getURL()
      // Invocation URLs are snapshots. Recheck the live document as well, even for cleanup.
      authorizeMagicAgentApprovalRenderer({ ...invocation, frameUrl: url, senderUrl: url })
      if (scope) {
        const hash = new URL(url).hash.slice(1)
        const separator = hash.indexOf('?')
        const route = hash.slice(0, separator)
        const ids = new URLSearchParams(hash.slice(separator + 1)).getAll('id')
        if (
          separator < 0 ||
          hash.includes('#') ||
          (route !== '/canvas' && route !== '/project-webgl') ||
          ids.length !== 1 ||
          ids[0] !== scope.projectId
        ) {
          throw new AgentLocalFileError('GRANT_DENIED')
        }
        if (method !== 'setScope') {
          const active = this.activeScopes.get(invocation.senderId)
          if (!active || active.parent !== parent || !sameScope(active.scope, scope)) {
            throw new AgentLocalFileError('SCOPE_CHANGED')
          }
        }
      }
      return { parent, senderId: parent.webContents.id }
    } catch (error) {
      if (error instanceof AgentLocalFileError && error.code === 'SCOPE_CHANGED') throw error
      throw new AgentLocalFileError('GRANT_DENIED')
    }
  }

  setScope = async (
    req: SetLocalFileScopeRequest,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    try {
      const request = parseAgentLocalFileValue(setLocalFileScopeRequestSchema, req)
      const { parent, senderId } = this.authorize(
        'setScope',
        invocation,
        request.active ? request.scope : undefined
      )
      const old = this.activeScopes.get(senderId)
      if (!request.active) {
        // A late inactive notification from the previous pane must not clear its successor.
        if (
          old &&
          sameScope(old.scope, request.scope) &&
          (request.revision === undefined || request.revision >= old.revision)
        )
          this.invalidateScope(senderId)
        return
      }
      const revision = request.revision ?? 0
      if (
        old &&
        old.parent === parent &&
        sameScope(old.scope, request.scope) &&
        revision <= old.revision
      )
        return
      if (old && revision < old.revision) return
      this.invalidateScope(senderId)
      this.activeScopes.set(senderId, { scope: request.scope, parent, revision })
      if (!this.watchedSenders.has(senderId)) {
        this.watchedSenders.add(senderId)
        parent.webContents.once?.('destroyed', () => {
          this.invalidateScope(senderId)
          this.watchedSenders.delete(senderId)
        })
        parent.webContents.on?.('did-navigate', () => this.invalidateScope(senderId))
      }
    } catch (error) {
      throw safeError(error)
    }
  }

  private invalidateScope(senderId: number): void {
    this.activeScopes.delete(senderId)
    const pending = this.pendingChoosers.get(senderId)
    if (pending) pending.cancelled = true
    this.grants.revokeSender(senderId)
  }

  choose = async (
    req: ChooseLocalFileRequest,
    invocation?: ServiceInvocationContext
  ): Promise<AgentLocalFileGrant | null> => {
    try {
      const request = parseAgentLocalFileValue(chooseLocalFileRequestSchema, req)
      const { parent, senderId } = this.authorize('choose', invocation, request.scope)
      if (request.suggestedPath !== undefined) validateSuggestedPath(request.suggestedPath)
      if (this.pendingChoosers.has(senderId)) throw new AgentLocalFileError('BUSY')
      const pending: PendingChooser = {
        scope: request.scope,
        requestId: request.requestId,
        cancelled: false,
        timedOut: false,
        deadline: performance.now() + AGENT_LOCAL_FILE_LIMITS.ttlMs
      }
      this.pendingChoosers.set(senderId, pending)
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          pending.timedOut = true
          pending.cancelled = true
          reject(new AgentLocalFileError('TIMEOUT'))
        }, AGENT_LOCAL_FILE_LIMITS.ttlMs)
        timer.unref()
      })
      try {
        const result = await Promise.race([
          dialog.showOpenDialog(parent, {
            title: `Read-only local ${request.kind} access — project ${request.scope.projectId}, pane ${request.scope.paneId}, session ${request.scope.sessionId}`,
            properties: [request.kind === 'file' ? 'openFile' : 'openDirectory'],
            // Never navigate automatically to renderer-provided paths: a DOS path may
            // be a mapped network drive or traverse a network junction before consent.
            // The user must choose/re-enter the file or directory in the native dialog.
            buttonLabel: 'Allow read-only access'
          }),
          timeout
        ])
        checkPending(pending)
        if (this.authorize('choose', invocation, request.scope).parent !== parent) {
          throw new AgentLocalFileError('GRANT_DENIED')
        }
        if (result.canceled) return null
        if (result.filePaths.length !== 1 || !result.filePaths[0]) {
          throw new AgentLocalFileError('PATH_DENIED')
        }
        // This continuation must also revoke a grant that arrives AFTER the timeout race ends.
        const authorization = this.grants
          .authorize(senderId, request.scope, result.filePaths[0], request.kind)
          .then((grant) => {
            try {
              checkPending(pending)
              if (this.authorize('choose', invocation, request.scope).parent !== parent) {
                throw new AgentLocalFileError('GRANT_DENIED')
              }
              return grant
            } catch (error) {
              this.grants.revoke(senderId, request.scope, { grantId: grant.id })
              throw error
            }
          })
        return await Promise.race([authorization, timeout])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        if (this.pendingChoosers.get(senderId) === pending) this.pendingChoosers.delete(senderId)
      }
    } catch (error) {
      throw safeError(error)
    }
  }

  read = async (
    req: ReadLocalFileRequest,
    invocation?: ServiceInvocationContext
  ): Promise<ReadLocalFileResponse> => {
    try {
      const { scope, ...params } = parseAgentLocalFileValue(readLocalFileRequestSchema, req)
      const { senderId } = this.authorize('read', invocation, scope)
      const response = await this.grants.read(senderId, scope, params)
      this.authorize('read', invocation, scope)
      this.grants.assertDeliveryAuthorized(senderId, scope, params.grantId)
      return response
    } catch (error) {
      throw safeError(error)
    }
  }

  list = async (
    req: ListLocalFilesRequest,
    invocation?: ServiceInvocationContext
  ): Promise<ListLocalFilesResponse> => {
    try {
      const { scope, ...params } = parseAgentLocalFileValue(listLocalFilesRequestSchema, req)
      const { senderId } = this.authorize('list', invocation, scope)
      const response = await this.grants.list(senderId, scope, params)
      this.authorize('list', invocation, scope)
      this.grants.assertDeliveryAuthorized(senderId, scope, params.grantId)
      return response
    } catch (error) {
      throw safeError(error)
    }
  }

  revoke = async (
    req: RevokeLocalFilesRequest,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    try {
      const { scope, ...params } = parseAgentLocalFileValue(revokeLocalFilesRequestSchema, req)
      const { senderId } = this.authorize('revoke', invocation)
      const pending = this.pendingChoosers.get(senderId)
      if (pending && sameScope(pending.scope, scope)) pending.cancelled = true
      this.grants.revoke(senderId, scope, params)
    } catch (error) {
      throw safeError(error)
    }
  }

  cancel = async (
    req: CancelLocalFileRequest,
    invocation?: ServiceInvocationContext
  ): Promise<void> => {
    try {
      const { scope, ...params } = parseAgentLocalFileValue(cancelLocalFileRequestSchema, req)
      const { senderId } = this.authorize('cancel', invocation)
      const pending = this.pendingChoosers.get(senderId)
      if (pending && sameScope(pending.scope, scope) && pending.requestId === params.requestId) {
        pending.cancelled = true
      }
      this.grants.cancel(senderId, scope, params)
    } catch (error) {
      throw safeError(error)
    }
  }
}
