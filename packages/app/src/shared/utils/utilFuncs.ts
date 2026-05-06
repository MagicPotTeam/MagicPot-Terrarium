/**
 * Sleep (JS 里居然没有 sleep )
 * @param ms 睡眠时间，单位：毫秒
 * @returns Promise<void>
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 分割字符串，空字符串返回空数组
 * @param str 字符串
 * @returns
 */
export function splitSpace(str: string): string[] {
  return str
    .trim()
    .split(/\s+/)
    .filter((s) => s !== '')
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~') || path.startsWith('\\')
}

export function randInt(max: number = 100): number {
  return Math.floor(Math.random() * max)
}

/**
 * 生成随机大整数
 * @param numBytes 字节数，默认 8 字节
 * @returns 随机大整数
 */
export function randBigInt(numBytes: number = 8): bigint {
  // Generate a random hex string of 2 * numBytes length
  // Each byte (8 bits) corresponds to 2 hex characters
  const hexString = Array(numBytes * 2)
    .fill(0)
    .map(() => Math.floor(Math.random() * 16).toString(16))
    .join('')

  // Convert the hex string to a BigInt
  return BigInt(`0x${hexString}`)
}

export function readableSize(bytes: number): string {
  const thresh = 1024
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let u = 0
  while (bytes >= thresh && u < units.length - 1) {
    bytes /= thresh
    u++
  }
  return `${bytes.toFixed(2)} ${units[u]}`
}

export function readableTime(ms: number): string {
  const date = new Date(ms)
  return date.toLocaleString()
}

/**
 * 从 origin 中解析出 port
 * 比如：
 * - http://localhost:7860
 * - https://localhost:7860
 * - localhost:7860
 * 都返回 7860
 *
 * 而对于
 * - localhost
 * - http://localhost
 * - https://localhost
 * 分别返回 80 和 443
 * @param origin 原始 origin，可能没有协议前缀
 * @returns port
 */
export function parsePortFromOrigin(origin: string): string {
  if (origin === '') {
    return '' // 没有 host ，无效输入
  }
  if (!origin.includes('://')) {
    origin = 'http://' + origin
  }
  const url = new URL(origin)
  return url.port || (url.protocol === 'https:' ? '443' : '80')
}
