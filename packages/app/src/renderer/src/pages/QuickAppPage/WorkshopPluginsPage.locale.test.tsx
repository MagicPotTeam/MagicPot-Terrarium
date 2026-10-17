import { createInstance } from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { render, screen, waitFor } from '@testing-library/react'
import type { FigPluginCenterSvc } from '@shared/api/svcFigPluginCenter'
import {
  FIGPLUGIN_MANAGEMENT_ERRORS,
  type FigPluginManagementErrorCode,
  type FigPluginManagedSummary
} from '@shared/figplugin/management'
import type { FigPluginCapability, FigPluginHost } from '@shared/figplugin/manifest'
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

const centerStaticKeys = [
  'title',
  'description',
  'hostDisconnected',
  'hostGuidance',
  'hostFilter',
  'search',
  'refresh',
  'choose',
  'busy',
  'truncated',
  'skipped',
  'noMatches',
  'empty',
  'verifiedPackage',
  'metadataOnly',
  'notReady',
  'configured',
  'unconfigured',
  'cleanupPending',
  'removedPending',
  'retryCleanup',
  'packageName',
  'pluginId',
  'version',
  'hostValue',
  'content',
  'permissions',
  'fingerprint',
  'signatureNotice',
  'noExecution',
  'nativeConfirm',
  'expires',
  'expired',
  'reviewConsent',
  'previewTitle',
  'install',
  'reselect',
  'installComplete',
  'configure',
  'configureTitle',
  'settingsNotice',
  'analysisProfile',
  'backgroundProfile',
  'optionalProfile',
  'noProfile',
  'unavailableProfile',
  'unavailablePreserved',
  'profileOption',
  'profilesFailed',
  'save',
  'saveComplete',
  'cancel',
  'notCompleted',
  'copyPath',
  'reveal',
  'copyComplete',
  'revealComplete',
  'remove',
  'removeTitle',
  'removeNotice',
  'confirmName',
  'confirmVersion',
  'confirmRemove',
  'removeComplete'
] as const
type CenterStaticKey = (typeof centerStaticKeys)[number]
type CenterStaticTranslationKey = `figplugin.center.${CenterStaticKey}`
type CenterHostKey = `figplugin.center.hosts.${'all' | FigPluginHost}`
type CenterCapabilityKey = `figplugin.center.capabilities.${FigPluginCapability}`
type CenterErrorCode = FigPluginManagementErrorCode | 'UNKNOWN'
type CenterErrorKey = `figplugin.center.errors.${CenterErrorCode}`
const managementErrorCodes = [
  ...(Object.keys(FIGPLUGIN_MANAGEMENT_ERRORS) as FigPluginManagementErrorCode[]),
  'UNKNOWN'
] as CenterErrorCode[]

const centerStaticTranslationKey = (key: CenterStaticKey): CenterStaticTranslationKey =>
  `figplugin.center.${key}`
const centerHostTranslationKey = (key: 'all' | FigPluginHost): CenterHostKey =>
  `figplugin.center.hosts.${key}`
const centerCapabilityTranslationKey = (key: FigPluginCapability): CenterCapabilityKey =>
  `figplugin.center.capabilities.${key}`
const centerErrorTranslationKey = (key: CenterErrorCode): CenterErrorKey =>
  `figplugin.center.errors.${key}`

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

describe('WorkshopPluginsPage localization', () => {
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
      expect(
        screen.getByRole('heading', { name: locale.figplugin.center.title })
      ).toBeInTheDocument()
      expect(screen.getByText(locale.figplugin.center.description)).toBeInTheDocument()
      expect(screen.getByText(locale.figplugin.center.hostDisconnected)).toBeInTheDocument()
      for (const key of centerStaticKeys) {
        const expected = locale.figplugin.center[key]
        expect(typeof expected).toBe('string')
        expect(i18n.t(centerStaticTranslationKey(key))).toBe(expected)
      }
      for (const key of ['all', 'figma', 'photoshop'] as const) {
        expect(i18n.t(centerHostTranslationKey(key))).toBe(locale.figplugin.center.hosts[key])
      }
      for (const key of [
        'dialogue',
        'background-removal',
        'asset-transfer',
        'result-transfer'
      ] as const) {
        expect(i18n.t(centerCapabilityTranslationKey(key))).toBe(
          locale.figplugin.center.capabilities[key]
        )
      }
      for (const code of managementErrorCodes) {
        expect(i18n.t(centerErrorTranslationKey(code))).toBe(locale.figplugin.center.errors[code])
      }
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
