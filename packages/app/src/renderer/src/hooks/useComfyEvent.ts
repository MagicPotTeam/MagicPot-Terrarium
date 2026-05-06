import { api } from '@renderer/utils/windowUtils'
import { AbortReceiver, AbortSender, newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import { COMFY_EVENT_CLIENT_ID_ALL } from '@shared/api/svcComfy'
import { ComfyEvent, isComfyEvent } from '@shared/comfy/events'
import { createContext, createElement, useContext, useEffect, useRef } from 'react'

type ComfyEventCallback = (event: ComfyEvent) => void

type ComfyEventCallbackOptions = {
  clientId?: string
}

interface CallbackWrapper {
  id: string
  clientId: string
  callback: ComfyEventCallback
}

interface ComfyEventConnection {
  abortSender: AbortSender
  abortReceiver: AbortReceiver
}

interface ComfyEventContextType {
  registerCallback: (callback: ComfyEventCallback, options?: ComfyEventCallbackOptions) => string
  unregisterCallback: (id: string) => void
}

const ComfyEventContext = createContext<ComfyEventContextType | null>(null)

function normalizeComfyEventClientId(clientId?: string): string {
  return String(clientId || '').trim() || COMFY_EVENT_CLIENT_ID_ALL
}

export function useComfyEvent() {
  const context = useContext(ComfyEventContext)
  if (!context) {
    throw new Error('useComfyEvent must be used within a ComfyEventProvider')
  }
  return context
}

export function useComfyEventCallback(
  callback: ComfyEventCallback,
  deps: React.DependencyList = [],
  options?: ComfyEventCallbackOptions
) {
  const { registerCallback, unregisterCallback } = useComfyEvent()
  const callbackIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (callbackIdRef.current) {
      unregisterCallback(callbackIdRef.current)
    }

    callbackIdRef.current = registerCallback(callback, options)

    return () => {
      if (callbackIdRef.current) {
        unregisterCallback(callbackIdRef.current)
        callbackIdRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function ComfyEventProvider({ children }: { children: React.ReactNode }) {
  const callbacksRef = useRef<CallbackWrapper[]>([])
  const connectionsRef = useRef<Map<string, ComfyEventConnection>>(new Map())

  const hasCallbacksForClientId = (clientId: string): boolean => {
    return callbacksRef.current.some((wrapper) => wrapper.clientId === clientId)
  }

  const handleComfyEvent = (clientId: string, event: ComfyEvent) => {
    callbacksRef.current
      .filter((wrapper) => wrapper.clientId === clientId)
      .forEach((wrapper) => {
        try {
          wrapper.callback(event)
        } catch (error) {
          console.error('Error in ComfyEvent callback:', error)
        }
      })
  }

  const disconnectClient = (clientId: string) => {
    const connection = connectionsRef.current.get(clientId)
    if (!connection) return

    try {
      connection.abortSender.abort()
    } finally {
      connectionsRef.current.delete(clientId)
    }
  }

  const connectClient = (clientId: string) => {
    if (connectionsRef.current.has(clientId) || !hasCallbacksForClientId(clientId)) {
      return
    }

    const [abortSender, abortReceiver] = newAbortHandler()
    connectionsRef.current.set(clientId, {
      abortSender,
      abortReceiver
    })

    api()
      .svcComfy.connectWs(
        { client_id: clientId },
        {
          abortReceiver,
          onData: (event) => {
            if (isComfyEvent(event)) {
              handleComfyEvent(clientId, event)
            }
          }
        }
      )
      .catch((error) => {
        console.error('Error in ComfyEvent stream:', error)
      })
      .finally(() => {
        const activeConnection = connectionsRef.current.get(clientId)
        if (activeConnection?.abortSender !== abortSender) {
          return
        }

        connectionsRef.current.delete(clientId)
        if (hasCallbacksForClientId(clientId)) {
          connectClient(clientId)
        }
      })
  }

  const syncConnections = () => {
    const nextClientIds = new Set(callbacksRef.current.map((wrapper) => wrapper.clientId))

    Array.from(connectionsRef.current.keys()).forEach((clientId) => {
      if (!nextClientIds.has(clientId)) {
        disconnectClient(clientId)
      }
    })

    nextClientIds.forEach((clientId) => {
      connectClient(clientId)
    })
  }

  const registerCallback = (
    callback: ComfyEventCallback,
    options?: ComfyEventCallbackOptions
  ): string => {
    const id = Math.random().toString(36).slice(2, 11)
    callbacksRef.current = [
      ...callbacksRef.current,
      {
        id,
        clientId: normalizeComfyEventClientId(options?.clientId),
        callback
      }
    ]
    syncConnections()
    return id
  }

  const unregisterCallback = (id: string) => {
    callbacksRef.current = callbacksRef.current.filter((wrapper) => wrapper.id !== id)
    syncConnections()
  }

  useEffect(() => {
    const connections = connectionsRef.current
    return () => {
      Array.from(connections.keys()).forEach((clientId) => {
        disconnectClient(clientId)
      })
    }
  }, [])

  return createElement(
    ComfyEventContext.Provider,
    {
      value: {
        registerCallback,
        unregisterCallback
      }
    },
    children
  )
}
