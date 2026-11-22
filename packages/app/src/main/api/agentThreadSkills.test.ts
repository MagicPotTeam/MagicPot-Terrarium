import { describe, expect, it, vi } from 'vitest'
import { createAgentThreadSkills } from './agentThreadSkills'
import { createAgentThreadToolProvider } from './agentThreadTools'
import type { ThreadProceduralSkill } from '@shared/api/agentThreadSkill'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const skill: ThreadProceduralSkill = { id: 'git', name: 'git-flow', description: 'Test before commit', instructions: 'Run tests. Never force push.', baseDirectory: 'C:/skills', paths: ['*.ts'], digest: 'digest' }
const setup = () => {
  const controller = new AbortController(), assertLive = vi.fn(), load = vi.fn(async () => ({ skills: [structuredClone(skill)], truncated: false }))
  const skills = createAgentThreadSkills({ signal: controller.signal, assertLive, load })
  const assertInvocation = vi.fn()
  const provider = createAgentThreadToolProvider({ route, messages: [], assertInvocation, listVisibleTools: () => [], skills })
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await provider.callTool(name, args, { route, runId: 'r' })).content)
  return { controller, assertLive, load, skills, provider, assertInvocation, call }
}
describe('request-owned procedural instructions', () => {
  it('discovers on demand and returns instructions plus inert arguments without executing or widening grants', async () => {
    const t = setup(); expect(t.load).not.toHaveBeenCalled(); expect(t.provider.listTools().map((tool) => tool.name)).toContain('skill')
    expect(await t.call('info', { kind: 'skill', paths: ['src/a.ts'] })).toMatchObject({ skills: [{ id: 'git' }], grantsPermission: false })
    expect(await t.call('info', { kind: 'skill', paths: ['data.pdf'] })).toMatchObject({ skills: [] })
    expect(await t.call('skill', { name: 'git-flow', arguments: '$(do not execute) {{user}}' })).toMatchObject({ instructions: skill.instructions, arguments: '$(do not execute) {{user}}', executed: false, grantsPermission: false })
    expect(await t.call('info', { kind: 'skill', name: 'git' })).toMatchObject({ baseDirectory: 'C:/skills', mode: 'instructions-only' })
  })
  it('omits Markdown with disable-model-invocation from lists but permits explicit name lookup and invocation without grants', async () => {
    const t = setup(); t.load.mockResolvedValue({ skills: [{ ...skill, source: 'markdown', disableModelInvocation: true, metadataFields: ['allowed-tools', 'hooks'] }], truncated: false })
    expect(await t.call('info', { kind: 'skill' })).toMatchObject({ skills: [] })
    expect(await t.call('skill', { name: 'git' })).toMatchObject({ source: 'markdown', disableModelInvocation: true, ignoredMetadataFields: ['allowed-tools', 'hooks'], relativePathPolicy: expect.stringContaining('baseDirectory'), executed: false, grantsPermission: false })
    expect(await t.call('info', { kind: 'skill', name: 'git' })).toMatchObject({ instructions: skill.instructions })
  })
  it('creates an independently opted-in metadata snapshot once, pins it and never includes instruction bodies', async () => {
    const t = setup(), settings = { index: true, paths: true, assertCurrent: vi.fn(), scan: vi.fn(async () => ({ paths: ['src/a.ts'], truncated: false })) }
    const first = await t.skills.context(settings)
    expect(JSON.parse(first)).toMatchObject({ instructionsLoaded: false, grantsPermission: false, skills: [{ id: 'git', pathMatched: true }] })
    expect(first).not.toContain(skill.instructions); expect(first).not.toContain(skill.baseDirectory)
    t.load.mockResolvedValue({ skills: [{ ...skill, digest: 'changed' }], truncated: false })
    expect(await t.skills.context(settings)).toBe(first); expect(settings.scan).toHaveBeenCalledOnce(); expect(t.load).toHaveBeenCalledOnce()
    await expect(t.skills.invoke('git', '')).rejects.toThrow('changed')
  })
  it('never reuses context under replacement settings after path hints are disabled', async () => {
    const t = setup(), assertCurrent = vi.fn()
    const first = await t.skills.context({ index: true, paths: true, assertCurrent, scan: async () => ({ paths: ['a.ts'], truncated: false }) })
    expect(first).toContain('pathMatched')
    await expect(t.skills.context({ index: true, paths: false, assertCurrent: () => undefined })).rejects.toThrow('context changed')
    expect(t.load).toHaveBeenCalledOnce()
  })
  it('does no reads for disabled context and reports unavailable scans without inventing path matches', async () => {
    const t = setup(), scan = vi.fn(async () => { throw new Error('Do not disclose D:/secret') })
    expect(await t.skills.context({ index: false, paths: false, scan, assertCurrent: () => undefined })).toBe(''); expect(t.load).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled()
    const text = await t.skills.context({ index: true, paths: true, scan, assertCurrent: () => undefined })
    expect(JSON.parse(text)).toMatchObject({ scan: 'unavailable', skills: [{ id: 'git' }] }); expect(text).not.toContain('secret'); expect(text).not.toContain('pathMatched')
  })
  it('retains the shared read slot when a context scan outlives cancellation and discards its late result', async () => {
    const t = setup(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<{ paths: string[]; truncated: boolean }>(), controller = new AbortController()
    const pending = t.skills.context({ index: true, paths: true, assertCurrent: () => undefined, scan: async () => { entered.resolve(); return finish.promise } }, controller.signal)
    const rejected = expect(pending).rejects.toThrow('cancelled')
    await entered.promise; controller.abort(new Error('cancelled'))
    await rejected; await expect(t.skills.invoke('git', '')).rejects.toThrow('concurrency')
    finish.resolve({ paths: ['a.ts'], truncated: false }); await vi.waitFor(async () => expect(await t.skills.invoke('git', '')).toMatchObject({ id: 'git' }))
  })
  it('pins first-discovery definitions and refuses edits, new enables, removal or id/name ambiguity', async () => {
    const t = setup(); await t.call('info', { kind: 'skill' })
    t.load.mockResolvedValue({ skills: [{ ...skill, digest: 'changed', instructions: 'new' }, { ...skill, id: 'new', name: 'new' }], truncated: false })
    await expect(t.call('skill', { name: 'git' })).rejects.toThrow('changed')
    await expect(t.call('skill', { name: 'new' })).rejects.toThrow('unavailable')
    const other = setup(); other.load.mockResolvedValue({ skills: [skill, { ...skill, id: 'other', name: 'git' }], truncated: false })
    await expect(other.call('skill', { name: 'git' })).rejects.toThrow('ambiguous')
  })
  it('does not return instructions after pending load cancellation or document revocation', async () => {
    const t = setup(); let resolve!: (value: { skills: ThreadProceduralSkill[]; truncated: boolean }) => void
    t.load.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const pending = t.call('skill', { name: 'git' }).catch((error) => error)
    t.controller.abort(); resolve({ skills: [skill], truncated: false }); expect(await pending).toBeInstanceOf(Error)
    const revoked = setup(); revoked.load.mockImplementationOnce(async () => { revoked.assertLive.mockImplementation(() => { throw new Error('revoked') }); return { skills: [skill], truncated: false } })
    await expect(revoked.call('skill', { name: 'git' })).rejects.toThrow('revoked')
  })
  it('isolates route, refuses permission-like arguments and caps request reads', async () => {
    const t = setup()
    await expect(t.provider.callTool('skill', { name: 'git' }, { route: { ...route, threadId: 'other' }, runId: 'r' })).rejects.toThrow('outside')
    await expect(t.call('skill', { name: 'git', confirm: true })).rejects.toThrow('Invalid')
    await expect(t.call('skill', { name: 'git', arguments: 'a'.repeat(4001) })).rejects.toThrow('Invalid')
    await expect(t.call('info', { paths: ['a.ts'] })).rejects.toThrow('does not accept')
    for (let i = 0; i < 16; i++) await t.call('info', { kind: 'skill' })
    await expect(t.call('skill', { name: 'git' })).rejects.toThrow('budget')
    expect(t.load).toHaveBeenCalledTimes(16)
  })
  it('settles a cancelled caller promptly but retains the read slot until stalled I/O settles', async () => {
    const t = setup(); let rejectRead!: (error: Error) => void
    t.load.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject }))
    const callSignal = new AbortController()
    const pending = t.skills.invoke('git', '', callSignal.signal).catch((error) => error)
    callSignal.abort(new Error('cancelled caller'))
    try {
      expect(await pending).toMatchObject({ message: 'cancelled caller' })
      await expect(t.skills.invoke('git', '')).rejects.toThrow('concurrency')
      rejectRead(new Error('late I/O failure')); await vi.waitFor(async () => expect(await t.skills.invoke('git', '')).toMatchObject({ id: 'git' }))
    } finally { rejectRead(new Error('cleanup')); await pending }
  })
  it('enforces the wall-clock deadline without falsely releasing stalled read slots', async () => {
    vi.useFakeTimers()
    let resolveRead!: (value: { skills: ThreadProceduralSkill[]; truncated: boolean }) => void
    const deadline = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    const t = setup()
    t.load.mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve }))
    const pending = t.skills.invoke('git', '').catch((error) => error)
    try {
      expect(timeout).toHaveBeenCalledWith(10000)
      deadline.abort(new DOMException('deadline', 'TimeoutError'))
      expect(await pending).toMatchObject({ name: 'TimeoutError' })
      timeout.mockRestore()
      await expect(t.skills.invoke('git', '')).rejects.toThrow('concurrency')
    } finally { resolveRead({ skills: [skill], truncated: false }); await pending; timeout.mockRestore(); vi.useRealTimers() }
  })
  it('bounds cross-request concurrent reads and recovers after failure', async () => {
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve })
    const held = Array.from({ length: 4 }, setup)
    held.forEach((t) => t.load.mockImplementationOnce(async () => { await gate; throw new Error('do not leak C:/secret') }))
    const pending = held.map((t) => t.call('info', { kind: 'skill' }).catch((e) => e))
    const fifth = setup()
    try {
      await expect(fifth.call('info', { kind: 'skill' })).rejects.toThrow('concurrency')
      release(); const errors = await Promise.all(pending); expect(errors.every((e) => !String(e).includes('secret'))).toBe(true)
      await expect(fifth.call('skill', { name: 'git' })).resolves.toMatchObject({ executed: false })
    } finally { release(); await Promise.all(pending) }
  })
})
