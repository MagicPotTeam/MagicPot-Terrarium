import { WebSocket } from 'ws'
import { COMFY_PROCESS_TRANSPORT_CLIENT_ID, ComfyHttpCli } from './http'
import { JsonDict } from '@shared/utils/utilTypes'
import { EventCenter, EventListener } from '../utils/eventCenter'
import { ComfyEvent, isComfyEvent } from '@shared/comfy/events'

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

class ComfyStateManager {
  // isWatching 不等于 connected：
  // 启动但由于网络等问题连接失败时，isWatching 为 true ，connected 为 false

  private isWatching: boolean = false // 是否正在监听状态
  private connected: boolean = false // 是否成功连接到 ComfyUI

  private ws: WebSocket | null = null
  private wsErrorLogged: boolean = false

  private comfyState: ComfyState = {
    lastMessage: null
  }

  // 自动重连相关属性
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempts: number = 0
  private readonly baseReconnectInterval: number = 1000 // 1 second base interval
  private readonly maxReconnectInterval: number = 30000 // Max 30 seconds

  // Calculate reconnect delay using exponential backoff
  private getReconnectDelay(): number {
    const delay = Math.min(
      this.baseReconnectInterval * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectInterval
    )
    return delay
  }

  connect: () => void = () => {
    this.ws = new ComfyHttpCli(undefined, undefined, {
      clientId: COMFY_PROCESS_TRANSPORT_CLIENT_ID
    }).connect()
    this.ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data as string) as JsonDict
        if (data.type === 'crystools.monitor') {
          // 太多太烦，直接丢掉
          return
        }
        console.log('[ComfyUI State] received', data)
        this.comfyState.lastMessage = data

        if (isComfyEvent(data)) {
          /**
           * 这里做的是全局的 Event 统一接收处理，在一些更底层更直接与 ComfyUI 打交道的地方会用到，
           * e.g. taskQueue 中等待获取结果，
           * 需要原版的 ComfyUI Event ，拿到真正的 prompt_id
           */
          eventCenter.emit(data)
        }
      } catch (e) {
        console.error('[ComfyUI State] error', e)
      }
    }

    this.ws.onopen = () => {
      this.connected = true
      this.reconnectAttempts = 0 // 连接成功后重置重连次数
      console.log('[ComfyUI State] connected')
    }

    this.ws.onclose = () => {
      this.connected = false
      console.log('[ComfyUI State] disconnected')

      // 如果正在监听状态，尝试自动重连
      if (this.isWatching) {
        this.scheduleReconnect()
      }
    }

    this.ws.onerror = () => {
      if (!this.wsErrorLogged) {
        console.warn('[ComfyUI State] WebSocket 错误（ComfyUI 可能未启动），后续不再重复提示')
        this.wsErrorLogged = true
      }
    }
  }

  private scheduleReconnect: () => void = () => {
    const delay = this.getReconnectDelay()
    this.reconnectTimer = setTimeout(() => {
      if (!this.isWatching) {
        return
      }
      if (eventCenter.isEmpty()) {
        // 静默：避免日志刷屏
        // console.debug('[ComfyUI State] 没有监听者，空转')
        this.scheduleReconnect()
        return
      }

      this.reconnectAttempts++

      if (!this.wsErrorLogged) {
        console.log(`[ComfyUI State] 尝试重连 (${this.reconnectAttempts})，${delay}ms 后重试`)
      }
      this.connect()
    }, delay)
  }

  disconnect: () => void = () => {
    // 清除重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    this.ws?.close()
    this.connected = false
    this.reconnectAttempts = 0
  }

  start: () => void = () => {
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
