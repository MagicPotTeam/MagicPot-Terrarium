// Browser-compatible polyfills for window globals exposed by Electron preload
// This file should be imported early in the renderer entry point

import type { BuiltInPath, WinBridge } from '@shared/utils/utilWindow'

/**
 * Check if we're running in Electron context
 * window.api is exposed by preload script only in Electron
 */
const isElectron = typeof window !== 'undefined' && window.api !== undefined

/**
 * Simple path utilities for browser context
 * These are basic implementations that work for most common cases
 */
const browserPath: BuiltInPath = {
  normalize(path: string): string {
    // Replace backslashes with forward slashes and remove duplicate slashes
    return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  },
  isAbsolute(path: string): boolean {
    // Check for Unix absolute path or Windows absolute path
    return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)
  },
  join(first: string, ...args: string[]): string {
    const parts = [first, ...args].filter(Boolean)
    return this.normalize(parts.join('/'))
  },
  relative(from: string, to: string): string {
    const fromParts = this.normalize(from).split('/').filter(Boolean)
    const toParts = this.normalize(to).split('/').filter(Boolean)
    let common = 0
    while (
      common < fromParts.length &&
      common < toParts.length &&
      fromParts[common] === toParts[common]
    ) {
      common++
    }
    const up = new Array(Math.max(0, fromParts.length - common)).fill('..')
    const down = toParts.slice(common)
    return [...up, ...down].join('/') || '.'
  },
  dirname(path: string): string {
    const normalized = this.normalize(path)
    const lastSlash = normalized.lastIndexOf('/')
    if (lastSlash === -1) return '.'
    if (lastSlash === 0) return '/'
    return normalized.substring(0, lastSlash)
  },
  basename(path: string, ext?: string): string {
    const normalized = this.normalize(path)
    const lastSlash = normalized.lastIndexOf('/')
    const base = lastSlash === -1 ? normalized : normalized.substring(lastSlash + 1)
    if (ext && base.endsWith(ext)) {
      return base.substring(0, base.length - ext.length)
    }
    return base
  },
  extname(path: string): string {
    const base = this.basename(path)
    const dotIndex = base.lastIndexOf('.')
    if (dotIndex <= 0) return ''
    return base.substring(dotIndex)
  },
  format(pathObject): string {
    const { root = '', dir = '', base = '', name = '', ext = '' } = pathObject
    const filename = base || `${name}${ext}`
    if (dir) {
      return dir.endsWith('/') ? `${dir}${filename}` : `${dir}/${filename}`
    }
    return `${root}${filename}`
  },
  parse(path: string) {
    const normalized = this.normalize(path)
    const base = this.basename(normalized)
    const ext = this.extname(normalized)
    const name = base.substring(0, base.length - ext.length)
    const dir = this.dirname(normalized)
    const root = this.isAbsolute(normalized)
      ? normalized.match(/^[a-zA-Z]:[\\/]|^\//)?.[0] || '/'
      : ''
    return { root, dir, base, ext, name }
  }
}

/**
 * Mock window bridge for browser context
 */
const browserWinBridge: WinBridge = {
  minimize: async () => {
    console.warn('[browserPolyfills] minimize() not available in browser context')
  },
  toggleMaximize: async () => {
    console.warn('[browserPolyfills] toggleMaximize() not available in browser context')
  },
  isMaximized: async () => false,
  close: async () => {
    console.warn('[browserPolyfills] close() not available in browser context')
  },
  onMaximizeChanged: () => () => {}
}

// Polyfill window.path and window.win if not in Electron
if (!isElectron && typeof window !== 'undefined') {
  // Only set if not already defined
  if (!window.path) {
    // @ts-ignore - polyfilling window.path
    window.path = browserPath
  }
  if (!window.win) {
    // @ts-ignore - polyfilling window.win
    window.win = browserWinBridge
  }
}

export { browserPath, browserWinBridge }
