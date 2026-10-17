import { createInstance } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { render, screen, waitFor } from '@testing-library/react'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import type { FigPluginManagedSummary } from '@shared/figplugin/management'
import en from '@shared/locales/en-US/renderer.json'
import zh from '@shared/locales/zh-CN/renderer.json'
import WorkshopPluginsPage from './WorkshopPluginsPage'

const mocks = vi.hoisted(() => ({
  listPackages: vi.fn<FigPluginCenterSvc['listPackages']>()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcFigPluginCenter: { listPackages: mocks.listPackages } })
}))
vi.mock('./components/CustomWorkshopTabs', () => ({
  default: () => <nav data-testid="workshop-tabs" />
}))
vi.mock('./PluginBridgePanel', () => ({
  default: () => null
}))

const target: FigPluginManagedSummary = {
  pluginId: 'example.plugin',
  name: 'Example package',
  version: '1.2.3',
  host: 'figma',
  generation: 7,
  capabilities: ['dialogue'],
  manifestSha256: 'd'.repeat(64),
  materialization: 'verified-package',
  signerFingerprint: 'b'.repeat(64),
  artifactSha256: 'c'.repeat(64),
  bridgeOrigin: 'http://127.0.0.1:43123',
  fileCount: 3,
  contentBytes: 1024,
  configured: true,
  ready: false,
  state: 'disabled',
  cleanupPending: false,
  settings: { analysisProfileId: 'chat-id' }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.listPackages.mockResolvedValue({ items: [target], skippedRecords: 0, truncated: false })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('WorkshopPluginsPage bridge localization', () => {
  it.each([
    ['en-US', en],
    ['zh-CN', zh]
  ] as const)(
    'renders the real %s bridge resources without translation mocks',
    async (lng, locale) => {
      const i18n = createInstance()
      await i18n.use(initReactI18next).init({
        lng,
        fallbackLng: false,
        resources: { [lng]: { translation: locale } },
        interpolation: { escapeValue: false }
      })

      render(
        <I18nextProvider i18n={i18n}>
          <WorkshopPluginsPage />
        </I18nextProvider>
      )

      await waitFor(() => expect(mocks.listPackages).toHaveBeenCalledWith({}))
      expect(screen.getByText(locale.figplugin.bridge.hostStatus)).toBeInTheDocument()
      expect(screen.getByText(locale.figplugin.bridge.hostGuidance)).toBeInTheDocument()
      expect(screen.getByText(locale.figplugin.bridge.runtimeStatus)).toBeInTheDocument()
      expect(i18n.t('figplugin.bridge.packageFilesInstalled')).toBe(
        locale.figplugin.bridge.packageFilesInstalled
      )
      expect(i18n.t('figplugin.bridge.profileReferencesSaved')).toBe(
        locale.figplugin.bridge.profileReferencesSaved
      )
    }
  )
})
