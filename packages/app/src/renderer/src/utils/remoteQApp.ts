import type { Config } from '@shared/config/config'
import { QAppMenuItem } from '@shared/api/svcQApp'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import { Workflow } from '@shared/comfy/types'
import { QAppManifest } from '@shared/qApp/packageBundle'
import { buildRemoteLlmServerHeaders } from './llmProfileUtils'

export const REMOTE_QAPP_PREFIX = '~remote/'

export function isRemoteQAppKey(key: string): boolean {
  return key.startsWith(REMOTE_QAPP_PREFIX)
}

export function getRemoteOriginalKey(key: string): string {
  return key.replace(REMOTE_QAPP_PREFIX, '')
}

const buildRemoteQAppErrorMessage = (
  requestKind: 'list' | 'get',
  response: Pick<Response, 'status' | 'statusText'>
): string => {
  const requestLabel = requestKind === 'list' ? 'quick app list request' : 'quick app request'
  const statusLabel = [response.status, response.statusText].filter(Boolean).join(' ').trim()
  if (response.status === 401) {
    return `Remote ${requestLabel} was rejected (401 Unauthorized). Check that the remote LLM proxy access token matches the server configuration.`
  }
  return `Remote ${requestLabel} failed (${statusLabel || response.status}).`
}

function markRemote(items: QAppMenuItem[]): QAppMenuItem[] {
  return items.map((item) => ({
    ...item,
    key: REMOTE_QAPP_PREFIX + item.key,
    isRemote: true,
    children: item.children ? markRemote(item.children) : undefined
  }))
}

export async function fetchRemoteQAppList(
  serverOrigin: string,
  config?: Config
): Promise<QAppMenuItem[]> {
  try {
    const resp = await fetch(`${serverOrigin}/api/qapps/list`, {
      headers: buildRemoteLlmServerHeaders(config),
      signal: AbortSignal.timeout(5000)
    })
    if (!resp.ok) {
      console.warn(`[RemoteQApp] ${buildRemoteQAppErrorMessage('list', resp)}`)
      return []
    }
    const data = (await resp.json()) as { qApps: QAppMenuItem[] }
    return markRemote(data.qApps)
  } catch (error) {
    console.warn('[RemoteQApp] Failed to fetch remote quick app list:', error)
    return []
  }
}

export async function fetchRemoteQAppCfg(
  serverOrigin: string,
  remoteKey: string,
  config?: Config
): Promise<{ cfg: QAppCfg; workflow: Workflow; manifest?: QAppManifest }> {
  const originalKey = getRemoteOriginalKey(remoteKey)
  const resp = await fetch(`${serverOrigin}/api/qapps/get?key=${encodeURIComponent(originalKey)}`, {
    headers: buildRemoteLlmServerHeaders(config),
    signal: AbortSignal.timeout(10000)
  })
  if (!resp.ok) {
    throw new Error(buildRemoteQAppErrorMessage('get', resp))
  }
  return resp.json()
}
