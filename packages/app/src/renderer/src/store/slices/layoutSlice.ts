import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import {
  normalizeProjectCanvasRoutePath,
  toProjectCanvasRoutePath
} from '../../pages/ProjectCanvasPage/projectCanvasRouting'

// Activity Bar 左侧面板 ID
export type SidePanelId = 'explorer' | 'quickapp' | null

export interface TabItem {
  id: string
  label: string
  routePath: string // 对应 routes.ts 中的 path
  closable: boolean
}

const SYSTEM_TAB_ROUTE_PATHS: Record<string, string> = {
  'tab-home': '/',
  'tab-settings': '/settings',
  'tab-design': '/qappdesign',
  'tab-model': '/model'
}

const REMOVED_SYSTEM_TAB_IDS = new Set<string>()
const REMOVED_SYSTEM_ROUTE_PATHS = new Set(['/automatic', '/workspace'])

export function resolveTabRoutePath(
  tab: Pick<TabItem, 'id'> & Partial<Pick<TabItem, 'routePath'>>
): string {
  const normalizedRoutePath =
    typeof tab.routePath === 'string' ? normalizeProjectCanvasRoutePath(tab.routePath.trim()) : ''
  if (normalizedRoutePath) {
    return normalizedRoutePath
  }

  if (tab.id.startsWith('tab-project-')) {
    return toProjectCanvasRoutePath(tab.id)
  }

  return SYSTEM_TAB_ROUTE_PATHS[tab.id] ?? ''
}

function normalizeSavedTabs(rawTabs: unknown): TabItem[] {
  if (!Array.isArray(rawTabs)) {
    return []
  }

  return rawTabs.flatMap((rawTab) => {
    if (!rawTab || typeof rawTab !== 'object') {
      return []
    }

    const candidate = rawTab as Partial<TabItem>
    if (typeof candidate.id !== 'string' || typeof candidate.label !== 'string') {
      return []
    }

    if (
      REMOVED_SYSTEM_TAB_IDS.has(candidate.id) ||
      REMOVED_SYSTEM_ROUTE_PATHS.has(
        resolveTabRoutePath({
          id: candidate.id,
          routePath: candidate.routePath
        })
      )
    ) {
      return []
    }

    return [
      {
        id: candidate.id,
        label: candidate.label,
        routePath: resolveTabRoutePath({
          id: candidate.id,
          routePath: candidate.routePath
        }),
        closable: candidate.closable ?? true
      }
    ]
  })
}

const isRestorableTabId = (tabId: string, openTabs: TabItem[]): boolean =>
  Boolean(SYSTEM_TAB_ROUTE_PATHS[tabId]) || openTabs.some((tab) => tab.id === tabId)

export interface LayoutState {
  // Side Panel（左侧）
  activeSidePanel: SidePanelId
  sidePanelWidth: number
  projectEntrySidePanelIntent: SidePanelId

  // Right Panel（右侧 AI 对话）
  rightPanelVisible: boolean

  // Bottom Panel
  bottomPanelVisible: boolean
  bottomPanelActiveTab: 'terminal' | 'comfyui' | 'elements'
  bottomPanelMaximized: boolean

  // Main Area Tabs
  openTabs: TabItem[]
  activeTabId: string

  lastActiveProjectId?: string | null

  // 当前路由路径（用于恢复上次页面）
  lastRoutePath: string
}

const LAYOUT_STORAGE_KEY = 'layout.state'
const APP_LAUNCH_MARKER_KEY = 'app.hasLaunched'

// 从 localStorage 恢复状态
function loadState(): Partial<LayoutState> {
  try {
    const saved = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<LayoutState> & { openTabs?: unknown }
      return {
        ...parsed,
        openTabs: normalizeSavedTabs(parsed.openTabs)
      }
    }
  } catch {
    // 忽略
  }
  return {}
}

function detectFirstLaunch(): boolean {
  try {
    const hasLaunched = localStorage.getItem(APP_LAUNCH_MARKER_KEY) === '1'
    if (!hasLaunched) {
      localStorage.setItem(APP_LAUNCH_MARKER_KEY, '1')
      return true
    }
  } catch {
    // 忽略
  }
  return false
}

const savedState = loadState()
const isFirstLaunch = detectFirstLaunch()

const defaultTab: TabItem = {
  id: 'tab-home',
  label: '首页',
  routePath: '/',
  closable: true
}

const initialState: LayoutState = {
  activeSidePanel: (() => {
    const savedSidePanel = savedState.activeSidePanel as string | undefined
    if (savedSidePanel === 'hunyuan3d') return 'quickapp'
    if (savedSidePanel === 'explorer' || savedSidePanel === 'quickapp') return savedSidePanel
    return 'quickapp'
  })(),
  sidePanelWidth: savedState.sidePanelWidth ?? 460,
  projectEntrySidePanelIntent: null,

  rightPanelVisible: savedState.rightPanelVisible ?? true,

  bottomPanelVisible: isFirstLaunch ? false : (savedState.bottomPanelVisible ?? false),
  bottomPanelActiveTab: savedState.bottomPanelActiveTab ?? 'terminal',
  bottomPanelMaximized: false, // 不恢复最大化状态

  openTabs: savedState.openTabs ?? [],
  activeTabId:
    typeof savedState.activeTabId === 'string' &&
    isRestorableTabId(savedState.activeTabId, savedState.openTabs ?? [])
      ? savedState.activeTabId
      : '',

  lastActiveProjectId: savedState.lastActiveProjectId ?? null,

  lastRoutePath:
    typeof savedState.lastRoutePath === 'string' &&
    REMOVED_SYSTEM_ROUTE_PATHS.has(savedState.lastRoutePath.trim())
      ? '/'
      : normalizeProjectCanvasRoutePath(savedState.lastRoutePath ?? '/')
}

