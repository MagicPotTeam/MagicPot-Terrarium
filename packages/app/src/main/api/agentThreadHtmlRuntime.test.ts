import { mkdtempSync, rmSync, readdirSync, realpathSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { AgentThreadHtmlRunLedger } from './agentThreadHtmlRunLedger'
import { AgentThreadHtmlRuntime } from './agentThreadHtmlRuntime'
import { sideTestCodec } from './agentThreadSideTestUtils'
const roots: string[] = [], runtimes: AgentThreadHtmlRuntime[] = []
const setup = () => { const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'html-runtime-'))); roots.push(root); const codec = sideTestCodec(); let epoch: string | undefined; const runtime = new AgentThreadHtmlRuntime(root, codec, () => epoch); runtimes.push(runtime); return { root, codec, runtime, commit: async (next: string) => { epoch = next }, clear: () => { epoch = undefined }, read: () => epoch } }
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
describe('main HTML profile runtime prerequisites', () => {
  it('requires explicit first initialization and a matched config epoch for storage/launch', async () => {
    const t = setup(); expect(t.runtime.status()).toMatchObject({ initialized: false, canInitialize: true })
    expect(() => t.runtime.checkpoints()).toThrow('Initialize')
    expect(await t.runtime.initialize(t.commit, () => undefined)).toMatchObject({ initialized: true, available: true, canInitialize: false, unconfirmedRuns: 0 })
    expect(readdirSync(path.join(t.root, 'agent-thread-html')).sort()).toEqual(['runs.sqlite', 'runs.sqlite.anchor'])
    await expect(t.runtime.initialize(t.commit, () => undefined)).rejects.toThrow('already initialized')
    t.clear(); expect(t.runtime.status()).toMatchObject({ initialized: false, canInitialize: false }); expect(() => t.runtime.checkpoints()).toThrow('Initialize')
  })
  it('adopts only an authenticated never-used pair after config failure, without resetting any ledger', async () => {
    const t = setup(); await expect(t.runtime.initialize(async () => { throw Error('commit failed') }, () => undefined)).rejects.toThrow('commit failed')
    expect(t.runtime.status()).toMatchObject({ initialized: false, canInitialize: true })
    const before = readFileSync(path.join(t.root, 'agent-thread-html/runs.sqlite'))
    expect(await t.runtime.initialize(t.commit, () => undefined)).toMatchObject({ initialized: true, available: true })
    expect(readFileSync(path.join(t.root, 'agent-thread-html/runs.sqlite'))).toEqual(before)
    const other = setup(); await other.runtime.initialize(other.commit, () => undefined); other.runtime.close()
    rmSync(path.join(other.root, 'agent-thread-html/runs.sqlite'))
    expect(other.runtime.status()).toMatchObject({ initialized: true, available: false, canInitialize: false, unconfirmedRuns: null })
    expect(() => other.runtime.checkpoints()).toThrow('missing')
  })
  it('does not expose a second cached ledger while initialization config commit is pending', async () => {
    const t = setup(); let finish!: () => void
    const pending = t.runtime.initialize(async epoch => { await t.commit(epoch); await new Promise<void>(resolve => { finish = resolve }) }, () => undefined)
    await Promise.resolve()
    expect(t.runtime.status()).toMatchObject({ initialized: true, available: false, unconfirmedRuns: null, canInitialize: false })
    expect(() => t.runtime.checkpoints()).toThrow('still committing')
    await expect(t.runtime.initialize(t.commit, () => undefined)).rejects.toThrow('already committing')
    finish(); expect(await pending).toMatchObject({ available: true, unconfirmedRuns: 0 })
  })
  it('reports unknown rather than zero when profile paths fail or config loses its existing epoch', async () => {
    const t = setup(); await t.runtime.initialize(t.commit, () => undefined); t.clear()
    expect(t.runtime.status()).toMatchObject({ available: false, unconfirmedRuns: 0, canInitialize: false })
    t.runtime.close(); rmSync(t.root, { recursive: true, force: true })
    expect(t.runtime.status()).toMatchObject({ available: false, unconfirmedRuns: null, canInitialize: false })
  })
  it('never adopts a used or unconfirmed ledger when configuration loses the epoch', async () => {
    const t = setup(); await t.runtime.initialize(t.commit, () => undefined)
    const file = path.join(t.root, 'agent-thread-html/runs.sqlite'), runs = new AgentThreadHtmlRunLedger(t.codec, file)
    runs.reserve('a'.repeat(64)); runs.close(); t.runtime.close(); t.clear()
    expect(t.runtime.status()).toMatchObject({ initialized: false, available: true, unconfirmedRuns: 1, canInitialize: false })
    await expect(t.runtime.initialize(t.commit, () => undefined)).rejects.toThrow('was used')
    expect(t.runtime.status().unconfirmedRuns).toBe(1)
  })
  it('keeps checkpoint opt-in separate and refuses unavailable encryption before creating artifacts', async () => {
    const t = setup(); t.codec.available = () => false
    await expect(t.runtime.initialize(t.commit, () => undefined)).rejects.toThrow('unavailable')
    expect(readdirSync(t.root)).toEqual([])
  })
})
