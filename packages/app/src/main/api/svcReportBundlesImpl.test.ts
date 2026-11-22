import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import type { ReportBundlesSvc } from '@shared/api/svcReportBundles'
import { toLocalMediaUrl } from '@shared/localMediaUrl'
import {
  clearMagicAgentTrustedRouteBindingsForTest,
  registerMagicAgentTrustedRouteBinding
} from '../magicAgentRuntime/trustedRouteBinding'
import {
  initializeReportBundleRegistry,
  resetReportBundleRegistryForTest
} from '../reportBundles/reportBundleRegistry'
import { ReportBundlesSvcImpl, resolveReportBundleRoots } from './svcReportBundlesImpl'

vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)

const { getConfigMock, getBuildEnvMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getBuildEnvMock: vi.fn()
}))
vi.mock('../config/config', () => ({ getConfig: getConfigMock }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: getBuildEnvMock }))

const senderId = 7
const baseUrl = 'file:///app/index.html'
const pageUrl = `${baseUrl}#/canvas?id=project-1`
const conversation = { conversationId: 'conv-1' }
let tmp = ''
let root = ''

function fixture() {
  const webContents = {
    id: senderId,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => pageUrl)
  }
  const parent = { isDestroyed: vi.fn(() => false), webContents }
  const getMainWindow = vi.fn<() => BrowserWindow | null>(() => parent as unknown as BrowserWindow)
  registerMagicAgentTrustedRouteBinding(senderId, undefined, {
    trustedUrl: baseUrl,
    trustedWebContents: webContents
  })
  const service = new ReportBundlesSvcImpl({ getMainWindow, getBundleRoots: () => [root] })
  const context = (
    method: keyof ReportBundlesSvc,
    overrides: Partial<ServiceInvocationContext> = {}
  ): ServiceInvocationContext => ({
    methodName: `svcReportBundles.${method}`,
    senderId,
    senderUrl: pageUrl,
    frameUrl: pageUrl,
    isMainFrame: true,
    ...overrides
  })
  return { service, context, getMainWindow, webContents }
}

function writeBundle(bundleDir: string): void {
  fs.writeFileSync(path.join(bundleDir, 'report.md'), '# r\n')
  fs.writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      bundleId: path.basename(bundleDir),
      title: 't',
      createdAt: '',
      entries: [{ role: 'primary-report', fileName: 'report.md', relativePath: 'report.md' }]
    })
  )
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-report-bundle-svc-')))
  root = path.join(tmp, 'project')
  fs.mkdirSync(root)
  initializeReportBundleRegistry({ userDataDir: path.join(tmp, 'userData') })
})

