import { WebSocket } from 'ws'
import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from './http'
import { JsonDict } from '@shared/utils/utilTypes'
import { EventCenter, EventListener } from '../utils/eventCenter'
import { ComfyEvent, isComfyEvent } from '@shared/comfy/events'
import { getConfiguredComfyProfiles } from './comfyInstancePool'

/**
 * 通过 WebSocket 监听 ComfyUI 状态
 *
 * 这里逻辑很古怪，纯复刻 python backend 的 server.websocket_handler.py
 * 不保证可靠性，以后需要修改
 */

const eventCenter = new EventCenter<ComfyEvent>()

type ComfyState = {
  lastMessage: JsonDict | null
}

type ComfySocketConnection = {
  baseUrl: string
  ws: WebSocket | null
  generation: number
  reconnectTimer: NodeJS.Timeout | null
  reconnectAttempts: number
  wsErrorLogged: boolean
}

class ComfyStateManager {
  // isWatching 不等于 connected：启动但由于网络等问题连接失败时，isWatching 为 true。
  // 普通快应用可能被实例池分配到任意端点，因此这里为每个已启用端点维护一个 socket。
  private isWatching = false
  private sockets = new Map<string, ComfySocketConnection>()

  private comfyState: ComfyState = {
    lastMessage: null
  }

  private readonly baseReconnectInterval = 1000
  private readonly maxReconnectInterval = 30000

  private getReconnectDelay(connection: ComfySocketConnection): number {
    return Math.min(
      this.baseReconnectInterval * Math.pow(2, connection.reconnectAttempts),
      this.maxReconnectInterval
    )
  }

  private configuredBaseUrls(): string[] {
    try {
      return Array.from(
        new Set(
          getConfiguredComfyProfiles()
            .filter((profile) => profile.enabled !== false)
            .map((profile) => profile.baseUrl)
            .filter((baseUrl) => typeof baseUrl === 'string' && baseUrl.trim())
        )
      )
    } catch {
      return []
    }
  }

  private connectProfile(baseUrl: string): void {
    if (!this.isWatching) return

    let connection = this.sockets.get(baseUrl)
    if (!connection) {
      connection = {
        baseUrl,
        ws: null,
        generation: 0,
        reconnectTimer: null,
        reconnectAttempts: 0,
        wsErrorLogged: false
      }
      this.sockets.set(baseUrl, connection)
    }
    if (connection.ws) return

    const generation = ++connection.generation
    const ws = new ComfyHttpCli(undefined, undefined, {
      baseUrl,
      clientId: COMFY_PROCESS_TRANSPORT_CLIENT_ID
    }).connect()
    connection.ws = ws

    ws.onmessage = (evt) => {
      if (
        generation !== connection?.generation ||
        ws !== connection?.ws ||
        this.sockets.get(baseUrl) !== connection
      ) {
        return
      }
      try {
        const data = JSON.parse(evt.data as string) as JsonDict
        if (data.type === 'crystools.monitor') return

        console.log(`[ComfyUI State] received (${baseUrl})`, data)
        this.comfyState.lastMessage = data
        if (isComfyEvent(data)) {
          // 保留原始 prompt_id，转换为内部任务 ID 由 svcComfy.connectWs 统一完成。
          eventCenter.emit(data)
        }
      } catch (error) {
        console.error('[ComfyUI State] error', error)
      }
    }

    ws.onopen = () => {
      if (
        generation !== connection?.generation ||
        ws !== connection?.ws ||
        this.sockets.get(baseUrl) !== connection ||
        !this.isWatching
      ) {
        return
      }
      connection.reconnectAttempts = 0
      connection.wsErrorLogged = false
      console.log(`[ComfyUI State] connected (${baseUrl})`)
    }

    ws.onclose = () => {
      if (
        generation !== connection?.generation ||
        ws !== connection?.ws ||
        this.sockets.get(baseUrl) !== connection
      ) {
        return
      }
      connection.ws = null
      console.log(`[ComfyUI State] disconnected (${baseUrl})`)
      if (this.isWatching) this.scheduleReconnect(connection)
    }

    ws.onerror = () => {
      if (
        generation !== connection?.generation ||
        ws !== connection?.ws ||
        this.sockets.get(baseUrl) !== connection
      ) {
        return
      }
      if (!connection.wsErrorLogged) {
        console.warn(`[ComfyUI State] WebSocket 错误（${baseUrl} 可能未启动），后续不再重复提示`)
        connection.wsErrorLogged = true
      }
    }
  }

  private scheduleReconnect(connection: ComfySocketConnection): void {
    if (!this.isWatching || connection.reconnectTimer) return

    const generation = connection.generation
    const delay = this.getReconnectDelay(connection)
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null
      if (
        !this.isWatching ||
        this.sockets.get(connection.baseUrl) !== connection ||
        generation !== connection.generation
      ) {
        return
      }
      if (eventCenter.isEmpty()) {
        this.scheduleReconnect(connection)
        return
      }

      connection.reconnectAttempts++
      if (!connection.wsErrorLogged) {
        console.log(
          `[ComfyUI State] 尝试重连 (${connection.baseUrl}, ${connection.reconnectAttempts})，${delay}ms 后重试`
        )
      }
      this.connectProfile(connection.baseUrl)
    }, delay)
  }

  private syncProfiles(): void {
    const baseUrls = this.configuredBaseUrls()
    const configured = new Set(baseUrls)
    for (const [baseUrl, connection] of this.sockets) {
      if (configured.has(baseUrl)) continue
      this.disconnectProfile(baseUrl, connection)
    }
    baseUrls.forEach((baseUrl) => this.connectProfile(baseUrl))
  }

  private disconnectProfile(baseUrl: string, connection = this.sockets.get(baseUrl)): void {
    if (!connection) return
    connection.generation++
    if (connection.reconnectTimer) {
      clearTimeout(connection.reconnectTimer)
      connection.reconnectTimer = null
    }
    const ws = connection.ws
    connection.ws = null
    ws?.close()
    this.sockets.delete(baseUrl)
  }

  connect: () => void = () => {
    if (!this.isWatching) return
    this.syncProfiles()
  }

  disconnect: () => void = () => {
    for (const [baseUrl, connection] of this.sockets) {
      this.disconnectProfile(baseUrl, connection)
    }
    this.sockets.clear()
  }

  start: () => void = () => {
    if (this.isWatching) {
      return
    }
    this.isWatching = true
    this.connect()
  }

  stop: () => void = () => {
    this.isWatching = false
    this.disconnect()
  }

  getState: () => ComfyState = () => {
    return this.comfyState
  }
}

const comfyStateManager = new ComfyStateManager()

export function initComfyStateListener() {
  comfyStateManager.start()
}

export function stopComfyStateListener() {
  comfyStateManager.stop()
}

export function getComfyState() {
  return comfyStateManager.getState()
}

export function listenComfyEvent(listener: EventListener<ComfyEvent>) {
  eventCenter.addListener(listener)
  listener.abortReceiver?.onAbort(() => {
    eventCenter.removeListener(listener.id)
  })
}
