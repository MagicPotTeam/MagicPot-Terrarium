import type { ChatAttachment, OCRResult } from '@shared/api/svcLLMProxy'

import { updateScopedExternalLoadingSessionId } from '../ChatPage/chatPageShared'

export type ExternalChatSeedMessage = {
  role: 'user' | 'assistant'
  content: string
  attachments?: ChatAttachment[]
  modelName?: string
}

export type CanvasTargetExternalChatRun = {
  runId: string
  scope: string
  sessionId: string | null
}

export function waitForExternalChatScopeReady(options: {
  scope: string
  timeoutMs?: number
}): Promise<void> {
  const requestId = `chat-scope-ready-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('chat:scope-ready', handleReady as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleReady = (event: Event) => {
      const detail = (event as CustomEvent<{ scope?: string; requestId?: string }>).detail

      if (detail?.scope !== options.scope || detail.requestId !== requestId) {
        return
      }

      cleanup()
      resolve()
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while waiting for the Agent conversation to become ready.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('chat:scope-ready', handleReady as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:ping-scope-ready', {
        detail: {
          scope: options.scope,
          requestId
        }
      })
    )
  })
}

export async function openExternalChatSession(options: {
  scope: string
  title: string
  profileId?: string | null
  initialMessages?: ExternalChatSeedMessage[]
  timeoutMs?: number
}): Promise<string> {
  await waitForExternalChatScopeReady({
    scope: options.scope,
    timeoutMs: options.timeoutMs
  })

  const requestId = `chat-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('chat:session-created', handleCreated as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleCreated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
          requestId?: string
        }>
      ).detail

      if (!detail?.sessionId || detail.requestId !== requestId || detail.scope !== options.scope) {
        return
      }

      cleanup()
      resolve(detail.sessionId)
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while creating the Agent conversation.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('chat:session-created', handleCreated as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:newSession', {
        detail: {
          scope: options.scope,
          title: options.title,
          profileId: options.profileId,
          initialMessages: options.initialMessages,
          requestId
        }
      })
    )
  })
}

export function openExternalAgentPane(options: {
  projectId: string
  timeoutMs?: number
}): Promise<{ paneId: string; scope: string }> {
  const requestId = `agent-pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('agent-workspace:pane-created', handleCreated as EventListener)
      window.clearTimeout(timeoutId)
    }

    const handleCreated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          projectId?: string
          paneId?: string
          scope?: string
          requestId?: string
        }>
      ).detail

      if (
        detail?.projectId !== options.projectId ||
        detail?.requestId !== requestId ||
        !detail.paneId ||
        !detail.scope
      ) {
        return
      }

      cleanup()
      resolve({
        paneId: detail.paneId,
        scope: detail.scope
      })
    }

    const timeoutId = window.setTimeout(() => {
      cleanup()
      reject(new Error('Timed out while creating the Agent thread.'))
    }, options.timeoutMs ?? 6000)

    window.addEventListener('agent-workspace:pane-created', handleCreated as EventListener)
    window.dispatchEvent(
      new CustomEvent('agent-workspace:create-pane', {
        detail: {
          projectId: options.projectId,
          requestId
        }
      })
    )
  })
}

export function appendMessageToExternalChat(options: {
  scope: string
  sessionId?: string | null
  role: 'user' | 'assistant'
  content?: string
  attachments?: ChatAttachment[]
  ocrResult?: OCRResult
  modelName?: string
}) {
  if (!options.sessionId) return

  window.dispatchEvent(
    new CustomEvent('chat:append-message', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId,
        role: options.role,
        content: options.content,
        attachments: options.attachments,
        ocrResult: options.ocrResult,
        modelName: options.modelName
      }
    })
  )
}

export function setExternalChatSessionLoading(options: {
  scope: string
  sessionId?: string | null
  loading: boolean
}) {
  if (!options.sessionId) return

  updateScopedExternalLoadingSessionId(options.scope, options.sessionId, options.loading)

  window.dispatchEvent(
    new CustomEvent('chat:set-external-loading', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId,
        loading: options.loading
      }
    })
  )
}

export async function waitForCanvasTargetProgressPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })
  if (typeof window.requestAnimationFrame !== 'function') return
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve())
  })
}

export function terminateExternalChatSession(options: {
  scope: string
  sessionId?: string | null
}) {
  if (!options.sessionId) return

  window.dispatchEvent(
    new CustomEvent('chat:terminate-session', {
      detail: {
        scope: options.scope,
        sessionId: options.sessionId
      }
    })
  )
}

export function requestExternalChatConfirmation(options: {
  scope: string
  sessionId?: string | null
  prompt: string
  confirmLabel: string
  cancelLabel: string
  confirmedUserContent: string
  cancelledUserContent: string
  timeoutMs?: number
}): Promise<boolean> {
  if (!options.sessionId) {
    return Promise.resolve(false)
  }

  const requestId = `chat-confirmation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  return new Promise((resolve) => {
    const cleanup = () => {
      window.removeEventListener('chat:confirmation-response', handleResponse as EventListener)
      window.removeEventListener(
        'chat:session-terminated',
        handleSessionTerminated as EventListener
      )
      window.clearTimeout(timeoutId)
    }

    const handleResponse = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
          requestId?: string
          confirmed?: boolean
        }>
      ).detail

      if (
        detail?.scope !== options.scope ||
        detail.sessionId !== options.sessionId ||
        detail.requestId !== requestId
      ) {
        return
      }

      cleanup()
      resolve(detail.confirmed === true)
    }

    const handleSessionTerminated = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: string
          sessionId?: string
        }>
      ).detail

      if (detail?.scope !== options.scope || detail.sessionId !== options.sessionId) {
        return
      }

      cleanup()
      resolve(false)
    }

    const timeoutId = window.setTimeout(
      () => {
        cleanup()
        resolve(false)
      },
      options.timeoutMs ?? 30 * 60 * 1000
    )

    window.addEventListener('chat:confirmation-response', handleResponse as EventListener)
    window.addEventListener('chat:session-terminated', handleSessionTerminated as EventListener)
    window.dispatchEvent(
      new CustomEvent('chat:request-confirmation', {
        detail: {
          scope: options.scope,
          sessionId: options.sessionId,
          requestId,
          prompt: options.prompt,
          confirmLabel: options.confirmLabel,
          cancelLabel: options.cancelLabel,
          confirmedUserContent: options.confirmedUserContent,
          cancelledUserContent: options.cancelledUserContent
        }
      })
    )
  })
}
