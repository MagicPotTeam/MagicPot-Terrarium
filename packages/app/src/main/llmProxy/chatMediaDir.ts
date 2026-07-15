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
