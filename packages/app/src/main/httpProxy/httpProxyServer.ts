// packages/app/src/main/httpProxy/httpProxyServer.ts
// HTTP 代理服务器，支持连接限制、排队和空闲超时

import dns from 'node:dns/promises'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import { URL } from 'url'

let proxyServer: http.Server | null = null

// ===== 连接管理配置 =====
const MAX_CONNECTIONS_PER_IP = 50 // 每个 IP 最大并发连接数（一个网页需要很多连接）
const MAX_UNIQUE_IPS = 4 // 最多允许 4 个不同用户同时使用
const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 空闲超时：5分钟
const QUEUE_TIMEOUT_MS = 60 * 1000 // 排队超时：60秒
const MAX_QUEUED_CONNECTIONS = 200
const MAX_QUEUED_CONNECTIONS_PER_IP = 50
const SAFE_CONNECT_PORTS = new Set([80, 443])

const nonPublicTargets = new net.BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
] as const) {
  nonPublicTargets.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32]
] as const) {
  nonPublicTargets.addSubnet(network, prefix, 'ipv6')
}

export interface ConnectTarget {
  hostname: string
  port: number
}

export function parseConnectTarget(authority: string | undefined): ConnectTarget {
  if (
    !authority ||
    Array.from(authority).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error('CONNECT target must be a host and port')
  }

  const match = authority.startsWith('[')
    ? /^\[([^\]]+)]:(\d{1,5})$/.exec(authority)
    : /^([^:@[\]]+):(\d{1,5})$/.exec(authority)
  if (!match) throw new Error('CONNECT target must use host:port syntax')

  const hostname = match[1].toLowerCase().replace(/\.$/, '')
  const port = Number(match[2])
  const ipFamily = net.isIP(hostname)
  if (
    !hostname ||
    (!ipFamily &&
      (hostname.length > 253 ||
        !hostname.includes('.') ||
        !hostname.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))))
  ) {
    throw new Error('CONNECT target host is invalid')
  }
  if (!Number.isInteger(port) || !SAFE_CONNECT_PORTS.has(port)) {
    throw new Error('CONNECT target port is not allowed')
  }
  return { hostname, port }
}

export function isPublicTargetAddress(address: string): boolean {
  const family = net.isIP(address)
  return family !== 0 && !nonPublicTargets.check(address, family === 4 ? 'ipv4' : 'ipv6')
}

async function resolvePublicTarget(hostname: string): Promise<{ address: string; family: 4 | 6 }> {
  if (net.isIP(hostname)) {
    if (!isPublicTargetAddress(hostname)) throw new Error('CONNECT target must be public')
    return { address: hostname, family: net.isIP(hostname) as 4 | 6 }
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some((entry) => !isPublicTargetAddress(entry.address))) {
    throw new Error('CONNECT target resolved to a non-public address')
  }
  const target = addresses[0]
  return { address: target.address, family: target.family === 6 ? 6 : 4 }
}

// ===== 连接状态追踪 =====
interface ClientConnection {
  id: string
  ip: string
  socket: net.Socket
  lastActivity: number
  createdAt: number
}

const activeConnections = new Map<string, ClientConnection>()

export function removeExactQueueEntry<T>(queue: T[], entry: T): boolean {
  const index = queue.indexOf(entry)
  if (index === -1) return false
  queue.splice(index, 1)
  return true
}

export function hasQueueCapacity(queuedIps: readonly string[], ip: string): boolean {
  return (
    queuedIps.length < MAX_QUEUED_CONNECTIONS &&
    queuedIps.filter((queuedIp) => queuedIp === ip).length < MAX_QUEUED_CONNECTIONS_PER_IP
  )
}

interface QueuedConnection {
  resolve: () => void
  reject: (err: Error) => void
  timeout: NodeJS.Timeout
  ip: string
  socket: net.Socket
  onClose: () => void
  onError: () => void
  settled: boolean
}
const connectionQueue: QueuedConnection[] = []

