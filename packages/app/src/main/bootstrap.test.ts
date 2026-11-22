import { afterEach, describe, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ start: vi.fn(), normal: vi.fn(), exit: vi.fn() }))
vi.mock('electron', () => ({ app: { exit: h.exit } }))
vi.mock('./api/agentThreadHtmlChild', () => ({ startHtmlChildRuntime: h.start }))
vi.mock('./index', () => { h.normal(); return {} })
const argv = [...process.argv]
afterEach(() => { process.argv = [...argv]; vi.resetModules(); vi.clearAllMocks() })
describe('early isolated HTML bootstrap', () => {
  it('does not import normal application side effects for a helper launch', async () => {
    process.argv = [...argv, '--magicpot-isolated-html-child']
    await import('./bootstrap')
    expect(h.start).toHaveBeenCalledOnce(); expect(h.normal).not.toHaveBeenCalled()
  })
  it('normal startup imports existing app initialization and never applies helper policies', async () => {
    process.argv = argv.filter((arg) => arg !== '--magicpot-isolated-html-child')
    await import('./bootstrap'); await vi.waitFor(() => expect(h.normal).toHaveBeenCalledOnce())
    expect(h.start).not.toHaveBeenCalled()
  })
  it('fails closed without falling back to the user profile if helper initialization is invalid', async () => {
    process.argv = [...argv, '--magicpot-isolated-html-child']; h.start.mockImplementationOnce(() => { throw new Error('invalid') })
    await import('./bootstrap'); expect(h.exit).toHaveBeenCalledWith(1); expect(h.normal).not.toHaveBeenCalled()
  })
})