// 保存状态到 localStorage
function saveState(state: LayoutState): void {
  try {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        activeSidePanel: state.activeSidePanel,
        sidePanelWidth: state.sidePanelWidth,
        rightPanelVisible: state.rightPanelVisible,
        bottomPanelVisible: state.bottomPanelVisible,
        bottomPanelActiveTab: state.bottomPanelActiveTab,
        openTabs: state.openTabs,
        activeTabId: state.activeTabId,
        lastActiveProjectId: state.lastActiveProjectId,
        lastRoutePath: state.lastRoutePath
      })
    )
  } catch {
    // 忽略
  }
}

const layoutSlice = createSlice({
  name: 'layout',
  initialState,
  reducers: {
    // ─── Side Panel ───
    toggleSidePanel(state, action: PayloadAction<SidePanelId>) {
      if (state.activeSidePanel === action.payload) {
        state.activeSidePanel = null // 再次点击 → 收起
      } else {
        state.activeSidePanel = action.payload
      }
    },
    closeSidePanel(state) {
      state.activeSidePanel = null
    },
    openSidePanel(state, action: PayloadAction<SidePanelId>) {
      state.activeSidePanel = action.payload
    },
    openSidePanelOnProjectEntry(state, action: PayloadAction<Exclude<SidePanelId, null>>) {
      state.activeSidePanel = action.payload
      state.projectEntrySidePanelIntent = action.payload
    },
    clearProjectEntrySidePanelIntent(state) {
      state.projectEntrySidePanelIntent = null
    },

    // ─── Right Panel（AI 对话）───
    toggleRightPanel(state) {
      state.rightPanelVisible = !state.rightPanelVisible
    },
    openRightPanel(state) {
      state.rightPanelVisible = true
    },
    closeRightPanel(state) {
      state.rightPanelVisible = false
    },

    // ─── Bottom Panel ───
    toggleBottomPanel(state) {
      state.bottomPanelVisible = !state.bottomPanelVisible
      if (!state.bottomPanelVisible) state.bottomPanelMaximized = false
    },
    toggleBottomPanelMaximized(state) {
      if (!state.bottomPanelVisible) state.bottomPanelVisible = true
      state.bottomPanelMaximized = !state.bottomPanelMaximized
    },
    setBottomPanelTab(state, action: PayloadAction<'terminal' | 'comfyui' | 'elements'>) {
      state.bottomPanelActiveTab = action.payload
      state.bottomPanelVisible = true
    },

    // ─── Tabs ───
    updateTabLabel(state, action: PayloadAction<{ id: string; label: string }>) {
      const tab = state.openTabs.find((t) => t.id === action.payload.id)
      if (tab) {
        tab.label = action.payload.label
      }
    },
    openTab(state, action: PayloadAction<TabItem>) {
      const existing = state.openTabs.find((t) => t.id === action.payload.id)
      if (!existing) {
        state.openTabs.push(action.payload)
      }
      state.activeTabId = action.payload.id
      if (action.payload.id.startsWith('tab-project-')) {
        state.lastActiveProjectId = action.payload.id
      }
    },
    closeTab(state, action: PayloadAction<string>) {
      const idx = state.openTabs.findIndex((t) => t.id === action.payload)
      if (idx === -1) return

      state.openTabs.splice(idx, 1)

      if (state.lastActiveProjectId === action.payload) {
        const remainingProjects = state.openTabs.filter((t) => t.id.startsWith('tab-project-'))
        state.lastActiveProjectId =
          remainingProjects.length > 0 ? remainingProjects[remainingProjects.length - 1].id : null
      }

      // 如果关闭了最后一个标签，清空状态
      if (state.openTabs.length === 0) {
        state.activeTabId = ''
        return
      }

      // 如果关闭的是当前激活标签，切换到前一个
      if (state.activeTabId === action.payload) {
        const newIdx = Math.min(idx, state.openTabs.length - 1)
        state.activeTabId = state.openTabs[newIdx]?.id || ''
        if (state.activeTabId.startsWith('tab-project-')) {
          state.lastActiveProjectId = state.activeTabId
        }
      }
    },
    setActiveTab(state, action: PayloadAction<string>) {
      state.activeTabId = action.payload
      if (action.payload.startsWith('tab-project-')) {
        state.lastActiveProjectId = action.payload
      }
    },

    // ─── 路由 ───
    reorderTabs(state, action: PayloadAction<{ fromId: string; toId: string }>) {
      const { fromId, toId } = action.payload
      if (fromId === toId) return

      const fromIndex = state.openTabs.findIndex((tab) => tab.id === fromId)
      const toIndex = state.openTabs.findIndex((tab) => tab.id === toId)
      if (fromIndex === -1 || toIndex === -1) return

      const [moved] = state.openTabs.splice(fromIndex, 1)
      state.openTabs.splice(toIndex, 0, moved)
    },
    setLastRoutePath(state, action: PayloadAction<string>) {
      state.lastRoutePath = action.payload
    }
  }
})

export const {
  toggleSidePanel,
  closeSidePanel,
  openSidePanel,
  openSidePanelOnProjectEntry,
  clearProjectEntrySidePanelIntent,
  toggleRightPanel,
  openRightPanel,
  closeRightPanel,
  toggleBottomPanel,
  toggleBottomPanelMaximized,
  setBottomPanelTab,
  openTab,
  closeTab,
  setActiveTab,
  reorderTabs,
  updateTabLabel,
  setLastRoutePath
} = layoutSlice.actions

export { saveState }

export default layoutSlice
