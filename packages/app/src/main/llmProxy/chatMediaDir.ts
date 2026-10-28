/**
 * Chat Media Directory Helper
 *
 * Determines the persistent directory for storing chat media files
 * (images and videos downloaded from chat responses).
 *
 * Priority:
 * 1. Automated test artifact directory
 * 2. App-owned user data: <userData>/.chat_media/
 */

import path from 'path'
import fs from 'fs'
import { app } from 'electron'
import { readTestUiEnv, resolveTestArtifactPath, resolveTestUiPolicy } from '../testUiPolicy'

let cachedBaseMediaDir: string | null = null
const CHAT_MEDIA_ROOT_DIR = '.chat_media'

/**
 * Physical lifecycle namespaces.  These are additive to the legacy scoped
 * chat-media layout; existing callers continue to resolve directly below the
 * `.chat_media` root through `getChatMediaDir`.
 */
export const CHAT_MEDIA_NAMESPACES = ['task', 'model', 'user-output'] as const
export type ChatMediaNamespace = (typeof CHAT_MEDIA_NAMESPACES)[number]

const CHAT_MEDIA_NAMESPACE_SCOPE_PATTERN = /^[a-z0-9_](?:[a-z0-9._-]{0,126}[a-z0-9_])?$/u

export const resetChatMediaDirCacheForTests = (): void => {
  cachedBaseMediaDir = null
}

export const sanitizeChatMediaScope = (value?: string | null): string | undefined => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')

  return normalized || undefined
}

/** Strict namespace IDs used for lifecycle-managed directories. */
export const isSafeChatMediaScope = (value: unknown): value is string =>
  typeof value === 'string' && CHAT_MEDIA_NAMESPACE_SCOPE_PATTERN.test(value)

export const assertSafeChatMediaScope = (value: unknown): string => {
  if (!isSafeChatMediaScope(value)) {
    throw new TypeError('Chat media namespace scope must be a canonical safe identifier')
  }
  return value
}

export const isChatMediaNamespace = (value: unknown): value is ChatMediaNamespace =>
  typeof value === 'string' && (CHAT_MEDIA_NAMESPACES as readonly string[]).includes(value)

function assertChatMediaNamespace(value: unknown): ChatMediaNamespace {
  if (!isChatMediaNamespace(value)) {
    throw new TypeError('Unknown chat media namespace')
  }
  return value
}

/**
 * Create a namespace one component at a time without following a symlink or
 * junction.  `mkdir({ recursive: true })` would otherwise allow a malicious
 * namespace parent to redirect creation outside the app-owned media root.
 */
function ensureCanonicalNamespaceDirectory(baseDir: string, targetDir: string): void {
  const resolvedBase = path.resolve(baseDir)
  const resolvedTarget = path.resolve(targetDir)
  const relativeTarget = path.relative(resolvedBase, resolvedTarget)
  if (
    path.isAbsolute(relativeTarget) ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${path.sep}`)
  ) {
    throw new Error('Chat media namespace escapes its app-owned root')
  }

  const baseStat = fs.lstatSync(resolvedBase)
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error('Chat media root is not a canonical directory')
  }

  let current = resolvedBase
  for (const segment of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    if (!fs.existsSync(current)) {
      fs.mkdirSync(current)
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Chat media namespace is not a canonical directory')
    }
  }
}

function resolveAutomatedChatMediaDir(): string | null {
  const testUiPolicy = resolveTestUiPolicy(readTestUiEnv())
  if (!testUiPolicy.automatedRun) {
    return null
  }

  return resolveTestArtifactPath({
    desktopPath: app.getPath('desktop'),
    tempPath: app.getPath('temp'),
    policy: testUiPolicy,
    segments: ['llm-proxy', 'chat-media']
  })
}

export const resolveBaseChatMediaDir = (): string => {
  if (cachedBaseMediaDir) {
    return cachedBaseMediaDir
  }

  cachedBaseMediaDir = resolveAutomatedChatMediaDir()

  if (!cachedBaseMediaDir) {
    cachedBaseMediaDir = path.join(app.getPath('userData'), CHAT_MEDIA_ROOT_DIR)
  }

  if (!fs.existsSync(cachedBaseMediaDir)) {
    fs.mkdirSync(cachedBaseMediaDir, { recursive: true })
    console.log(`[ChatMedia] Created chat media directory: ${cachedBaseMediaDir}`)
  }

  return cachedBaseMediaDir
}

export const resolveChatMediaDir = (scope?: string): string => {
  const baseDir = resolveBaseChatMediaDir()
  const normalizedScope = sanitizeChatMediaScope(scope)
  return normalizedScope ? path.join(baseDir, normalizedScope) : baseDir
}

/**
 * Resolve a lifecycle namespace directory without creating it.
 *
 * Namespace scopes intentionally require an already-normalized identifier;
 * unlike the legacy `resolveChatMediaDir`, this helper never rewrites user
 * input and therefore cannot silently merge distinct scopes.
 */
export const resolveChatMediaNamespaceDir = (namespace: string, scope?: string): string => {
  const normalizedNamespace = assertChatMediaNamespace(namespace)
  const namespaceRoot = path.join(resolveBaseChatMediaDir(), normalizedNamespace)
  return scope === undefined
    ? namespaceRoot
    : path.join(namespaceRoot, assertSafeChatMediaScope(scope))
}

/**
 * Get the persistent directory for chat media files.
 * Creates the directory if it doesn't exist.
 */
export function getChatMediaDir(scope?: string): string {
  const targetDir = resolveChatMediaDir(scope)

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
    console.log(`[ChatMedia] Created scoped chat media directory: ${targetDir}`)
  }

  return targetDir
}

/** Get and create a lifecycle namespace directory. */
export function getChatMediaNamespaceDir(namespace: string, scope?: string): string {
  const targetDir = resolveChatMediaNamespaceDir(namespace, scope)
  const baseDir = resolveBaseChatMediaDir()
  const existed = fs.existsSync(targetDir)
  ensureCanonicalNamespaceDirectory(baseDir, targetDir)
  if (targetDir !== baseDir && !existed) {
    console.log(`[ChatMedia] Created ${namespace} namespace directory: ${targetDir}`)
  }
  return targetDir
}
