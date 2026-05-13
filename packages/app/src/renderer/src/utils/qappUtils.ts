import { QAppMenuItem } from '@shared/api/svcQApp'
import { isComfyFrontendOnlyNodeClassType } from '@shared/comfy/funcs'

export const flattenQAppItems = (items: QAppMenuItem[]): QAppMenuItem[] => {
  const res: QAppMenuItem[] = []
  for (const i of items) {
    if (!i.isDirectory) res.push(i)
    if (i.children) res.push(...flattenQAppItems(i.children))
  }
  return res
}

export const findFirstLeaf = (items: QAppMenuItem[]): string | null => {
  for (const i of items) {
    if (!i.isDirectory) return i.key
    if (i.children) {
      const l = findFirstLeaf(i.children)
      if (l) return l
    }
  }
  return null
}

export const findQAppPath = (
  items: QAppMenuItem[],
  k: string,
  p: string[] = []
): string[] | null => {
  for (const i of items) {
    const np = [...p, i.key]
    if (i.key === k) return np
    if (i.children) {
      const f = findQAppPath(i.children, k, np)
      if (f) return f
    }
  }
  return null
}

export const expandQAppKeys = (items: QAppMenuItem[], keys: Set<string>): Set<string> => {
  items.forEach((i) => {
    if (i.isDirectory) {
      if (i.children?.length) {
        keys.add(i.key)
        expandQAppKeys(i.children, keys)
      }
    }
  })
  return keys
}

export const compareWorkflows = (
  imageWf: Record<string, unknown>,
  templateWf: Record<string, unknown>
): boolean => {
  try {
    const templateKeys = Object.keys(templateWf).filter((k) => !k.startsWith('__'))
    const imageKeys = Object.keys(imageWf).filter((k) => !k.startsWith('__'))

    if (templateKeys.length === 0) return false

    // 统计模版节点中有多少在图片工作流中匹配（相同节点ID + 相同class_type）
    let matched = 0
    let skipped = 0

    for (const key of templateKeys) {
      const templateNode = templateWf[key] as Record<string, unknown> | undefined
      const imageNode = imageWf[key] as Record<string, unknown> | undefined

      if (!templateNode?.class_type) {
        skipped++
        continue
      }

      // 如果是 LoRA 相关节点，不计入匹配（因为这些节点可能被动态增减）
      const classType = String(templateNode.class_type)
      if (
        classType === 'LoraLoader' ||
        classType === 'LoraLoaderModelOnly' ||
        isComfyFrontendOnlyNodeClassType(classType)
      ) {
        skipped++
        continue
      }

      if (imageNode && imageNode.class_type === templateNode.class_type) {
        matched++
      }
    }

    const coreTemplateNodes = templateKeys.length - skipped
    if (coreTemplateNodes === 0) return false

    const matchRate = matched / coreTemplateNodes
    // 同时检查图片工作流中的核心节点数不会比模版多太多（防止误匹配）
    const imageNonLoraKeys = imageKeys.filter((k) => {
      const n = imageWf[k] as Record<string, unknown> | undefined
      const ct = String(n?.class_type || '')
      return (
        ct !== 'LoraLoader' && ct !== 'LoraLoaderModelOnly' && !isComfyFrontendOnlyNodeClassType(ct)
      )
    })
    const sizeDiffRatio = Math.abs(imageNonLoraKeys.length - coreTemplateNodes) / coreTemplateNodes

    console.log(
      `[compareWorkflows] 匹配率: ${(matchRate * 100).toFixed(0)}% (${matched}/${coreTemplateNodes}), 大小差异: ${(sizeDiffRatio * 100).toFixed(0)}%`
    )

    return matchRate >= 0.7 && sizeDiffRatio <= 0.3
  } catch {
    return false
  }
}

export const downloadJsonAsFile = (data: unknown, filename: string): void => {
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
