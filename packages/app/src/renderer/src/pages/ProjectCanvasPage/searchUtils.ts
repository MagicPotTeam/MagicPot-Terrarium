import type { CanvasAnnotationItem, CanvasItem, CanvasItemType } from './types'
import { stripHtmlToText } from '@renderer/utils/htmlText'

export type CanvasSearchFilter = 'all' | 'text' | 'image' | 'video' | 'model3d'

export interface CanvasSearchResult {
  id: string
  type: CanvasItemType
  filterType: CanvasSearchFilter
  title: string
  preview: string
  width: number
  height: number
  zIndex: number
  score: number
}

type SearchDescriptor = {
  filterType: CanvasSearchFilter
  title: string
  preview: string
  searchTerms: string[]
  typeKeywords: string[]
}

const WHITESPACE_RE = /\s+/g

function normalizeSearchValue(value: string): string {
  return value.toLocaleLowerCase().replace(/[_-]+/g, ' ').replace(WHITESPACE_RE, ' ').trim()
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim()
  if (trimmed.length <= maxLength) return trimmed
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

function getSourceName(src: string): string {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return ''

  try {
    const url = new URL(src)
    const pathParts = url.pathname.split('/')
    return decodeURIComponent(pathParts[pathParts.length - 1] || '')
  } catch {
    const normalized = src.replace(/\\/g, '/')
    const pathParts = normalized.split('/')
    return decodeURIComponent(pathParts[pathParts.length - 1] || '')
  }
}

function getTypeKeywords(type: CanvasItemType): string[] {
  switch (type) {
    case 'text':
      return ['text', '文本', '文字']
    case 'annotation':
      return ['annotation', 'annotate', '标注', '注释', '批注']
    case 'image':
      return ['image', 'picture', '图片', '图像']
    case 'video':
      return ['video', 'movie', '视频']
    case 'model3d':
      return ['3d', '3d model', 'model', 'model3d', '3d模型', '模型']
    case 'html':
      return ['html', '网页', 'web']
    default:
      return []
  }
}

export function getCanvasSearchFilterForItem(item: CanvasItem): CanvasSearchFilter {
  switch (item.type) {
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'model3d':
      return 'model3d'
    case 'text':
    case 'annotation':
      return 'text'
    default:
      return 'all'
  }
}

function getAnnotationTitle(item: CanvasAnnotationItem): string {
  if (item.shape === 'text-anno') {
    return item.text?.trim() || item.label?.trim() || ''
  }
  return item.label?.trim() || item.text?.trim() || ''
}

function getSearchDescriptor(item: CanvasItem): SearchDescriptor {
  const filterType = getCanvasSearchFilterForItem(item)
  const typeKeywords = getTypeKeywords(item.type)

  if (item.type === 'text') {
    const text = item.text?.trim() || ''
    return {
      filterType,
      title: text,
      preview: text,
      searchTerms: [text, ...typeKeywords],
      typeKeywords
    }
  }

  if (item.type === 'annotation') {
    const title = getAnnotationTitle(item)
    const preview =
      item.shape === 'text-anno'
        ? [item.label?.trim(), item.text?.trim()].filter(Boolean).join(' · ')
        : [item.label?.trim(), item.text?.trim(), item.shape].filter(Boolean).join(' · ')

    return {
      filterType,
      title,
      preview,
      searchTerms: [title, item.label || '', item.text || '', item.shape, ...typeKeywords],
      typeKeywords
    }
  }

  if (item.type === 'image') {
    const sourceName = getSourceName(item.src)
    const title = item.fileName?.trim() || sourceName
    const preview = [item.fileName?.trim(), sourceName].filter(Boolean).join(' · ')

    return {
      filterType,
      title,
      preview,
      searchTerms: [title, preview, sourceName, item.fileName || '', ...typeKeywords],
      typeKeywords
    }
  }

  if (item.type === 'video') {
    const sourceName = getSourceName(item.src)
    const title = item.fileName?.trim() || sourceName
    const preview = [item.fileName?.trim(), sourceName].filter(Boolean).join(' · ')

    return {
      filterType,
      title,
      preview,
      searchTerms: [title, preview, sourceName, item.fileName || '', ...typeKeywords],
      typeKeywords
    }
  }

  if (item.type === 'model3d') {
    const sourceName = getSourceName(item.src)
    const textureNames = Object.keys(item.textures || {})
    const title = item.fileName?.trim() || sourceName
    const preview = textureNames.length > 0 ? textureNames.join(', ') : sourceName

    return {
      filterType,
      title,
      preview,
      searchTerms: [
        title,
        preview,
        sourceName,
        item.fileName || '',
        ...textureNames,
        ...typeKeywords
      ],
      typeKeywords
    }
  }

  const htmlText = item.type === 'html' ? stripHtmlToText(item.htmlData) : ''
  return {
    filterType,
    title: truncateText(htmlText, 48),
    preview: htmlText,
    searchTerms: [htmlText, ...typeKeywords],
    typeKeywords
  }
}

function matchesFilter(resultFilterType: CanvasSearchFilter, filter: CanvasSearchFilter): boolean {
  return filter === 'all' || resultFilterType === filter
}

function computeSearchScore(
  descriptor: SearchDescriptor,
  normalizedQuery: string,
  tokens: string[],
  zIndex: number
): number {
  if (!normalizedQuery) return zIndex

  const normalizedTitle = normalizeSearchValue(descriptor.title)
  const normalizedPreview = normalizeSearchValue(descriptor.preview)
  const normalizedTerms = descriptor.searchTerms
    .map((term) => normalizeSearchValue(term))
    .filter(Boolean)
  const combined = normalizedTerms.join(' ')

  if (!tokens.every((token) => combined.includes(token))) {
    return Number.NEGATIVE_INFINITY
  }

  let score = zIndex

  if (normalizedTitle === normalizedQuery) score += 500
  if (normalizedTitle.includes(normalizedQuery)) score += 260
  if (normalizedPreview.includes(normalizedQuery)) score += 120
  if (
    descriptor.typeKeywords.some((keyword) =>
      normalizeSearchValue(keyword).includes(normalizedQuery)
    )
  ) {
    score += 80
  }

  const firstMatchIndex = normalizedTerms.findIndex((term) => term.includes(normalizedQuery))
  if (firstMatchIndex >= 0) {
    score += Math.max(0, 60 - firstMatchIndex * 8)
  }

  return score
}

export function searchCanvasItems(
  items: CanvasItem[],
  query: string,
  filter: CanvasSearchFilter = 'all'
): CanvasSearchResult[] {
  const normalizedQuery = normalizeSearchValue(query)
  const tokens = normalizedQuery ? normalizedQuery.split(' ').filter(Boolean) : []

  return items
    .map((item) => {
      const descriptor = getSearchDescriptor(item)
      const score = computeSearchScore(descriptor, normalizedQuery, tokens, item.zIndex)

      return {
        id: item.id,
        type: item.type,
        filterType: descriptor.filterType,
        title: descriptor.title,
        preview: descriptor.preview,
        width: Math.round(Math.abs(item.width * (item.scaleX || 1))),
        height: Math.round(Math.abs(item.height * (item.scaleY || 1))),
        zIndex: item.zIndex,
        score
      } satisfies CanvasSearchResult
    })
    .filter((result) => matchesFilter(result.filterType, filter))
    .filter((result) => result.score !== Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score || b.zIndex - a.zIndex)
}
