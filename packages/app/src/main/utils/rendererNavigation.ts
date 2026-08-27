function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

export function isTrustedRendererNavigation(
  targetUrl: string,
  trustedRendererUrl: string
): boolean {
  const target = parseUrl(targetUrl)
  const trusted = parseUrl(trustedRendererUrl)
  if (!target || !trusted) {
    return false
  }

  if (trusted.protocol === 'file:') {
    return target.protocol === 'file:' && target.pathname === trusted.pathname
  }

  return target.origin === trusted.origin
}