afterEach(() => {
  resetReportBundleRegistryForTest()
  clearMagicAgentTrustedRouteBindingsForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ReportBundlesSvcImpl', () => {
  it('lets the main window main frame open, seal and verify a bundle', async () => {
    const f = fixture()
    const bundleDir = path.join(root, '.report_bundles', 'b1')
    const { ticket } = await f.service.beginBundle(
      { bundleDir, conversation },
      f.context('beginBundle')
    )
    writeBundle(bundleDir)
    const sealed = await f.service.register({ ticket }, f.context('register'))
    expect(sealed).toMatchObject({ bundleId: 'b1', imageCount: 0, omittedEntries: 0 })
    const { results } = await f.service.verify(
      {
        conversation,
        items: [
          {
            binding: sealed.binding,
            primaryUrl: toLocalMediaUrl(path.join(bundleDir, 'report.md'))!
          }
        ]
      },
      f.context('verify')
    )
    expect(results).toEqual([
      expect.objectContaining({ binding: sealed.binding, status: 'verified', imageCount: 0 })
    ])
  })

  it.each([
    ['no invocation context', () => undefined],
    ['another method name', (f: ReturnType<typeof fixture>) => f.context('verify')],
    [
      'a subframe',
      (f: ReturnType<typeof fixture>) => f.context('beginBundle', { isMainFrame: false })
    ],
    [
      'an untrusted frame URL',
      (f: ReturnType<typeof fixture>) =>
        f.context('beginBundle', {
          frameUrl: 'https://example.test/',
          senderUrl: 'https://example.test/'
        })
    ],
    [
      'another sender',
      (f: ReturnType<typeof fixture>) => f.context('beginBundle', { senderId: 8 })
    ],
    [
      'a missing sender id',
      (f: ReturnType<typeof fixture>) => f.context('beginBundle', { senderId: undefined })
    ]
  ])('denies beginBundle from %s without touching the disk', async (_label, makeContext) => {
    const f = fixture()
    const bundleDir = path.join(root, '.report_bundles', 'denied')
    await expect(
      f.service.beginBundle({ bundleDir, conversation }, makeContext(f))
    ).rejects.toThrow('Report bundle access denied.')
    expect(fs.existsSync(path.join(root, '.report_bundles'))).toBe(false)
  })

  it('denies when the main window is gone, belongs to another sender or navigated away', async () => {
    const f = fixture()
    const req = { bundleDir: path.join(root, '.report_bundles', 'b2'), conversation }
    f.getMainWindow.mockReturnValueOnce(null)
    await expect(f.service.beginBundle(req, f.context('beginBundle'))).rejects.toThrow(
      'Report bundle access denied.'
    )
    f.getMainWindow.mockReturnValueOnce({
      isDestroyed: () => false,
      webContents: { ...f.webContents, id: 99 }
    } as unknown as BrowserWindow)
    await expect(f.service.beginBundle(req, f.context('beginBundle'))).rejects.toThrow(
      'Report bundle access denied.'
    )
    f.webContents.getURL.mockReturnValueOnce('https://example.test/')
    await expect(f.service.beginBundle(req, f.context('beginBundle'))).rejects.toThrow(
      'Report bundle access denied.'
    )
  })

  it('denies register and verify without an invocation context or from a subframe', async () => {
    const f = fixture()
    const bundleDir = path.join(root, '.report_bundles', 'b3')
    const { ticket } = await f.service.beginBundle(
      { bundleDir, conversation },
      f.context('beginBundle')
    )
    writeBundle(bundleDir)
    await expect(f.service.register({ ticket })).rejects.toThrow('Report bundle access denied.')
    await expect(
      f.service.register({ ticket }, f.context('register', { isMainFrame: false }))
    ).rejects.toThrow('Report bundle access denied.')
    // A denied call does not consume the ticket.
    const sealed = await f.service.register({ ticket }, f.context('register'))
    const verifyReq = {
      conversation,
      items: [
        { binding: sealed.binding, primaryUrl: toLocalMediaUrl(path.join(bundleDir, 'report.md'))! }
      ]
    }
    await expect(f.service.verify(verifyReq)).rejects.toThrow('Report bundle access denied.')
    await expect(
      f.service.verify(verifyReq, f.context('verify', { isMainFrame: false }))
    ).rejects.toThrow('Report bundle access denied.')
    clearMagicAgentTrustedRouteBindingsForTest()
    await expect(f.service.verify(verifyReq, f.context('verify'))).rejects.toThrow(
      'Report bundle access denied.'
    )
  })

  it('purges records only for the main window main frame', async () => {
    const f = fixture()
    const bundleDir = path.join(root, '.report_bundles', 'b4')
    const { ticket } = await f.service.beginBundle(
      { bundleDir, conversation },
      f.context('beginBundle')
    )
    writeBundle(bundleDir)
    const sealed = await f.service.register({ ticket }, f.context('register'))
    const verifyReq = {
      conversation,
      items: [
        { binding: sealed.binding, primaryUrl: toLocalMediaUrl(path.join(bundleDir, 'report.md'))! }
      ]
    }
    const purgeReq = { conversationIds: ['conv-1'] }
    await expect(f.service.purge(purgeReq)).rejects.toThrow('Report bundle access denied.')
    await expect(
      f.service.purge(purgeReq, f.context('purge', { isMainFrame: false }))
    ).rejects.toThrow('Report bundle access denied.')
    await expect(f.service.purge(purgeReq, f.context('verify'))).rejects.toThrow(
      'Report bundle access denied.'
    )
    expect((await f.service.verify(verifyReq, f.context('verify'))).results[0].status).toBe(
      'verified'
    )
    expect(await f.service.purge(purgeReq, f.context('purge'))).toEqual({
      purged: 1,
      complete: true
    })
    expect((await f.service.verify(verifyReq, f.context('verify'))).results[0].status).toBe(
      'refused'
    )
    // The bundle files stay.
    expect(fs.existsSync(path.join(bundleDir, 'report.md'))).toBe(true)
  })

  it('uses only MAIN-owned roots: config download_dir and the build data path', () => {
    getConfigMock.mockReturnValue({ download_dir: ' /projects ' })
    getBuildEnvMock.mockReturnValue({ pathMap: { data: '/data' } })
    expect(resolveReportBundleRoots()).toEqual(['/projects', '/data'])
    getConfigMock.mockImplementation(() => {
      throw new Error('Config not initialized')
    })
    getBuildEnvMock.mockReturnValue({ pathMap: { data: 'relative' } })
    expect(resolveReportBundleRoots()).toEqual([])
  })
})
