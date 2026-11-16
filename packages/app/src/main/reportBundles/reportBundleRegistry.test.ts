import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toLocalMediaUrl } from '@shared/localMediaUrl'
import { REPORT_BUNDLE_BINDING_PATTERN } from '@shared/reportBundle'
import {
  REPORT_BUNDLE_TICKET_TTL_MS,
  ReportBundleRefusedError,
  beginReportBundle,
  flushReportBundleRegistry,
  initializeReportBundleRegistry,
  isBoundTo,
  registerReportBundle,
  resetReportBundleRegistryForTest,
  verifyReportBundles
} from './reportBundleRegistry'

// The node suite replaces node:fs with memfs; this registry needs real links, ctime and nlink.
vi.mock('node:fs', async () => vi.importActual<typeof import('node:fs')>('node:fs'))
vi.mock('node:fs/promises', async () =>
  vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
)

const conversation = { conversationId: 'conv-1', storageScope: 'project.pane' }
let tmp = ''
let root = ''
let userData = ''
let clockOffset = 0
const now = () => Date.now() + clockOffset

type ManifestEntry = Record<string, unknown>
type BundleOptions = {
  entries?: (defaults: ManifestEntry[]) => ManifestEntry[]
  manifest?: (defaults: Record<string, unknown>) => unknown
  rawManifest?: string
}

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex')
const bundleDirFor = (name: string) => path.join(root, '.report_bundles', name)
const primaryUrlFor = (bundleDir: string) => toLocalMediaUrl(path.join(bundleDir, 'report.md'))!

function writeBundleFiles(bundleDir: string, name: string, options: BundleOptions = {}): void {
  fs.mkdirSync(path.join(bundleDir, 'images'), { recursive: true })
  fs.writeFileSync(path.join(bundleDir, 'report.md'), '# Report\nbody\n')
  fs.writeFileSync(path.join(bundleDir, 'images', 'fig-01.png'), Buffer.from('PNG-one'))
  fs.writeFileSync(path.join(bundleDir, 'images', 'fig-02.png'), Buffer.from('PNG-two'))
  fs.writeFileSync(path.join(bundleDir, 'ocr.json'), '{"text":"t"}')
  const entries: ManifestEntry[] = [
    {
      role: 'primary-report',
      fileName: 'report.md',
      mimeType: 'text/markdown',
      refName: 'report.md',
      relativePath: 'report.md',
      sizeBytes: 15,
      imageCount: 2
    },
    {
      role: 'report-image',
      fileName: 'fig-01.png',
      mimeType: 'image/png',
      refName: 'fig-01.png',
      relativePath: 'images/fig-01.png'
    },
    {
      role: 'report-image',
      fileName: 'fig-02.png',
      mimeType: 'image/png',
      refName: 'fig-02.png',
      relativePath: 'images/fig-02.png'
    },
    { role: 'report-ocr', fileName: 'ocr.json', relativePath: 'ocr.json' }
  ]
  const manifest = {
    version: 1,
    bundleId: name,
    title: 'Stage',
    createdAt: new Date().toISOString(),
    primaryRefName: 'report.md',
    entries: options.entries ? options.entries(entries) : entries
  }
  fs.writeFileSync(
    path.join(bundleDir, 'manifest.json'),
    options.rawManifest ??
      JSON.stringify(options.manifest ? options.manifest(manifest) : manifest, null, 2)
  )
}

async function seal(
  name = 'canvas-target-s1',
  options: BundleOptions & { conversation?: typeof conversation | { conversationId: string } } = {}
) {
  const bundleDir = bundleDirFor(name)
  const { ticket } = await beginReportBundle(
    { bundleDir, conversation: options.conversation ?? conversation },
    [root]
  )
  writeBundleFiles(bundleDir, name, options)
  const resp = await registerReportBundle({ ticket })
  return { bundleDir, resp, primaryUrl: primaryUrlFor(bundleDir) }
}

async function expectRegisterRefused(name: string, options: BundleOptions): Promise<void> {
  await expect(seal(name, options)).rejects.toBeInstanceOf(ReportBundleRefusedError)
}