// 生成连接 ID
function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`
}

// 获取客户端 IP
function getClientIP(socket: net.Socket): string {
  return socket.remoteAddress?.replace('::ffff:', '') || 'unknown'
}

// 更新连接活动时间
function updateActivity(connId: string): void {
  const conn = activeConnections.get(connId)
  if (conn) {
    conn.lastActivity = Date.now()
  }
}

// 清理空闲连接
function cleanupIdleConnections(): void {
  const now = Date.now()
  for (const [id, conn] of activeConnections) {
    if (now - conn.lastActivity > IDLE_TIMEOUT_MS) {
      console.log(`[HttpProxy] ⏰ Idle timeout, disconnecting: ${conn.ip} (${id})`)
      conn.socket.destroy()
      activeConnections.delete(id)
      processQueue() // 处理排队的连接
    }
  }
}

// 获取指定 IP 的当前连接数
function getConnectionCountByIP(ip: string): number {
  let count = 0
  for (const conn of activeConnections.values()) {
    if (conn.ip === ip) count++
  }
  return count
}

// 获取当前活跃的唯一 IP 数量
function getUniqueIPCount(): number {
  const ips = new Set<string>()
  for (const conn of activeConnections.values()) {
    ips.add(conn.ip)
  }
  return ips.size
}

// 检查是否是已存在的 IP
function isExistingIP(ip: string): boolean {
  for (const conn of activeConnections.values()) {
    if (conn.ip === ip) return true
  }
  return false
}

function removeQueuedConnection(entry: QueuedConnection, error?: Error): boolean {
  if (entry.settled) return false
  if (!removeExactQueueEntry(connectionQueue, entry)) return false

  entry.settled = true
  clearTimeout(entry.timeout)
  entry.socket.off('close', entry.onClose)
  entry.socket.off('error', entry.onError)
  if (error) entry.reject(error)
  return true
}

function canAcquireConnection(ip: string): boolean {
  return (
    getConnectionCountByIP(ip) < MAX_CONNECTIONS_PER_IP &&
    (isExistingIP(ip) || getUniqueIPCount() < MAX_UNIQUE_IPS)
  )
}

// Process every eligible entry so a blocked queue head cannot starve other clients.
function processQueue(): void {
  let index = 0
  while (index < connectionQueue.length) {
    const next = connectionQueue[index]
    if (!next || !canAcquireConnection(next.ip)) {
      index++
      continue
    }

    removeQueuedConnection(next)
    next.resolve()
    // Registration is synchronous in resolve(), so re-check capacity before continuing.
  }
}

// 请求连接许可（如果已满则排队）
async function acquireConnection(socket: net.Socket): Promise<string> {
  const ip = getClientIP(socket)
  const ipConnCount = getConnectionCountByIP(ip)
  const uniqueIPs = getUniqueIPCount()
  const isExisting = isExistingIP(ip)

  // 检查是否需要排队
  const needQueue =
    ipConnCount >= MAX_CONNECTIONS_PER_IP || // 该 IP 连接数已满
    (!isExisting && uniqueIPs >= MAX_UNIQUE_IPS) // 新 IP 且 IP 数已满

  if (needQueue) {
    if (!isExisting && uniqueIPs >= MAX_UNIQUE_IPS) {
      console.log(`[HttpProxy] ⏳ Max users reached (${uniqueIPs}/${MAX_UNIQUE_IPS}), ${ip} queued`)
    } else {
      console.log(
        `[HttpProxy] ⏳ ${ip} max connections reached (${ipConnCount}/${MAX_CONNECTIONS_PER_IP}), queued`
      )
    }

    if (
      !hasQueueCapacity(
        connectionQueue.map((entry) => entry.ip),
        ip
      )
    ) {
      throw new Error('Connection queue is full')
    }

    // 进入排队
    return new Promise((resolve, reject) => {
      const entry: QueuedConnection = {
        resolve: () => undefined,
        reject,
        timeout: setTimeout(() => undefined, 0),
        ip,
        socket,
        onClose: () => undefined,
        onError: () => undefined,
        settled: false
      }
      const cancel = (reason: string): void => {
        removeQueuedConnection(entry, new Error(reason))
      }
      entry.resolve = () => {
        if (socket.destroyed) {
          reject(new Error('Client disconnected while queued'))
          return
        }
        resolve(registerConnection(socket, ip))
      }
      clearTimeout(entry.timeout)
      entry.timeout = setTimeout(() => cancel('Queue timeout'), QUEUE_TIMEOUT_MS)
      entry.onClose = () => cancel('Client disconnected while queued')
      entry.onError = () => cancel('Client socket errored while queued')
      connectionQueue.push(entry)
      socket.once('close', entry.onClose)
      socket.once('error', entry.onError)
      if (socket.destroyed) cancel('Client disconnected while queued')
    })
  }

  return registerConnection(socket, ip)
}

// 注册新连接
function registerConnection(socket: net.Socket, ip: string): string {
  const connId = generateConnectionId()
  const now = Date.now()

  activeConnections.set(connId, {
    id: connId,
    ip,
    socket,
    lastActivity: now,
    createdAt: now
  })

  const ipConnCount = getConnectionCountByIP(ip)
  const uniqueIPs = getUniqueIPCount()

  // 只在连接数较少时打印日志，避免刷屏
  if (ipConnCount <= 3 || activeConnections.size % 10 === 0) {
    console.log(
      `[HttpProxy] ✅ ${ip} connected [IP:${ipConnCount}/${MAX_CONNECTIONS_PER_IP}] [Users:${uniqueIPs}/${MAX_UNIQUE_IPS}]`
    )
  }

  return connId
}

// 释放连接
function releaseConnection(connId: string): void {
  const conn = activeConnections.get(connId)
  if (conn) {
    activeConnections.delete(connId)
    const ipConnCount = getConnectionCountByIP(conn.ip)
    // 只在连接数较少时打印日志
    if (ipConnCount <= 2) {
      console.log(`[HttpProxy] 🔌 ${conn.ip} disconnected [remaining:${ipConnCount}]`)
    }
    processQueue()
  }
}

/**
 * 启动 HTTP 代理服务器
 */
export async function startHttpProxy(port: number): Promise<void> {
  if (proxyServer) {
    console.log('[HttpProxy] Proxy server already running')
    return
  }

  // 定期清理空闲连接
  const cleanupInterval = setInterval(cleanupIdleConnections, 60 * 1000)

  return new Promise((resolve, reject) => {
    proxyServer = http.createServer(async (req, res) => {
      const clientSocket = req.socket
      let connId: string | null = null

      try {
        connId = await acquireConnection(clientSocket)
        updateActivity(connId)
      } catch (err) {
        console.log(`[HttpProxy] ❌ ${getClientIP(clientSocket)} queue timeout rejected`)
        res.writeHead(503, { 'Content-Type': 'text/plain' })
        res.end('Server Busy - Please try again later')
        return
      }

      // 处理普通 HTTP 请求
      const targetUrl = req.url
      if (!targetUrl) {
        res.writeHead(400)
        res.end('Bad Request')
        if (connId) releaseConnection(connId)
        return
      }

      try {
        const parsedUrl = new URL(targetUrl)
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          throw new Error(`Unsupported proxy protocol: ${parsedUrl.protocol}`)
        }
        if (parsedUrl.username || parsedUrl.password) {
          throw new Error('Proxy target credentials are not allowed')
        }
        const targetPort = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80))
        if (!SAFE_CONNECT_PORTS.has(targetPort)) {
          throw new Error('Proxy target port is not allowed')
        }
        const resolvedTarget = await resolvePublicTarget(parsedUrl.hostname)
        const options: http.RequestOptions = {
          hostname: resolvedTarget.address,
          family: resolvedTarget.family,
          port: targetPort,
          path: parsedUrl.pathname + parsedUrl.search,
          method: req.method,
          headers: req.headers,
          ...(parsedUrl.protocol === 'https:' ? { servername: parsedUrl.hostname } : {})
        }

        delete options.headers!['host']

        const protocol = parsedUrl.protocol === 'https:' ? https : http
        const proxyReq = protocol.request(options, (proxyRes) => {
          if (connId) updateActivity(connId)
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
          proxyRes.pipe(res)
        })

        proxyReq.on('error', (err) => {
          console.error('[HttpProxy] Request failed:', err.message)
          res.writeHead(502)
          res.end('Bad Gateway')
        })

        res.on('finish', () => {
          if (connId) releaseConnection(connId)
        })

        req.pipe(proxyReq)
      } catch (err) {
        console.error('[HttpProxy] URL parse failed:', err)
        res.writeHead(400)
        res.end('Bad Request')
        if (connId) releaseConnection(connId)
      }
    })

    // 处理 HTTPS CONNECT 请求（隧道代理）
    proxyServer.on('connect', async (req, clientSocket, head) => {
      let connId: string | null = null
      // 类型断言：clientSocket 实际上是 net.Socket
      const socket = clientSocket as net.Socket
      let target: ConnectTarget
      let resolvedTarget: Awaited<ReturnType<typeof resolvePublicTarget>>

      try {
        target = parseConnectTarget(req.url)
        resolvedTarget = await resolvePublicTarget(target.hostname)
      } catch (err) {
        console.warn(
          '[HttpProxy] CONNECT target rejected:',
          err instanceof Error ? err.message : err
        )
        clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        return
      }

      try {
        connId = await acquireConnection(socket)
        updateActivity(connId)
      } catch (err) {
        if (!socket.destroyed) {
          console.log(`[HttpProxy] ❌ ${getClientIP(socket)} CONNECT queue rejected`)
          clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        }
        return
      }

      console.log(
        `[HttpProxy] 🔒 CONNECT ${target.hostname}:${target.port} from ${getClientIP(socket)}`
      )

      // Connect to the validated address, not the hostname, to prevent DNS rebinding.
      const serverSocket = net.connect(target.port, resolvedTarget.address, () => {
        if (connId) updateActivity(connId)
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        serverSocket.write(head)
        serverSocket.pipe(clientSocket)
        clientSocket.pipe(serverSocket)
      })

      // 数据流动时更新活动时间
      clientSocket.on('data', () => {
        if (connId) updateActivity(connId)
      })

      serverSocket.on('error', (err) => {
        console.error('[HttpProxy] Tunnel connection failed:', err.message)
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        if (connId) releaseConnection(connId)
      })

      clientSocket.on('error', (err) => {
        console.error('[HttpProxy] Client connection error:', err.message)
        serverSocket.destroy()
        if (connId) releaseConnection(connId)
      })

      clientSocket.on('close', () => {
        if (connId) releaseConnection(connId)
      })

      serverSocket.on('close', () => {
        if (connId) releaseConnection(connId)
      })
    })

    proxyServer.on('error', (err) => {
      console.error('[HttpProxy] Server error:', err)
      clearInterval(cleanupInterval)
      reject(err)
    })

    proxyServer.on('close', () => {
      clearInterval(cleanupInterval)
    })

    proxyServer.listen(port, '127.0.0.1', () => {
      console.log(`[HttpProxy] ✅ Local HTTP proxy started on 127.0.0.1:${port}`)
      console.log(
        `[HttpProxy] 📊 Max users: ${MAX_UNIQUE_IPS}, Per-user connections: ${MAX_CONNECTIONS_PER_IP}, Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`
      )
      console.log(`[HttpProxy] Client config: http://127.0.0.1:${port}`)
      resolve()
    })
  })
}

