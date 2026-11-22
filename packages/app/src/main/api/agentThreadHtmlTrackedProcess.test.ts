import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
import { sideTestCodec } from './agentThreadSideTestUtils'
import { AgentThreadHtmlRunLedger } from './agentThreadHtmlRunLedger'
import { openTrackedHtmlProcess } from './agentThreadHtmlTrackedProcess'
import type { openHtmlProcess } from './agentThreadHtmlProcess'
const roots: string[] = [], ledgers: AgentThreadHtmlRunLedger[] = []
const document = { title: 'App', html: '<p>test</p>', revision: 1 }
const setup = () => { const root = mkdtempSync(path.join(tmpdir(), 'html-tracked-run-')); roots.push(root); const ledger = AgentThreadHtmlRunLedger.initialize(sideTestCodec(), path.join(root, 'runs.sqlite')); ledgers.push(ledger); const controller = new AbortController(); return { ledger, controller, options: { ledger, ownerHash: 'a'.repeat(64), signal: controller.signal, assertLive: () => controller.signal.throwIfAborted(), onEvent: vi.fn(), onClosed: vi.fn() } } }
afterEach(() => { ledgers.splice(0).forEach(ledger => ledger.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks() })
describe('main-only durable launch composition', () => {
  it('commits unconfirmed before spawn and clears only confirmed native completion', async () => {
    const t = setup(), launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => {
      options.beforeSpawn!(); expect(t.ledger.list()[0].status).toBe('unconfirmed')
      return { closed: false, update: vi.fn(async () => undefined), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) }
    })
    const process = await openTrackedHtmlProcess(document, t.options, launch)
    expect(t.ledger.list()[0].status).toBe('unconfirmed')
    expect(await process.close()).toEqual({ confirmed: true }); expect(t.ledger.list()[0].status).toBe('clear'); expect(t.options.onClosed).toHaveBeenCalledExactlyOnceWith(true)
  })
  it.each(['preflight', 'after-reserve', 'never-spawned'] as const)('handles %s failure without guessing process-tree state', async kind => {
    const t = setup(), launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => {
      if (kind !== 'preflight') options.beforeSpawn!()
      if (kind === 'never-spawned') options.onClosed(true)
      throw new Error('failed launch')
    })
    await expect(openTrackedHtmlProcess(document, t.options, launch)).rejects.toThrow('failed launch')
    expect(t.ledger.list()[0].status).toBe(kind === 'after-reserve' ? 'unconfirmed' : 'clear')
  })
  it('retains unknown if the native close report was false, even if a later close result claims true', async () => {
    const t = setup(), launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => {
      options.beforeSpawn!(); options.onClosed(false)
      return { closed: true, update: vi.fn(async () => undefined), close: vi.fn(async () => ({ confirmed: true })) }
    })
    const process = await openTrackedHtmlProcess(document, t.options, launch)
    expect(await process.close()).toEqual({ confirmed: false }); expect(t.ledger.list()[0].status).toBe('unconfirmed')
  })
  it('does not turn an injected close result into a native completion callback', async () => {
    const t = setup(), launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => {
      options.beforeSpawn!()
      return { closed: false, update: vi.fn(async () => undefined), close: vi.fn(async () => ({ confirmed: true })) }
    })
    const process = await openTrackedHtmlProcess(document, t.options, launch)
    expect(await process.close()).toEqual({ confirmed: false }); expect(t.options.onClosed).not.toHaveBeenCalled(); expect(t.ledger.list()[0].status).toBe('unconfirmed')
  })
  it('reports unknown when native emptied but durable clearing fails', async () => {
    const t = setup(), launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => {
      options.beforeSpawn!()
      return { closed: false, update: vi.fn(async () => undefined), close: vi.fn(async () => { options.onClosed(true); return { confirmed: true } }) }
    })
    const process = await openTrackedHtmlProcess(document, t.options, launch)
    vi.spyOn(t.ledger, 'confirmEmpty').mockImplementationOnce(() => { throw new Error('disk failed') })
    expect(await process.close()).toEqual({ confirmed: false }); expect(t.options.onClosed).toHaveBeenCalledWith(false); expect(t.ledger.list()[0].status).toBe('unconfirmed')
  })
  it('does not reserve anything on already revoked input and rejects a launcher which skipped the fence', async () => {
    const t = setup(); t.controller.abort()
    const launch = vi.fn<typeof openHtmlProcess>(async (_document, options) => { options.beforeSpawn!(); throw new Error('must not continue') })
    await expect(openTrackedHtmlProcess(document, t.options, launch)).rejects.toThrow(); expect(t.ledger.list()[0].status).toBe('clear')
    const other = setup(), close = vi.fn(async () => ({ confirmed: true })), skipped = vi.fn<typeof openHtmlProcess>(async () => ({ closed: false, update: vi.fn(async () => undefined), close }))
    await expect(openTrackedHtmlProcess(document, other.options, skipped)).rejects.toThrow('durable run admission'); expect(close).toHaveBeenCalledOnce()
  })
})