async function verifyOne(binding: string, primaryUrl: string, conv = conversation) {
  const { results } = await verifyReportBundles({
    conversation: conv,
    items: [{ binding, primaryUrl }]
  })
  return results[0]
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-report-bundles-')))
  root = path.join(tmp, 'project')
  userData = path.join(tmp, 'userData')
  fs.mkdirSync(root, { recursive: true })
  clockOffset = 0
  initializeReportBundleRegistry({ userDataDir: userData, now })
})

afterEach(() => {
  resetReportBundleRegistryForTest()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('report bundle registration', () => {
  it('seals a freshly written bundle and returns a binding', async () => {
    const { resp } = await seal()
    expect(resp.binding).toMatch(REPORT_BUNDLE_BINDING_PATTERN)
    expect(resp).toEqual({
      binding: resp.binding,
      bundleId: 'canvas-target-s1',
      imageCount: 2,
      omittedEntries: 0
    })
    const registryPath = path.join(userData, 'report-bundles', 'registry.json')
    const registryText = fs.readFileSync(registryPath, 'utf8')
    expect(registryText).not.toContain(resp.binding)
    expect(registryText).toContain(sha256(resp.binding))
    if (process.platform !== 'win32') expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600)
  })

  it('creates the bundle directory for a write session that has not written yet', async () => {
    const bundleDir = bundleDirFor('fresh-dir')
    await beginReportBundle({ bundleDir, conversation }, [root])
    expect(fs.statSync(bundleDir).isDirectory()).toBe(true)
  })

  it('refuses a missing, unknown, used or expired ticket', async () => {
    await expect(registerReportBundle({} as never)).rejects.toBeInstanceOf(ReportBundleRefusedError)
    await expect(registerReportBundle({ ticket: `rbt1.${'a'.repeat(43)}` })).rejects.toBeInstanceOf(
      ReportBundleRefusedError
    )

    const bundleDir = bundleDirFor('used')
    const { ticket } = await beginReportBundle({ bundleDir, conversation }, [root])
    writeBundleFiles(bundleDir, 'used')
    await expect(registerReportBundle({ ticket })).resolves.toMatchObject({ bundleId: 'used' })
    await expect(registerReportBundle({ ticket })).rejects.toBeInstanceOf(ReportBundleRefusedError)

    const expiredDir = bundleDirFor('expired')
    const expired = await beginReportBundle({ bundleDir: expiredDir, conversation }, [root])
    writeBundleFiles(expiredDir, 'expired')
    clockOffset += REPORT_BUNDLE_TICKET_TTL_MS + 1
    await expect(registerReportBundle(expired)).rejects.toBeInstanceOf(ReportBundleRefusedError)
  })

  it('refuses directories outside <root>/.report_bundles and roots it does not own', async () => {
    const other = path.join(tmp, 'other')
    for (const bundleDir of [
      path.join(other, '.report_bundles', 'b'),
      path.join(root, '.report_bundles', 'a', 'b'),
      path.join(root, 'b'),
      path.join(root, '.report_bundles'),
      path.join(root, '.report_bundles', '..', 'b'),
      'relative/.report_bundles/b'
    ]) {
      await expect(beginReportBundle({ bundleDir, conversation }, [root])).rejects.toBeInstanceOf(
        ReportBundleRefusedError
      )
    }
    await expect(
      beginReportBundle({ bundleDir: path.join(root, '.report_bundles', 'b'), conversation }, [])
    ).rejects.toBeInstanceOf(ReportBundleRefusedError)
    expect(fs.existsSync(path.join(other, '.report_bundles'))).toBe(false)
  })

  it('refuses a linked bundle directory, at begin and when swapped before register', async () => {
    const target = path.join(tmp, 'target')
    fs.mkdirSync(target)
    fs.mkdirSync(path.join(root, '.report_bundles'), { recursive: true })
    fs.symlinkSync(target, bundleDirFor('linked'), 'dir')
    await expect(
      beginReportBundle({ bundleDir: bundleDirFor('linked'), conversation }, [root])
    ).rejects.toBeInstanceOf(ReportBundleRefusedError)

    const swapped = bundleDirFor('swapped')
    const { ticket } = await beginReportBundle({ bundleDir: swapped, conversation }, [root])
    writeBundleFiles(target, 'swapped')
    fs.rmSync(swapped, { recursive: true })
    fs.symlinkSync(target, swapped, 'dir')
    await expect(registerReportBundle({ ticket })).rejects.toBeInstanceOf(ReportBundleRefusedError)
  })

  it('never re-signs a legacy bundle whose files predate the ticket', async () => {
    const legacy = bundleDirFor('legacy')
    writeBundleFiles(legacy, 'legacy')
    clockOffset += 60_000
    const { ticket } = await beginReportBundle({ bundleDir: legacy, conversation }, [root])
    await expect(registerReportBundle({ ticket })).rejects.toBeInstanceOf(ReportBundleRefusedError)

    // A fresh manifest does not launder the old children.
    const second = await beginReportBundle({ bundleDir: legacy, conversation }, [root])
    const manifestPath = path.join(legacy, 'manifest.json')
    fs.writeFileSync(manifestPath, fs.readFileSync(manifestPath))
    await expect(registerReportBundle(second)).rejects.toBeInstanceOf(ReportBundleRefusedError)
  })

  it('refuses a manifest over 256 KiB, invalid JSON, a wrong version or another bundleId', async () => {
    await expectRegisterRefused('big', {
      manifest: (m) => ({ ...m, title: 'x'.repeat(300 * 1024) })
    })
    await expectRegisterRefused('json', { rawManifest: '{"version":1,' })
    await expectRegisterRefused('version', { manifest: (m) => ({ ...m, version: 2 }) })
    await expectRegisterRefused('other-id', { manifest: (m) => ({ ...m, bundleId: 'else' }) })
    await expectRegisterRefused('too-many', {
      entries: (e) => [
        e[0],
        ...Array.from({ length: 200 }, () => ({ ...e[1], relativePath: undefined, sourceUrl: 'x' }))
      ]
    })
    await expectRegisterRefused('bad-role', {
      entries: (e) => [...e, { role: 'script', fileName: 'x' }]
    })
    await expectRegisterRefused('bad-size', {
      entries: (e) => [e[0], { ...e[1], sizeBytes: '7' }]
    })
  })

  it('refuses traversal, absolute paths, linked and hard-linked children and two primaries', async () => {
    fs.writeFileSync(path.join(tmp, 'outside.md'), 'outside')
    await expectRegisterRefused('dotdot', {
      entries: (e) => [{ ...e[0], relativePath: '../outside.md' }, ...e.slice(1)]
    })
    await expectRegisterRefused('dotdot-inner', {
      entries: (e) => [e[0], { ...e[1], relativePath: 'images/../../x.png' }]
    })
    await expectRegisterRefused('absolute', {
      entries: (e) => [e[0], { ...e[1], relativePath: path.join(tmp, 'outside.md') }]
    })
    await expectRegisterRefused('two-primaries', {
      entries: (e) => [e[0], { ...e[0], relativePath: 'ocr.json' }, e[1]]
    })
    await expectRegisterRefused('no-primary', { entries: (e) => e.slice(1) })

    const linkName = 'symlinked-child'
    const linkDir = bundleDirFor(linkName)
    const linkTicket = await beginReportBundle({ bundleDir: linkDir, conversation }, [root])
    writeBundleFiles(linkDir, linkName)
    fs.rmSync(path.join(linkDir, 'images', 'fig-02.png'))
    fs.symlinkSync(
      path.join(linkDir, 'images', 'fig-01.png'),
      path.join(linkDir, 'images', 'fig-02.png')
    )
    await expect(registerReportBundle(linkTicket)).rejects.toBeInstanceOf(ReportBundleRefusedError)

    const hardName = 'hardlinked-child'
    const hardDir = bundleDirFor(hardName)
    const hardTicket = await beginReportBundle({ bundleDir: hardDir, conversation }, [root])
    writeBundleFiles(hardDir, hardName)
    fs.linkSync(path.join(hardDir, 'images', 'fig-01.png'), path.join(tmp, 'alias.png'))
    await expect(registerReportBundle(hardTicket)).rejects.toBeInstanceOf(ReportBundleRefusedError)
  })

  it('omits and counts entries known only by a source URL', async () => {
    const { resp, bundleDir } = await seal('remote', {
      entries: (e) => [
        ...e,
        { role: 'report-image', fileName: 'fig-03.png', sourceUrl: 'https://example.test/x.png' }
      ]
    })
    expect(resp.imageCount).toBe(2)
    expect(resp.omittedEntries).toBe(1)
    const result = await verifyOne(resp.binding, primaryUrlFor(bundleDir))
    const snapshot = fs.readFileSync(
      path.join(userData, 'report-bundles', sha256(resp.binding), 'manifest.json'),
      'utf8'
    )
    expect(result).toMatchObject({ status: 'verified', imageCount: 2 })
    expect(snapshot).not.toContain('example.test')
  })
})

describe('report bundle verification', () => {
  it('verifies a sealed bundle and serves MAIN’s own snapshot manifest', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    const result = await verifyOne(resp.binding, primaryUrl)
    const snapshotPath = path.join(
      userData,
      'report-bundles',
      sha256(resp.binding),
      'manifest.json'
    )
    expect(result).toEqual({
      binding: resp.binding,
      status: 'verified',
      manifestUrl: toLocalMediaUrl(snapshotPath),
      imageCount: 2
    })
    const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'))
    expect(snapshot).toMatchObject({ version: 1, bundleId: 'canvas-target-s1', title: 'Stage' })
    expect(snapshot.entries).toEqual([
      {
        role: 'primary-report',
        fileName: 'report.md',
        mimeType: 'text/markdown',
        refName: 'report.md',
        sourceUrl: toLocalMediaUrl(path.join(bundleDir, 'report.md')),
        sizeBytes: 14,
        imageCount: 2
      },
      ...['fig-01.png', 'fig-02.png'].map((fileName) => ({
        role: 'report-image',
        fileName,
        mimeType: 'image/png',
        refName: fileName,
        sourceUrl: toLocalMediaUrl(path.join(bundleDir, 'images', fileName)),
        sizeBytes: 7
      }))
    ])
    // The OCR entry was checked but is not part of the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain('ocr.json')
  })

  it('accepts the same primary as a file URL and deduplicates repeated items', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    const fileUrl = `file://${path.join(bundleDir, 'report.md').replace(/\\/g, '/')}`
    expect((await verifyOne(resp.binding, fileUrl)).status).toBe('verified')
    const { results } = await verifyReportBundles({
      conversation,
      items: [
        { binding: resp.binding, primaryUrl },
        { binding: resp.binding, primaryUrl }
      ]
    })
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('verified')
  })

  it('refuses an unknown binding, another conversation or another recorded storage scope', async () => {
    const { resp, primaryUrl } = await seal()
    expect((await verifyOne(`rb1.${'Z'.repeat(43)}`, primaryUrl)).status).toBe('refused')
    expect(
      (await verifyOne(resp.binding, primaryUrl, { ...conversation, conversationId: 'conv-2' }))
        .status
    ).toBe('refused')
    expect(
      (await verifyOne(resp.binding, primaryUrl, { ...conversation, storageScope: 'other' })).status
    ).toBe('refused')
    expect(
      (
        await verifyOne(resp.binding, primaryUrl, {
          conversationId: 'conv-1'
        } as typeof conversation)
      ).status
    ).toBe('refused')

    // Without a recorded scope only the conversation id is compared.
    const unscoped = await seal('unscoped', { conversation: { conversationId: 'conv-9' } })
    expect(
      (
        await verifyOne(unscoped.resp.binding, unscoped.primaryUrl, {
          conversationId: 'conv-9',
          storageScope: 'any'
        })
      ).status
    ).toBe('verified')
  })

  it('refuses a primary URL that is not the registered file', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    for (const url of [
      toLocalMediaUrl(path.join(bundleDir, 'images', 'fig-01.png'))!,
      toLocalMediaUrl(path.join(bundleDir, 'ocr.json'))!,
      `${primaryUrl}?x=1`,
      `${primaryUrl}#frag`,
      primaryUrl.replace('/report.md', '/images/../report.md'),
      primaryUrl.replace('/report.md', '/images/%2E%2E/report.md'),
      'https://example.test/report.md',
      'data:text/markdown;base64,IyBSZXBvcnQKYm9keQo='
    ]) {
      expect((await verifyOne(resp.binding, url)).status).toBe('refused')
    }
    const other = await seal('other-bundle')
    expect((await verifyOne(resp.binding, other.primaryUrl)).status).toBe('refused')
    // A binding listed twice with different primaries is refused.
    const { results } = await verifyReportBundles({
      conversation,
      items: [
        { binding: resp.binding, primaryUrl },
        { binding: resp.binding, primaryUrl: other.primaryUrl }
      ]
    })
    expect(results).toEqual([{ binding: resp.binding, status: 'refused' }])
  })

  it('refuses when a child is deleted, rewritten with the same size or hard-linked', async () => {
    const deleted = await seal('deleted')
    fs.rmSync(path.join(deleted.bundleDir, 'images', 'fig-02.png'))
    expect((await verifyOne(deleted.resp.binding, deleted.primaryUrl)).status).toBe('refused')

    const rewritten = await seal('rewritten')
    fs.writeFileSync(path.join(rewritten.bundleDir, 'images', 'fig-01.png'), Buffer.from('PNG-ONE'))
    expect((await verifyOne(rewritten.resp.binding, rewritten.primaryUrl)).status).toBe('refused')

    const linked = await seal('linked-later')
    fs.linkSync(path.join(linked.bundleDir, 'images', 'fig-01.png'), path.join(tmp, 'alias.png'))
    expect((await verifyOne(linked.resp.binding, linked.primaryUrl)).status).toBe('refused')

    const primaryChanged = await seal('primary-changed')
    fs.writeFileSync(path.join(primaryChanged.bundleDir, 'report.md'), '# Report\nBODY\n')
    expect((await verifyOne(primaryChanged.resp.binding, primaryChanged.primaryUrl)).status).toBe(
      'refused'
    )
  })

  it('still verifies a child whose metadata changed but whose bytes did not', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    const child = path.join(bundleDir, 'images', 'fig-01.png')
    fs.utimesSync(child, new Date(2020, 0, 1), new Date(2020, 0, 1))
    expect((await verifyOne(resp.binding, primaryUrl)).status).toBe('verified')
    fs.writeFileSync(child, Buffer.from('PNG-one'))
    expect((await verifyOne(resp.binding, primaryUrl)).status).toBe('verified')
  })

  it('refuses when the snapshot is removed or edited', async () => {
    const removed = await seal('snap-removed')
    fs.rmSync(path.join(userData, 'report-bundles', sha256(removed.resp.binding)), {
      recursive: true
    })
    expect((await verifyOne(removed.resp.binding, removed.primaryUrl)).status).toBe('refused')

    const edited = await seal('snap-edited')
    const snapshotPath = path.join(
      userData,
      'report-bundles',
      sha256(edited.resp.binding),
      'manifest.json'
    )
    fs.writeFileSync(
      snapshotPath,
      fs.readFileSync(snapshotPath, 'utf8').replace('fig-02.png', 'fig-03.png')
    )
    expect((await verifyOne(edited.resp.binding, edited.primaryUrl)).status).toBe('refused')
  })

  it('refuses everything while the registry is not initialised', async () => {
    const { resp, primaryUrl, bundleDir } = await seal()
    resetReportBundleRegistryForTest()
    expect(await verifyOne(resp.binding, primaryUrl)).toEqual({
      binding: resp.binding,
      status: 'refused'
    })
    expect(isBoundTo(resp.binding, conversation.conversationId, primaryUrl)).toBe(false)
    await expect(beginReportBundle({ bundleDir, conversation }, [root])).rejects.toBeInstanceOf(
      ReportBundleRefusedError
    )
    await expect(registerReportBundle({ ticket: `rbt1.${'a'.repeat(43)}` })).rejects.toBeInstanceOf(
      ReportBundleRefusedError
    )
  })

  it('evicts the least recently verified record and removes its snapshot', async () => {
    resetReportBundleRegistryForTest()
    initializeReportBundleRegistry({ userDataDir: userData, now, maxRecords: 2 })
    const first = await seal('first')
    const second = await seal('second')
    clockOffset += 100
    expect((await verifyOne(first.resp.binding, first.primaryUrl)).status).toBe('verified')
    clockOffset += 100
    const third = await seal('third')
    expect((await verifyOne(second.resp.binding, second.primaryUrl)).status).toBe('refused')
    expect(fs.existsSync(path.join(userData, 'report-bundles', sha256(second.resp.binding)))).toBe(
      false
    )
    expect((await verifyOne(first.resp.binding, first.primaryUrl)).status).toBe('verified')
    expect((await verifyOne(third.resp.binding, third.primaryUrl)).status).toBe('verified')
  })

  it('refuses every item when more than 64 distinct bindings are asked for', async () => {
    const { resp, primaryUrl } = await seal()
    const items = [
      { binding: resp.binding, primaryUrl },
      ...Array.from({ length: 64 }, (_, index) => ({
        binding: `rb1.${String(index).padStart(43, 'q')}`,
        primaryUrl
      }))
    ]
    const { results } = await verifyReportBundles({ conversation, items })
    expect(results.length).toBeLessThanOrEqual(64)
    expect(results.every((result) => result.status === 'refused')).toBe(true)
  })
})

