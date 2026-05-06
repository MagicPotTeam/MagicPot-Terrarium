import { Workflow } from '@shared/comfy/types'
import { QAppCfg } from '@shared/qApp/cfgTypes'
import { QAppMenuItem } from '@shared/api/svcQApp'

type WorkflowModule = {
  default: Workflow
}

type QACfgModule = {
  default: QAppCfg
}

const promptSuffix = '.prompt.json'
const cfgSuffix = '.qacfg.json'

/**
 * 默认 QApp 会先按照这个列表中的顺序排序
 * 不再这个列表中的默认 QApp 会排在最后
 */
export const defaultQAppOrder = [
  '一键抠图',
  '图标放大',
  '提示词',
  '文生图Flux',
  '文生图illustrious',
  '智能扩图',
  '线稿上色Flux',
  '线稿上色illustrious',
  '草图细化Flux',
  '草图细化illustrious',
  '风格转绘Flux',
  '风格转绘illustrious'
]

type DefaultQAppLeaf = {
  key: string
  name: string
  workflow: Workflow
  cfg: QAppCfg
}

function loadDefaultQApps(): {
  map: Record<string, { cfg: QAppCfg; workflow: Workflow; name: string }>
  menu: QAppMenuItem[]
} {
  const leafItems: DefaultQAppLeaf[] = []

  const modules = import.meta.glob('./defaultApps/**/*.json', { eager: true })
  // key: path without suffix under defaultApps, may include subfolders, e.g. "icons/Upscale"
  const workflowMap: Record<string, Workflow> = {}
  const cfgMap: Record<string, QAppCfg> = {}

  for (const [key, module] of Object.entries(modules)) {
    const rel = key.replace(/^\.\/defaultApps\//, '')
    if (rel.endsWith(promptSuffix)) {
      const appKey = rel.substring(0, rel.length - promptSuffix.length)
      const workflow = (module as WorkflowModule).default as Workflow
      workflowMap[appKey] = workflow
      continue
    }
    if (rel.endsWith(cfgSuffix)) {
      const appKey = rel.substring(0, rel.length - cfgSuffix.length)
      const cfg = (module as QACfgModule).default as QAppCfg
      cfgMap[appKey] = cfg
      continue
    }
  }

  // 构建目录与应用列表（支持多级目录）
  const dirMap: Record<string, QAppMenuItem> = {}
  const topLevelApps: QAppMenuItem[] = []

  const allKeys = Object.keys(workflowMap)
  for (const fullKey of allKeys) {
    if (!cfgMap[fullKey]) continue

    const lastSlash = fullKey.lastIndexOf('/')
    const inDir = lastSlash !== -1
    const name = inDir ? fullKey.substring(lastSlash + 1) : fullKey

    const prefixedKey = `~/${fullKey}`
    const appLeaf: DefaultQAppLeaf = {
      key: prefixedKey,
      name,
      workflow: workflowMap[fullKey],
      cfg: cfgMap[fullKey]
    }
    leafItems.push(appLeaf)

    const appMenuItem: QAppMenuItem = { key: prefixedKey, name, isBuiltin: true }

    if (!inDir) {
      topLevelApps.push(appMenuItem)
      continue
    }

    // 逐级确保目录节点存在，并将叶子挂到最深层目录
    const dirPath = fullKey.substring(0, lastSlash)
    const parts = dirPath.split('/')
    let cumulative = ''
    for (let i = 0; i < parts.length; i++) {
      cumulative = i === 0 ? parts[0] : `${cumulative}/${parts[i]}`
      if (!dirMap[cumulative]) {
        const dirName = parts[i]
        dirMap[cumulative] = {
          key: `~/${cumulative}`,
          name: dirName,
          isBuiltin: true,
          isDirectory: true,
          children: []
        }
      }
    }
    dirMap[dirPath].children!.push(appMenuItem)
  }

  // 排序函数：defaultQAppOrder 优先，然后按名称字典序
  const orderIndex = new Map(defaultQAppOrder.map((n, i) => [n, i]))
  const sortLevel = (items: QAppMenuItem[]) => {
    const dirs = items.filter((i) => i.isDirectory)
    const apps = items.filter((i) => !i.isDirectory)
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    apps.sort((a, b) => {
      const ai = orderIndex.has(a.name)
        ? (orderIndex.get(a.name) as number)
        : Number.POSITIVE_INFINITY
      const bi = orderIndex.has(b.name)
        ? (orderIndex.get(b.name) as number)
        : Number.POSITIVE_INFINITY
      if (ai !== bi) return ai - bi
      return a.name.localeCompare(b.name)
    })
    items.length = 0
    items.push(...dirs, ...apps)
  }

  const sortTree = (nodes: QAppMenuItem[]) => {
    sortLevel(nodes)
    for (const n of nodes) {
      if (n.isDirectory && n.children && n.children.length) {
        sortTree(n.children)
      }
    }
  }

  // 目录父子连接：将多级目录挂载到父级
  const rootDirs: QAppMenuItem[] = []
  for (const dirKey of Object.keys(dirMap)) {
    const parentSlash = dirKey.lastIndexOf('/')
    if (parentSlash === -1) {
      rootDirs.push(dirMap[dirKey])
    } else {
      const parentKey = dirKey.substring(0, parentSlash)
      if (dirMap[parentKey]) {
        dirMap[parentKey].children!.push(dirMap[dirKey])
      } else {
        // 理论上不会发生；稳妥起见作为根目录处理
        rootDirs.push(dirMap[dirKey])
      }
    }
  }

  // 组装结果：每一级目录在前、应用在后
  const menu: QAppMenuItem[] = [...rootDirs, ...topLevelApps]
  sortTree(menu)

  // 构建键索引对象
  const map: Record<string, { cfg: QAppCfg; workflow: Workflow; name: string }> = {}
  for (const leaf of leafItems) {
    map[leaf.key] = { cfg: leaf.cfg, workflow: leaf.workflow, name: leaf.name }
  }

  return { map, menu }
}

const loaded = loadDefaultQApps()
export const defaultQAppMap = loaded.map
export const defaultQAppMenu = loaded.menu