/**
 * 停止 HTTP 代理服务器
 */
export async function stopHttpProxy(): Promise<void> {
  if (!proxyServer) {
    return
  }

  // 断开所有活跃连接
  for (const [id, conn] of activeConnections) {
    conn.socket.destroy()
    activeConnections.delete(id)
  }

  // 清空排队
  for (const q of [...connectionQueue]) {
    removeQueuedConnection(q, new Error('Server shutting down'))
  }

  return new Promise((resolve) => {
    proxyServer!.close(() => {
      console.log('[HttpProxy] Proxy server stopped')
      proxyServer = null
      resolve()
    })
  })
}

/**
 * 获取代理服务器状态
 */
export function isHttpProxyRunning(): boolean {
  return proxyServer !== null
}

/**
 * 获取当前连接统计
 */
export function getConnectionStats(): {
  activeConnections: number
  activeUsers: number
  maxUsers: number
  queued: number
  queuedIps: string[]
  connections: Array<{ ip: string; count: number; idleSeconds: number }>
} {
  const now = Date.now()
  // 按 IP 分组统计
  const ipStats = new Map<string, { count: number; lastActivity: number }>()
  for (const conn of activeConnections.values()) {
    const existing = ipStats.get(conn.ip)
    if (existing) {
      existing.count++
      existing.lastActivity = Math.max(existing.lastActivity, conn.lastActivity)
    } else {
      ipStats.set(conn.ip, { count: 1, lastActivity: conn.lastActivity })
    }
  }

  return {
    activeConnections: activeConnections.size,
    activeUsers: ipStats.size,
    maxUsers: MAX_UNIQUE_IPS,
    queued: connectionQueue.length,
    queuedIps: connectionQueue.map((q) => q.ip),
    connections: Array.from(ipStats.entries()).map(([ip, stats]) => ({
      ip,
      count: stats.count,
      idleSeconds: Math.round((now - stats.lastActivity) / 1000)
    }))
  }
}