describe('report bundle registry lifecycle', () => {
  it('survives a reload from disk', async () => {
    const { resp, primaryUrl } = await seal()
    flushReportBundleRegistry()
    resetReportBundleRegistryForTest()
    initializeReportBundleRegistry({ userDataDir: userData, now })
    expect((await verifyOne(resp.binding, primaryUrl)).status).toBe('verified')
    expect(isBoundTo(resp.binding, conversation.conversationId, primaryUrl)).toBe(true)
  })

  it('starts empty, and refuses, when registry.json is corrupt', async () => {
    const { resp, primaryUrl } = await seal()
    resetReportBundleRegistryForTest()
    fs.writeFileSync(path.join(userData, 'report-bundles', 'registry.json'), '{oops')
    initializeReportBundleRegistry({ userDataDir: userData, now })
    expect((await verifyOne(resp.binding, primaryUrl)).status).toBe('refused')
  })

  it('a second registration of the same directory supersedes the first', async () => {
    const first = await seal('same-dir')
    const second = await seal('same-dir')
    expect(second.resp.binding).not.toBe(first.resp.binding)
    expect((await verifyOne(first.resp.binding, first.primaryUrl)).status).toBe('refused')
    expect(fs.existsSync(path.join(userData, 'report-bundles', sha256(first.resp.binding)))).toBe(
      false
    )
    expect((await verifyOne(second.resp.binding, second.primaryUrl)).status).toBe('verified')
  })
})

