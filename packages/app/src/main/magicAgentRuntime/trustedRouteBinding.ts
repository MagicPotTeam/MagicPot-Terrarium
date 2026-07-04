import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { getAgentSessionKey, normalizeAgentRoute, type AgentRouteLike } from '@shared/agent'
import {
  MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE,
  MAGIC_AGENT_TRUSTED_ROUTE_HASH_PATH,
  type MagicAgentTrustedRouteBinding
} from '@shared/magicAgent'

const TRUSTED_ROUTE_ERROR = 'MagicAgent platform route is not trusted for this renderer.'

const bindingsBySenderId = new Map<number, MagicAgentTrustedRouteBinding>()

type RegisterMagicAgentTrustedRouteBindingOptions = {
  hashPath?: string
  trustedUrl?: string
}

const normalizeSenderId = (senderId: unknown): number => {
  if (typeof senderId !== 'number' || !Number.isInteger(senderId) || senderId < 0) {
    throw new Error('MagicAgent trusted route binding requires a valid renderer sender id.')
  }
  return senderId
}

const routeSessionKey = (route: AgentRouteLike): string =>
  getAgentSessionKey(normalizeAgentRoute(route))

const normalizeHashPath = (value?: string | null): string => {
  const raw = String(value || '').trim()
  if (!raw) {
    return MAGIC_AGENT_TRUSTED_ROUTE_HASH_PATH
  }
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw
  const pathOnly = withoutHash.split(/[?#]/)[0] || MAGIC_AGENT_TRUSTED_ROUTE_HASH_PATH
  const withSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash
}

const normalizeTrustedUrl = (value?: string | null): string => {
  const raw = String(value || '').trim()
  if (!raw) {
    throw new Error('MagicAgent trusted route binding requires an exact trusted renderer URL.')
  }
  try {
    const parsed = new URL(raw)
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (parsed.protocol === 'file:') {
      return `${parsed.protocol}//${pathname || '/'}`
    }
    return `${parsed.origin}${pathname && pathname !== '/' ? pathname : ''}`
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

const readHashPathFromUrl = (value?: string): string | undefined => {
  const raw = String(value || '').trim()
  if (!raw) {
    return undefined
  }

  if (raw.startsWith('#')) {
    return normalizeHashPath(raw)
  }

  try {
    const parsed = new URL(raw)
    return parsed.hash ? normalizeHashPath(parsed.hash) : undefined
  } catch {
    const hashIndex = raw.indexOf('#')
    return hashIndex >= 0 ? normalizeHashPath(raw.slice(hashIndex)) : undefined
  }
}

const isTrustedHashPath = (candidate: string | undefined, trustedHashPath: string): boolean => {
  if (!candidate) {
    return false
  }
  return candidate === trustedHashPath || candidate.startsWith(`${trustedHashPath}/`)
}

const hasTrustedUrl = (value: string | undefined, trustedUrl: string): boolean => {
  const raw = String(value || '').trim()
  if (!raw) {
    return false
  }
  return normalizeTrustedUrl(raw) === trustedUrl
}

const assertTrustedInvocationFrame = (
  binding: MagicAgentTrustedRouteBinding,
  invocation: ServiceInvocationContext
): void => {
  if (invocation.isMainFrame !== true) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  if (!hasTrustedUrl(invocation.frameUrl, binding.trustedUrl)) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  if (invocation.senderUrl && !hasTrustedUrl(invocation.senderUrl, binding.trustedUrl)) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  const frameHashPath = readHashPathFromUrl(invocation.frameUrl)
  if (!isTrustedHashPath(frameHashPath, binding.hashPath)) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  const senderHashPath = readHashPathFromUrl(invocation.senderUrl)
  if (senderHashPath && !isTrustedHashPath(senderHashPath, binding.hashPath)) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }
}

export const registerMagicAgentTrustedRouteBinding = (
  senderId: number,
  route: AgentRouteLike = MAGIC_AGENT_TRUSTED_AGENT_STUDIO_ROUTE,
  options: RegisterMagicAgentTrustedRouteBindingOptions = {}
): MagicAgentTrustedRouteBinding => {
  const normalizedSenderId = normalizeSenderId(senderId)
  const binding: MagicAgentTrustedRouteBinding = {
    route: normalizeAgentRoute(route),
    hashPath: normalizeHashPath(options.hashPath),
    trustedUrl: normalizeTrustedUrl(options.trustedUrl),
    createdAt: Date.now()
  }
  bindingsBySenderId.set(normalizedSenderId, binding)
  return binding
}

export const unregisterMagicAgentTrustedRouteBinding = (senderId: number): void => {
  bindingsBySenderId.delete(normalizeSenderId(senderId))
}

export const clearMagicAgentTrustedRouteBindingsForTest = (): void => {
  bindingsBySenderId.clear()
}

export const authorizeMagicAgentTrustedRoute = (
  route: AgentRouteLike,
  invocation?: ServiceInvocationContext
): AgentRouteLike => {
  const requestedRoute = normalizeAgentRoute(route)

  // Unit tests and main-process callers may call service implementations directly.
  // Renderer IPC calls always provide an invocation context via registerIpcServer
  // and are fail-closed against the sender/frame-bound route below.
  if (!invocation) {
    return requestedRoute
  }

  const senderId = normalizeSenderId(invocation.senderId)
  const binding = bindingsBySenderId.get(senderId)
  if (!binding) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  assertTrustedInvocationFrame(binding, invocation)

  if (routeSessionKey(requestedRoute) !== routeSessionKey(binding.route)) {
    throw new Error(TRUSTED_ROUTE_ERROR)
  }

  return normalizeAgentRoute(binding.route)
}
