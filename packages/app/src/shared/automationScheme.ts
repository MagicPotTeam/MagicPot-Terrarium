export const AUTOMATION_SCHEME_DEFINITION_DIR_NAME = 'automationSchemeDefinitions'
export const AUTOMATION_SCHEME_DEFINITION_FILE_SUFFIX = '.automation-scheme.json'
export const LEGACY_AUTOMATION_SCHEME_FILE_SUFFIXES = ['.automation.json', '.check.json'] as const

export type AutomationSchemeFile = {
  id: string
  name: string
  content: string
  language?: string
  mimeType?: string
  sizeBytes?: number
  attachmentUrl?: string
}

export type AutomationScheme = {
  id: string
  name: string
  description: string
  enabled: boolean
  files: AutomationSchemeFile[]
  createdAt: string
  updatedAt: string
}
