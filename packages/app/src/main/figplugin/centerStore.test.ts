import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServiceValidationError } from '@shared/api/apiUtils/serviceValidation'
import { FigPluginCenterResponseSchema } from '@shared/figplugin/center'
import { measureFigPluginConfigBytes } from '@shared/figplugin/manifest'
import { FigPluginCenterStore } from './centerStore'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const date = '2026-01-01T00:00:00.000Z'
const manifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: 'demo.figplugin',
  name: ' Demo ',
  version: '1.2.3',
  host: 'figma',
  entryPath: 'plugin/main.js',
  capabilities: ['dialogue'],
  permissions: { dialogue: 'prompt' },
  limits: { maxConfigBytes: 128 },
  provenance: {
    publisherId: 'publisher',
    publisherName: 'Publisher',
    source: 'official',
    artifactSha256: 'A'.repeat(64),
    sourceUrl: 'https://example.invalid/not-fetched',
    issuedAt: date
  },
  signature: { algorithm: 'ed25519', keyId: 'key', value: 'b'.repeat(128), signedAt: date },
  ...overrides
})
const base = (kind: string, overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  kind,
  requestId: `${kind}-request`,
  idempotencyKey: `${kind}-idempotency`,
  requestedAt: date,
  ...overrides
})
const consent = (permission: string) => ({
  granted: true,
  permissions: [permission],
  grantedAt: date
})
const install = (overrides: Record<string, unknown> = {}) =>
  base('install', { manifest: manifest(), consent: consent('install'), ...overrides })
const target = (kind: string, overrides: Record<string, unknown> = {}) =>
  base(kind, { pluginId: 'demo.figplugin', host: 'figma', ...overrides })
