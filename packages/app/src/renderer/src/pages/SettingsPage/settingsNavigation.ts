import type { SettingsTab } from './PanelProps'

interface SettingsNavigationGroup {
  readonly id: 'general' | 'models' | 'tools' | 'application'
  readonly labelKey: `settings.groups.${SettingsNavigationGroup['id']}`
  readonly defaultLabel: string
  readonly tabs: readonly SettingsTab[]
}

export const SETTINGS_GROUPS = [
  {
    id: 'general',
    labelKey: 'settings.groups.general',
    defaultLabel: 'General',
    tabs: ['general']
  },
  {
    id: 'models',
    labelKey: 'settings.groups.models',
    defaultLabel: 'Models & runtime',
    tabs: ['llm', 'environment']
  },
  {
    id: 'tools',
    labelKey: 'settings.groups.tools',
    defaultLabel: 'Tools & connections',
    tabs: ['plugin', 'mcp']
  },
  {
    id: 'application',
    labelKey: 'settings.groups.application',
    defaultLabel: 'Application',
    tabs: ['updates', 'about']
  }
] as const satisfies readonly SettingsNavigationGroup[]

export const SETTINGS_TABS: readonly SettingsTab[] = SETTINGS_GROUPS.flatMap<SettingsTab>(
  (group) => [...group.tabs]
)

const isSettingsTab = (value: unknown): value is SettingsTab =>
  typeof value === 'string' && SETTINGS_TABS.includes(value as SettingsTab)

export function getSettingsTab(location: {
  readonly state?: unknown
  readonly search?: string
}): SettingsTab {
  const state = location.state
  const stateTab = state && typeof state === 'object' && 'tab' in state ? state.tab : undefined
  // Keep legacy state links authoritative until an explicit tab selection clears state.tab.
  if (isSettingsTab(stateTab)) return stateTab

  const queryTab = new URLSearchParams(location.search).get('tab')
  return isSettingsTab(queryTab) ? queryTab : 'general'
}
