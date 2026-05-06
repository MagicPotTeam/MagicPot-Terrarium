import { Config } from '@shared/config/config'
import { DeepPartial } from '@shared/utils/utilTypes'

export type SettingsTab = 'general' | 'environment' | 'llm' | 'plugin' | 'mcp' | 'about'

export interface PanelProps {
  settingsValue: Config
  saveSettings: (v: DeepPartial<Config>) => void
  onSelectTab?: (tab: SettingsTab) => void
}
