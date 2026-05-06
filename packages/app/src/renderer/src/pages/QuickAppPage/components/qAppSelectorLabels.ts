import { QAppMenuItem } from '@shared/api/svcQApp'

type DisplayNameResolver = (value?: string) => string

const normalizeSegments = (key: string): string[] =>
  key
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)

export const getQAppSelectorScope = (
  item: Pick<QAppMenuItem, 'key'>,
  getDisplayName?: DisplayNameResolver
): string => {
  const segments = normalizeSegments(item.key)
  if (segments.length <= 1 || segments[0].startsWith('~')) {
    return ''
  }

  return segments
    .slice(0, -1)
    .map((segment) => getDisplayName?.(segment) || segment)
    .join(' / ')
}

export const buildQAppSelectorSearchText = (
  item: Pick<QAppMenuItem, 'key' | 'name'>,
  getDisplayName?: DisplayNameResolver
): string => {
  return [
    getDisplayName?.(item.name) || '',
    item.name || '',
    item.key,
    getQAppSelectorScope(item, getDisplayName)
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}