/**
 * 获取指定 IP 的排队位置
 * @returns 0 = 已连接, 1-N = 排队位置, -1 = 不在队列中
 */
export function getQueuePosition(clientIp: string): {
  position: number
  total: number
  active: number
  max: number
  status: 'connected' | 'queued' | 'available' | 'unknown'
} {
  const uniqueIPs = getUniqueIPCount()

  // 检查是否已连接
  if (isExistingIP(clientIp)) {
    return {
      position: 0,
      total: connectionQueue.length,
      active: uniqueIPs,
      max: MAX_UNIQUE_IPS,
      status: 'connected'
    }
  }

  // 检查排队位置
  const queueIndex = connectionQueue.findIndex((q) => q.ip === clientIp)
  if (queueIndex !== -1) {
    return {
      position: queueIndex + 1,
      total: connectionQueue.length,
      active: uniqueIPs,
      max: MAX_UNIQUE_IPS,
      status: 'queued'
    }
  }

  // 检查是否有可用位置
  if (uniqueIPs < MAX_UNIQUE_IPS) {
    return {
      position: 0,
      total: connectionQueue.length,
      active: uniqueIPs,
      max: MAX_UNIQUE_IPS,
      status: 'available'
    }
  }

  return {
    position: -1,
    total: connectionQueue.length,
    active: uniqueIPs,
    max: MAX_UNIQUE_IPS,
    status: 'unknown'
  }
}