const configure = (config: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
  target('configure', {
    consent: consent('configure'),
    config,
    configBytes: measureFigPluginConfigBytes(config),
    ...overrides
  })
const uninstall = (overrides: Record<string, unknown> = {}) =>
  target('uninstall', { consent: consent('uninstall'), ...overrides })

let parent: string
let root: string
let store: FigPluginCenterStore
const filename = (id = 'demo.figplugin') =>
  path.join(root, `${createHash('sha256').update(id).digest('hex')}.json`)
const execute = async (operation: unknown) => {
  const response = await store.execute(operation)
  expect(FigPluginCenterResponseSchema.safeParse(response).success).toBe(true)
  return response
}

beforeEach(async () => {
  parent = await fs.mkdtemp(path.join(process.cwd(), '.figplugin-store-test-'))
  root = path.join(parent, 'figplugin-center')
  store = new FigPluginCenterStore(root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(parent, { recursive: true, force: true })
})

describe('FIGPLUGIN manifest-only store', () => {
  it('inspects normalized manifests without touching storage or trusting signatures', async () => {
    const getRoot = vi.fn(() => {
      throw new Error('must not resolve root')
    })
    const inspector = new FigPluginCenterStore(getRoot)
    const response = await inspector.execute(base('inspect', { manifest: manifest() }))
    expect(response).toMatchObject({
      ok: true,
      kind: 'inspect',
      manifest: {
        name: 'Demo',
        provenance: { artifactSha256: 'a'.repeat(64) },
        permissions: { filesystem: 'none', network: 'none' }
      }
    })
    expect(getRoot).not.toHaveBeenCalled()
    expect(await fs.readdir(parent)).toEqual([])
  })

  it.each([
    { schemaVersion: 2 },
    { entryPath: '../escape.js' },
    { entryPath: 'C:/fixture-data.js' },
    { signature: { algorithm: 'none' } },
    { provenance: {} },
    { permissions: { dialogue: 'prompt', network: 'all' } },
    { sourcePath: 'C:/secret' }
  ])('rejects invalid manifest %j before filesystem access', async (override) => {
    await expect(store.execute(install({ manifest: manifest(override) }))).rejects.toBeInstanceOf(
      ServiceValidationError
    )
    expect(await fs.readdir(parent)).toEqual([])
  })

  it('installs, configures, reloads, and uninstalls with redacted disabled status', async () => {
    const installed = await execute(install())
    expect(installed).toMatchObject({
      ok: true,
      status: {
        installed: true,
        configured: false,
        ready: false,
        state: 'disabled',
        activeCalls: 0,
        lastFailure: { reason: 'not-ready', retryable: false }
      }
    })
    const secret = 'do-not-log-this-token'
    const configured = await execute(configure({ apiKey: secret, nested: { label: '密钥' } }))
    expect(configured).toMatchObject({ ok: true, status: { configured: true, ready: false } })
    const saved = JSON.parse(await fs.readFile(filename(), 'utf8'))
    expect(saved.config.apiKey).toBe(secret)
    expect(JSON.stringify(saved.receipts)).not.toContain(secret)
    store = new FigPluginCenterStore(root)
    const current = await execute(target('status'))
    expect(current).toMatchObject({ ok: true, status: { configured: true, state: 'disabled' } })
    for (const response of [installed, configured, current]) {
      const serialized = JSON.stringify(response)
      for (const forbidden of [
        secret,
        root,
        'entryPath',
        'provenance',
        'signature',
        'sourceUrl',
        'apiKey'
      ]) {
        expect(serialized).not.toContain(forbidden)
      }
    }
    expect(await execute(uninstall())).toMatchObject({
      ok: true,
      alreadyUninstalled: false,
      idempotent: true,
      status: { state: 'uninstalled', configured: false, installed: false, ready: false }
    })
    const tombstone = await fs.readFile(filename(), 'utf8')
    expect(JSON.parse(tombstone)).toMatchObject({ manifest: null, config: null })
    expect(tombstone).not.toContain(secret)
    expect(tombstone).not.toContain('entryPath')
    store = new FigPluginCenterStore(root)
    expect(await execute(uninstall({ idempotencyKey: 'uninstall-again' }))).toMatchObject({
      ok: true,
      alreadyUninstalled: true
    })
  })

  it('persists replay receipts, rejects conflicts, and never re-applies stale operations', async () => {
    const first = await execute(install())
    store = new FigPluginCenterStore(root)
    expect(await execute(install({ requestId: 'replay-request' }))).toEqual({
      ...first,
      requestId: 'replay-request'
    })
    expect(await execute(install({ manifest: manifest({ version: '2.0.0' }) }))).toMatchObject({
      ok: false,
      failure: { reason: 'idempotency-conflict' }
    })
    expect(
      await execute(
        install({ idempotencyKey: 'different-install', manifest: manifest({ version: '2.0.0' }) })
      )
    ).toMatchObject({ ok: false, failure: { reason: 'manifest-mismatch' } })
    await execute(configure({ requestedAt: 'secret-one' }))
    expect(await execute(configure({ requestedAt: 'secret-two' }))).toMatchObject({
      ok: false,
      failure: { reason: 'idempotency-conflict' }
    })
    await execute(uninstall())
    expect(await execute(install())).toEqual(first)
    expect(await execute(target('status'))).toMatchObject({ status: { installed: false } })
    await execute(install({ idempotencyKey: 'reinstall-new-key' }))
    await execute(uninstall())
    expect(await execute(target('status'))).toMatchObject({
      status: { installed: true, configured: false }
    })
  })

  it('replays historical mutations after the same ID is reinstalled for another host', async () => {
    const installed = await execute(install())
    const removed = await execute(uninstall())
    await execute(
      install({
        idempotencyKey: 'photoshop-install',
        manifest: manifest({ host: 'photoshop' })
      })
    )
    store = new FigPluginCenterStore(root)
    expect(await execute(uninstall({ requestId: 'old-remove-replay' }))).toEqual({
      ...removed,
      requestId: 'old-remove-replay'
    })
    expect(await execute(install({ requestId: 'old-install-replay' }))).toEqual({
      ...installed,
      requestId: 'old-install-replay'
    })
    expect(await execute(uninstall({ host: 'photoshop' }))).toMatchObject({
      ok: false,
      failure: { reason: 'idempotency-conflict' }
    })
    expect(await execute(uninstall({ idempotencyKey: 'new-wrong-host' }))).toMatchObject({
      ok: false,
      failure: { reason: 'manifest-mismatch' }
    })
    expect(await execute(target('status', { host: 'photoshop' }))).toMatchObject({
      status: { installed: true, host: 'photoshop', ready: false }
    })
  })

  it('enforces canonical config accounting, global and manifest limits, and host identity', async () => {
    expect(await execute(configure({}))).toMatchObject({ failure: { reason: 'not-installed' } })
    await execute(install())
    expect(await execute(configure({ token: 'x'.repeat(128) }))).toMatchObject({
      failure: { reason: 'payload-too-large' }
    })
    await expect(
      store.execute(configure({ token: '密钥' }, { configBytes: 1 }))
    ).rejects.toBeInstanceOf(ServiceValidationError)
    await expect(
      store.execute(configure({}, { config: { token: 'x'.repeat(65536) }, configBytes: 65536 }))
    ).rejects.toBeInstanceOf(ServiceValidationError)
    for (const config of [{ invalid: undefined }, { invalid: Infinity }, { invalid: 1n }]) {
      await expect(store.execute(configure({}, { config, configBytes: 1 }))).rejects.toBeInstanceOf(
        ServiceValidationError
      )
    }
    expect(await execute(configure({}, { host: 'photoshop' }))).toMatchObject({
      failure: { reason: 'manifest-mismatch' }
    })
    expect(await execute(uninstall({ host: 'photoshop' }))).toMatchObject({
      failure: { reason: 'manifest-mismatch' }
    })
    expect(await execute(target('status'))).toMatchObject({ status: { configured: false } })
  })

  it('snapshots config before queued work and serializes multiple store instances', async () => {
    await execute(install())
    const config = { nested: { token: 'original' } }
    const pending = store.execute(configure(config))
    config.nested.token = 'mutated'
    await pending
    expect(JSON.parse(await fs.readFile(filename(), 'utf8')).config.nested.token).toBe('original')
    const other = new FigPluginCenterStore(root)
    const responses = await Promise.all([
      store.execute(configure({ token: 'one' }, { idempotencyKey: 'concurrent-key' })),
      other.execute(configure({ token: 'two' }, { idempotencyKey: 'concurrent-key' }))
    ])
    expect(responses.filter((response) => response.ok)).toHaveLength(1)
    expect(responses.find((response) => !response.ok)).toMatchObject({
      failure: { reason: 'idempotency-conflict' }
    })
  })

  it('returns display-only relative paths without copying or opening entries', async () => {
    await execute(install())
    const before = await fs.readdir(root)
    expect(
      await execute(target('copy-path', { path: 'plugin/main.js', displayOnly: true }))
    ).toMatchObject({ ok: true, path: 'plugin/main.js', displayOnly: true })
    expect(await fs.readdir(root)).toEqual(before)
    for (const unsafe of [
      '../outside',
      'C:/fixture-data',
      '/fixture-data',
      '\\\\server\\share',
      'con.txt'
    ]) {
      await expect(
        store.execute(target('copy-path', { path: unsafe, displayOnly: true }))
      ).rejects.toBeInstanceOf(ServiceValidationError)
    }
  })

  it('fails closed on calls, even without a working root or with a claimed installedManifest', async () => {
    const unavailable = new FigPluginCenterStore(() => {
      throw new Error('no root')
    })
    const response = await unavailable.execute(
      target('call', {
        capability: 'dialogue',
        consent: consent('dialogue'),
        installedManifest: manifest(),
        payload: {
          operation: 'dialogue',
          input: { contentType: 'text', sizeBytes: 1 },
          dialogueText: 'secret'
        },
        payloadMetadata: { contentType: 'text', sizeBytes: 1 }
      })
    )
    expect(FigPluginCenterResponseSchema.safeParse(response).success).toBe(true)
    expect(response).toMatchObject({
      ok: false,
      kind: 'call',
      failure: { reason: 'not-ready', retryable: false }
    })
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(await fs.readdir(parent)).toEqual([])
  })

  it('requires consent and respects cancellation without state changes', async () => {
    await expect(
      store.execute(install({ consent: { granted: false, permissions: [] } }))
    ).rejects.toBeInstanceOf(ServiceValidationError)
    expect(
      await execute(install({ cancellation: { requested: true, requestedAt: date } }))
    ).toMatchObject({ failure: { reason: 'cancelled' } })
    expect(await fs.readdir(parent)).toEqual([])
  })

  it('does not commit operations whose queue/storage wait exceeds the timeout', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1000)
    expect(await execute(install({ timeoutMs: 100 }))).toMatchObject({
      failure: { reason: 'timeout' }
    })
    clock.mockRestore()
    expect(await fs.readdir(root)).toEqual([])
    expect(await execute(install())).toMatchObject({ ok: true })
  })

  it('checks the deadline after slow staging and preserves committed data and receipts', async () => {
    await execute(install())
    const previous = await fs.readFile(filename(), 'utf8')
    let now = 0
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const realOpen = fs.open.bind(fs)
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args)
      if (args[1] === 'wx') {
        const realSync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await realSync()
          now = 101
        })
      }
      return handle
    })
    const rename = vi.spyOn(fs, 'rename')
    expect(await execute(configure({ value: 'staged' }, { timeoutMs: 100 }))).toMatchObject({
      ok: false,
      failure: { reason: 'timeout' }
    })
    expect(rename).not.toHaveBeenCalled()
    expect(await fs.readFile(filename(), 'utf8')).toBe(previous)
    expect(await fs.readdir(root)).toEqual([path.basename(filename())])
    open.mockRestore()
    clock.mockRestore()
    expect(await execute(configure({ value: 'staged' }, { timeoutMs: 100 }))).toMatchObject({
      ok: true,
      status: { configured: true, ready: false }
    })
  })

  it('reports a successful rename truthfully even when the OS completes it after the deadline', async () => {
    let now = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const realRename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      await realRename(...args)
      now = 101
    })
    expect(await execute(install({ timeoutMs: 100 }))).toMatchObject({
      ok: true,
      status: { installed: true, ready: false }
    })
    expect(await execute(target('status'))).toMatchObject({ status: { installed: true } })
  })

  it.each(['con', 'C:device', 'Demo', 'demo'])(
    'uses isolated hashed filenames for ID %s',
    async (id) => {
      expect(await execute(install({ manifest: manifest({ id }) }))).toMatchObject({
        ok: true,
        pluginId: id
      })
      expect(await fs.readdir(root)).toEqual([path.basename(filename(id))])
      expect(path.dirname(filename(id))).toBe(root)
    }
  )

  it('preserves committed data on failed atomic replacement, cleans temp, and permits retry', async () => {
    await execute(install())
    await execute(configure({ token: 'old-secret' }))
    const previous = await fs.readFile(filename(), 'utf8')
    const rename = vi
      .spyOn(fs, 'rename')
      .mockRejectedValueOnce(new Error(`EACCES ${root} new-secret`))
    const response = await execute(
      configure({ token: 'new-secret' }, { idempotencyKey: 'atomic-config-key' })
    )
    expect(response).toMatchObject({ failure: { reason: 'internal-error' } })
    expect(JSON.stringify(response)).not.toContain(root)
    expect(JSON.stringify(response)).not.toContain('secret')
    expect(await fs.readFile(filename(), 'utf8')).toBe(previous)
    expect(await fs.readdir(root)).toEqual([path.basename(filename())])
    rename.mockRestore()
    store = new FigPluginCenterStore(root)
    expect(
      await execute(configure({ token: 'new-secret' }, { idempotencyKey: 'atomic-config-key' }))
    ).toMatchObject({ ok: true })
    const removeRename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('failure'))
    expect(await execute(uninstall())).toMatchObject({ ok: false })
    removeRename.mockRestore()
    expect(await execute(target('status'))).toMatchObject({
      status: { installed: true, configured: true }
    })
    expect(await execute(uninstall())).toMatchObject({ ok: true })
  })

  it('discards orphan temp files but never promotes them or overwrites corrupt committed data', async () => {
    await execute(install())
    const orphan = path.join(root, `.${path.basename(filename())}.${randomUUID()}.tmp`)
    await fs.writeFile(orphan, '{"config":"partial-secret"')
    store = new FigPluginCenterStore(root)
    expect(await execute(target('status'))).toMatchObject({
      ok: true,
      status: { installed: true, configured: false }
    })
    expect(await fs.readdir(root)).toEqual([path.basename(filename())])
    await fs.writeFile(filename(), '{corrupt')
    expect(await execute(install())).toMatchObject({ failure: { reason: 'internal-error' } })
    expect(await fs.readFile(filename(), 'utf8')).toBe('{corrupt')
  })

  it('keeps removal available when bounded replay history fills up', async () => {
    await execute(install())
    const record = JSON.parse(await fs.readFile(filename(), 'utf8'))
    const receipt = record.receipts[0]
    for (let index = 1; index < 511; index += 1) {
      const idempotencyKey = `historical-${index}`
      record.receipts.push({
        ...receipt,
        key: createHash('sha256')
          .update(JSON.stringify(['install', idempotencyKey]))
          .digest('hex'),
        response: { ...receipt.response, idempotencyKey }
      })
    }
    await fs.writeFile(filename(), JSON.stringify(record))
    expect(await execute(configure({ token: 'new-secret' }))).toMatchObject({
      failure: { reason: 'busy' }
    })
    expect(await execute(uninstall())).toMatchObject({ ok: true, alreadyUninstalled: false })
    store = new FigPluginCenterStore(root)
    expect(await execute(uninstall({ idempotencyKey: 'remove-full-history' }))).toMatchObject({
      ok: true,
      alreadyUninstalled: true
    })
    expect(await execute(install({ idempotencyKey: 'new-install-full-history' }))).toMatchObject({
      failure: { reason: 'busy' }
    })
    expect(await execute(target('status'))).toMatchObject({ status: { installed: false } })
    expect(JSON.parse(await fs.readFile(filename(), 'utf8')).receipts).toHaveLength(512)
  })

  it('rejects linked roots and hard-linked records without changing the target', async () => {
    const outside = path.join(parent, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
    expect(await execute(install())).toMatchObject({ failure: { reason: 'internal-error' } })
    expect(await fs.readdir(outside)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
    await execute(install())
    const linked = path.join(outside, 'linked.json')
    await fs.link(filename(), linked)
    const previous = await fs.readFile(linked, 'utf8')
    expect(await execute(uninstall())).toMatchObject({ failure: { reason: 'internal-error' } })
    expect(await fs.readFile(linked, 'utf8')).toBe(previous)
  })
})