describe('report bundle registry durability', () => {
  const snapshotRoot = () => path.join(userData, 'report-bundles')
  const registryPath = () => path.join(snapshotRoot(), 'registry.json')
  const reinit = (options: { maxRecords?: number; maxRegistryBytes?: number } = {}) => {
    resetReportBundleRegistryForTest()
    initializeReportBundleRegistry({ userDataDir: userData, now, ...options })
  }
  const failRegistryReadOnce = () => {
    const realRead = fs.readFileSync
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file) === registryPath() && spy.mock.calls.length === 1) {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)
    return spy
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never overwrites a registry it failed to read; it reads it again and merges', async () => {
    const a = await seal('bundle-a')
    expect((await verifyOne(a.resp.binding, a.primaryUrl)).status).toBe('verified')
    flushReportBundleRegistry()

    failRegistryReadOnce()
    reinit()
    const b = await seal('bundle-b')
    vi.restoreAllMocks()

    reinit()
    expect((await verifyOne(a.resp.binding, a.primaryUrl)).status).toBe('verified')
    expect((await verifyOne(b.resp.binding, b.primaryUrl)).status).toBe('verified')
    expect(fs.existsSync(path.join(snapshotRoot(), sha256(a.resp.binding)))).toBe(true)
  })

  it('verifies earlier bindings once a registry that failed to load can be read', async () => {
    const a = await seal('bundle-a')
    flushReportBundleRegistry()
    failRegistryReadOnce()
    reinit()
    expect((await verifyOne(a.resp.binding, a.primaryUrl)).status).toBe('verified')
    expect(isBoundTo(a.resp.binding, conversation, a.primaryUrl)).toBe(true)
  })

  it('refuses a registration, and leaves the file alone, while the registry stays unreadable', async () => {
    const a = await seal('bundle-a')
    flushReportBundleRegistry()
    const before = fs.readFileSync(registryPath(), 'utf8')
    const realRead = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file) === registryPath()) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return (realRead as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)
    reinit()
    await expectRegisterRefused('bundle-b', {})
    vi.restoreAllMocks()
    expect(fs.readFileSync(registryPath(), 'utf8')).toBe(before)
    reinit()
    expect((await verifyOne(a.resp.binding, a.primaryUrl)).status).toBe('verified')
  })

  it('leaves a registry of a newer version untouched and registers nothing into it', async () => {
    await seal('bundle-a')
    flushReportBundleRegistry()
    const future = JSON.stringify({ version: 99, records: [{ anything: true }] })
    fs.writeFileSync(registryPath(), future)
    reinit()
    await expectRegisterRefused('bundle-b', {})
    flushReportBundleRegistry()
    expect(fs.readFileSync(registryPath(), 'utf8')).toBe(future)
  })

  it('moves invalid or oversized registry files aside instead of replacing them', async () => {
    const a = await seal('bundle-a')
    flushReportBundleRegistry()
    fs.writeFileSync(registryPath(), '{oops')
    reinit()
    const b = await seal('bundle-b')
    const aside = fs
      .readdirSync(snapshotRoot())
      .filter((name) => name.startsWith('registry.json.unreadable-'))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(snapshotRoot(), aside[0]), 'utf8')).toBe('{oops')
    expect((await verifyOne(b.resp.binding, b.primaryUrl)).status).toBe('verified')
    // The set-aside registry's snapshots are kept for recovery, even as apparent orphans.
    clockOffset += 3_600_000
    reinit()
    expect(fs.existsSync(path.join(snapshotRoot(), sha256(a.resp.binding)))).toBe(true)

    fs.rmSync(path.join(snapshotRoot(), aside[0]))
    const big = fs.readFileSync(registryPath(), 'utf8')
    reinit({ maxRegistryBytes: Buffer.byteLength(big) - 1 })
    expect((await verifyOne(b.resp.binding, b.primaryUrl)).status).toBe('refused')
    const moved = fs
      .readdirSync(snapshotRoot())
      .filter((name) => name.startsWith('registry.json.unreadable-'))
    expect(moved.map((name) => fs.readFileSync(path.join(snapshotRoot(), name), 'utf8'))).toEqual([
      big
    ])
  })

  it('refuses the registration and hands out no binding when registry.json cannot be written', async () => {
    const bundleDir = bundleDirFor('unwritable')
    const { ticket } = await beginReportBundle({ bundleDir, conversation }, [root])
    writeBundleFiles(bundleDir, 'unwritable')
    const realRename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === registryPath()) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return realRename(from, to)
    })
    await expect(registerReportBundle({ ticket })).rejects.toBeInstanceOf(ReportBundleRefusedError)
    vi.restoreAllMocks()
    const hashed = fs.readdirSync(snapshotRoot()).filter((name) => /^[a-f0-9]{64}$/.test(name))
    expect(hashed).toEqual([])
  })

  it('keeps registry.json within its size bound by evicting the least recently verified', async () => {
    const first = await seal('size-1')
    flushReportBundleRegistry()
    const oneRecord = Buffer.byteLength(fs.readFileSync(registryPath(), 'utf8'))
    reinit({ maxRegistryBytes: oneRecord * 2 + 64 })
    clockOffset += 100
    const second = await seal('size-2')
    clockOffset += 100
    const third = await seal('size-3')
    flushReportBundleRegistry()
    expect(fs.statSync(registryPath()).size).toBeLessThanOrEqual(oneRecord * 2 + 64)
    expect((await verifyOne(first.resp.binding, first.primaryUrl)).status).toBe('refused')
    expect(fs.existsSync(path.join(snapshotRoot(), sha256(first.resp.binding)))).toBe(false)
    expect((await verifyOne(second.resp.binding, second.primaryUrl)).status).toBe('verified')
    expect((await verifyOne(third.resp.binding, third.primaryUrl)).status).toBe('verified')
  })

  it('never evicts the record it has just registered, even after the clock went back', async () => {
    reinit({ maxRecords: 1 })
    const old = await seal('clock-old')
    clockOffset -= 3_600_000
    const fresh = await seal('clock-new')
    expect((await verifyOne(fresh.resp.binding, fresh.primaryUrl)).status).toBe('verified')
    expect((await verifyOne(old.resp.binding, old.primaryUrl)).status).toBe('refused')
  })

  it('sweeps old snapshot directories without a record at startup', async () => {
    const kept = await seal('kept')
    flushReportBundleRegistry()
    const oldOrphan = path.join(snapshotRoot(), 'a'.repeat(64))
    const newOrphan = path.join(snapshotRoot(), 'b'.repeat(64))
    const notHex = path.join(snapshotRoot(), 'keep-me')
    for (const dir of [oldOrphan, newOrphan, notHex]) fs.mkdirSync(dir)
    const hourAgo = new Date(Date.now() - 3_600_000)
    fs.utimesSync(oldOrphan, hourAgo, hourAgo)
    fs.utimesSync(notHex, hourAgo, hourAgo)
    reinit()
    expect(fs.existsSync(oldOrphan)).toBe(false)
    expect(fs.existsSync(newOrphan)).toBe(true)
    expect(fs.existsSync(notHex)).toBe(true)
    expect((await verifyOne(kept.resp.binding, kept.primaryUrl)).status).toBe('verified')
  })

  it('refuses files written shortly before the write session opened', async () => {
    const early = bundleDirFor('early')
    writeBundleFiles(early, 'early')
    clockOffset += 1_000
    const { ticket } = await beginReportBundle({ bundleDir: early, conversation }, [root])
    await expect(registerReportBundle({ ticket })).rejects.toBeInstanceOf(ReportBundleRefusedError)
  })
})

