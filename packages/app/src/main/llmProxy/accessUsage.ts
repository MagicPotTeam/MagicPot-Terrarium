import fs from 'fs'
import path from 'path'
import type { LLMProxyAccessTokenEntry } from '@shared/config/config'
import type { LlmProxyAccessUsageSnapshot } from '@shared/api/svcState'
import { getConfig } from '../config/config'
import { resolveChatMediaDir, sanitizeChatMediaScope } from './chatMediaDir'

type ProxyAccessUsageIdentity = {
  tokenId: string
  label?: string
  resourceScope?: string
}

type ProxyAccessUsageActivity =
  | 'status'
  | 'profiles'
  | 'chat'
  | 'tool-call'
  | 'openai'
  | 'qapp-list'
  | 'qapp-get'
  | 'media-download'
  | 'media-generated'

type ProxyAccessUsageUpdate = {
  activity: ProxyAccessUsageActivity
  requesterAddress?: string
  profileId?: string
  generatedMediaBytes?: number
}

type ProxyAccessUsageMutable = Omit<
  LlmProxyAccessUsageSnapshot,
  'storedMediaCount' | 'storedMediaBytes'
>

const usageByTokenId = new Map<string, ProxyAccessUsageMutable>()

const cleanString = (value?: string | null): string | undefined => {
  const normalized = String(value || '').trim()
  return normalized || undefined
}

const normalizeConfiguredAccessToken = (
  entry: Partial<LLMProxyAccessTokenEntry> | undefined,
  fallbackId: string,
  fallbackLabel: string
): ProxyAccessUsageIdentity | null => {
  const token = cleanString(entry?.token)
  if (!token) {
    return null
  }

  return {
    tokenId: cleanString(entry?.id) || fallbackId,
    label: cleanString(entry?.label) || fallbackLabel,
    resourceScope:
      sanitizeChatMediaScope(entry?.resource_scope) ||
      sanitizeChatMediaScope(entry?.id) ||
      sanitizeChatMediaScope(entry?.label)
  }
}

export const getConfiguredProxyAccessIdentities = (): ProxyAccessUsageIdentity[] => {
  const serverConfig = getConfig().local_llm_server_config
  const configuredEntries = Array.isArray(serverConfig?.access_tokens)
    ? serverConfig.access_tokens
        .map((entry, index) =>
          normalizeConfiguredAccessToken(entry, `proxy-token-${index + 1}`, `User ${index + 1}`)
        )
        .filter((entry): entry is ProxyAccessUsageIdentity => Boolean(entry))
    : []

  if (configuredEntries.length > 0) {
    return configuredEntries
  }

  const legacyToken = cleanString(serverConfig?.access_token)
  return legacyToken
    ? [
        {
          tokenId: 'default',
          label: 'Default',
          resourceScope: 'default'
        }
      ]
    : []
}

const getOrCreateUsageRecord = (identity: ProxyAccessUsageIdentity): ProxyAccessUsageMutable => {
  const existing = usageByTokenId.get(identity.tokenId)
  if (existing) {
    if (identity.label) {
      existing.label = identity.label
    }
    if (identity.resourceScope) {
      existing.resourceScope = identity.resourceScope
    }
    return existing
  }

  const created: ProxyAccessUsageMutable = {
    tokenId: identity.tokenId,
    label: identity.label,
    resourceScope: identity.resourceScope,
    requestCount: 0,
    statusRequestCount: 0,
    profileListRequestCount: 0,
    chatRequestCount: 0,
    openAiRequestCount: 0,
    quickAppListRequestCount: 0,
    quickAppGetRequestCount: 0,
    mediaDownloadCount: 0,
    generatedMediaCount: 0,
    generatedMediaBytes: 0
  }
  usageByTokenId.set(identity.tokenId, created)
  return created
}

export const recordLlmProxyAccessUsage = (
  identity: ProxyAccessUsageIdentity | undefined,
  update: ProxyAccessUsageUpdate
): void => {
  if (!identity?.tokenId || identity.tokenId === 'anonymous') {
    return
  }

  const record = getOrCreateUsageRecord(identity)
  record.requestCount += 1
  record.lastSeenAt = Date.now()
  record.lastActivity = update.activity
  if (cleanString(update.requesterAddress)) {
    record.lastRequesterAddress = cleanString(update.requesterAddress)
  }
  if (cleanString(update.profileId)) {
    record.lastProfileId = cleanString(update.profileId)
  }

  switch (update.activity) {
    case 'status':
      record.statusRequestCount += 1
      break
    case 'profiles':
      record.profileListRequestCount += 1
      break
    case 'chat':
      record.chatRequestCount += 1
      break
    case 'tool-call':
      record.chatRequestCount += 1
      break
    case 'openai':
      record.openAiRequestCount += 1
      break
    case 'qapp-list':
      record.quickAppListRequestCount += 1
      break
    case 'qapp-get':
      record.quickAppGetRequestCount += 1
      break
    case 'media-download':
      record.mediaDownloadCount += 1
      break
    case 'media-generated':
      record.generatedMediaCount += 1
      record.generatedMediaBytes += Math.max(0, update.generatedMediaBytes || 0)
      break
  }
}

const getStoredMediaStats = (
  resourceScope?: string
): {
  storedMediaCount: number
  storedMediaBytes: number
} => {
  const targetDir = resolveChatMediaDir(resourceScope)
  if (!fs.existsSync(targetDir)) {
    return {
      storedMediaCount: 0,
      storedMediaBytes: 0
    }
  }

  let storedMediaCount = 0
  let storedMediaBytes = 0
  for (const entry of fs.readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue
    }
    storedMediaCount += 1
    try {
      storedMediaBytes += fs.statSync(path.join(targetDir, entry.name)).size
    } catch {
      // Ignore transient stat errors while building usage stats.
    }
  }

  return {
    storedMediaCount,
    storedMediaBytes
  }
}

export const getLlmProxyAccessUsageSnapshot = (): LlmProxyAccessUsageSnapshot[] => {
  const configuredIdentities = getConfiguredProxyAccessIdentities()
  const seenTokenIds = new Set<string>()
  const snapshots: LlmProxyAccessUsageSnapshot[] = []

  const pushSnapshot = (record: ProxyAccessUsageMutable) => {
    if (seenTokenIds.has(record.tokenId)) {
      return
    }
    seenTokenIds.add(record.tokenId)
    snapshots.push({
      ...record,
      ...getStoredMediaStats(record.resourceScope)
    })
  }

  for (const identity of configuredIdentities) {
    pushSnapshot(getOrCreateUsageRecord(identity))
  }

  for (const record of usageByTokenId.values()) {
    pushSnapshot(record)
  }

  return snapshots.sort((left, right) => {
    const leftSeen = left.lastSeenAt || 0
    const rightSeen = right.lastSeenAt || 0
    if (leftSeen !== rightSeen) {
      return rightSeen - leftSeen
    }
    return left.tokenId.localeCompare(right.tokenId)
  })
}

export const resetLlmProxyAccessUsageForTests = (): void => {
  usageByTokenId.clear()
}
