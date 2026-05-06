import type { CanvasItem } from './types'

export function extractPromptTextFromCanvasItems(targetItems: CanvasItem[]): string {
  const textContents: string[] = []

  for (const item of targetItems) {
    if ('text' in item && typeof item.text === 'string' && item.text.trim()) {
      textContents.push(item.text.trim())
      continue
    }

    if ('label' in item && typeof item.label === 'string' && item.label.trim()) {
      textContents.push(item.label.trim())
    }
  }

  return textContents.join('\n')
}