describe('isBoundTo', () => {
  it('accepts the registered local-media URL and a data: URL of the exact primary bytes', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    const bytes = fs.readFileSync(path.join(bundleDir, 'report.md'))
    expect(isBoundTo(resp.binding, 'conv-1', primaryUrl)).toBe(true)
    expect(
      isBoundTo(
        resp.binding,
        'conv-1',
        `local-media:///${path.join(bundleDir, 'report.md').replace(/\\/g, '/').replace(/^\/+/, '')}`
      )
    ).toBe(true)
    expect(
      isBoundTo(resp.binding, 'conv-1', `data:text/markdown;base64,${bytes.toString('base64')}`)
    ).toBe(true)
    expect(
      isBoundTo(
        resp.binding,
        'conv-1',
        `data:text/markdown,${encodeURIComponent(bytes.toString('utf8'))}`
      )
    ).toBe(true)
  })

  it('refuses other bytes, other files, other conversations and changed primaries', async () => {
    const { resp, bundleDir, primaryUrl } = await seal()
    const other = Buffer.from('# Report\nBODY\n')
    expect(
      isBoundTo(resp.binding, 'conv-1', `data:text/markdown;base64,${other.toString('base64')}`)
    ).toBe(false)
    expect(isBoundTo(resp.binding, 'conv-1', 'data:text/markdown;base64,%%%')).toBe(false)
    expect(
      isBoundTo(resp.binding, 'conv-1', toLocalMediaUrl(path.join(bundleDir, 'ocr.json'))!)
    ).toBe(false)
    expect(isBoundTo(resp.binding, 'conv-2', primaryUrl)).toBe(false)
    expect(isBoundTo(`rb1.${'Z'.repeat(43)}`, 'conv-1', primaryUrl)).toBe(false)
    expect(isBoundTo('not-a-binding', 'conv-1', primaryUrl)).toBe(false)
    fs.writeFileSync(path.join(bundleDir, 'report.md'), other)
    expect(isBoundTo(resp.binding, 'conv-1', primaryUrl)).toBe(false)
  })

  it('compares the recorded storage scope when given the conversation', async () => {
    const { resp, primaryUrl } = await seal()
    expect(isBoundTo(resp.binding, conversation, primaryUrl)).toBe(true)
    expect(isBoundTo(resp.binding, { ...conversation, storageScope: 'other' }, primaryUrl)).toBe(
      false
    )
    expect(isBoundTo(resp.binding, { conversationId: 'conv-1' }, primaryUrl)).toBe(false)
    expect(isBoundTo(resp.binding, { ...conversation, conversationId: 'conv-2' }, primaryUrl)).toBe(
      false
    )
    expect(isBoundTo(resp.binding, { conversationId: 7 }, primaryUrl)).toBe(false)
  })

  it('refuses a primary URL that names a link to the registered primary', async () => {
    const { resp, bundleDir } = await seal()
    const alias = path.join(tmp, 'alias.md')
    fs.symlinkSync(path.join(bundleDir, 'report.md'), alias)
    const aliasUrl = toLocalMediaUrl(alias)!
    expect((await verifyOne(resp.binding, aliasUrl)).status).toBe('refused')
    expect(isBoundTo(resp.binding, 'conv-1', aliasUrl)).toBe(false)
    expect(isBoundTo(resp.binding, conversation, aliasUrl)).toBe(false)
  })
})
