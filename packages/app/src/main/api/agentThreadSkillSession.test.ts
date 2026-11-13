import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ fromId: vi.fn(), parent: vi.fn(), data: '' }))
vi.mock('electron', () => ({ webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ ...DEFAULT_BUILD_ENV, pathMap: { data: h.data, file: h.data, resources: '' } }) }))
vi.mock('../config/config', () => ({ getConfig: vi.fn(), saveConfig: vi.fn(), onConfigCommitted: vi.fn() }))
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { DEFAULT_CONFIG } from '@shared/config/config'
import { getConfig, saveConfig } from '../config/config'
import { showAgentSessionSkill, userAgentSkillSession } from './agentThreadSkillSession'
import { agentSkillScopeRevision, setAgentSkillScope } from './agentThreadSkillScope'
import { skillPreferenceSnapshot } from '../customSkill/sessionPreferences'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const
const scope = { route, conversationId: 'chat' }, url = 'file:///D:/app/index.html#/canvas?id=p'
const invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 71, isMainFrame: true, frameUrl: url, senderUrl: url })
let config: typeof DEFAULT_CONFIG, sender: EventEmitter, token: string
beforeEach(async () => {
  vi.clearAllMocks(); h.data = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-session-')))
  sender = Object.assign(new EventEmitter(), { id: 71, isDestroyed: () => false, getURL: () => url }); h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(71, route, { trustedUrl: url, trustedWebContents: sender as never })
  config = structuredClone(DEFAULT_CONFIG); config.llm_config.proceduralSkillPackages = [{ id: 'registered', directory: path.join(h.data, 'pack'), enabled: true, projectId: 'p' }]
  await fs.mkdir(path.join(h.data, 'pack')); await fs.writeFile(path.join(h.data, 'pack', 'SKILL.md'), '---\nname: scoped\ndescription: Metadata only\n---\nPRIVATE_SKILL_BODY')
  vi.mocked(getConfig).mockReturnValue(config)
  vi.mocked(saveConfig).mockReset().mockImplementation(async (patch, guard) => { guard?.(); config.llm_config = { ...config.llm_config, ...patch.llm_config } as typeof config.llm_config })
  token = setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentSkillScope')).documentToken!
})
afterEach(async () => { sender.emit('did-start-navigation'); sender.emit('destroyed'); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); await fs.rm(h.data, { recursive: true, force: true }) })
const list = () => userAgentSkillSession({ ...scope, documentToken: token }, invoke('listAgentSessionSkills'))
const change = (id: string, enabled = false, expectedRevision = 0, operationId = 'operation') => { const req = { ...scope, documentToken: token, id, enabled, expectedRevision, operationId }; return userAgentSkillSession(req, invoke('setAgentSkillPreference'), req) }
describe('current-document user skill preference service', () => {
  it('lists only metadata and persists scoped deny preferences without touching skill bodies or model tools', async () => {
    const before = await list(); expect(before).toMatchObject({ revision: 0, skills: [{ name: 'scoped', enabled: true }], grantsPermission: false })
    expect(JSON.stringify(before)).not.toContain('PRIVATE_SKILL_BODY'); expect(saveConfig).not.toHaveBeenCalled()
    expect(await change(before.skills[0].id)).toMatchObject({ revision: 1, skills: [{ enabled: false }] })
    expect(saveConfig).toHaveBeenCalledOnce()
    const enabled = await change(before.skills[0].id, true, 1, 'enable'); expect(enabled).toMatchObject({ revision: 2, skills: [{ enabled: true }] })
    expect(await change(before.skills[0].id)).toMatchObject({ revision: 2, skills: [{ enabled: true }] }); expect(saveConfig).toHaveBeenCalledTimes(2)
    await expect(change(before.skills[0].id, true)).rejects.toThrow('replay conflict')
    expect(skillPreferenceSnapshot(config.llm_config.proceduralSkillSessions, { ...scope, conversationId: 'other' })).toEqual({ revision: 0, disabledIds: [] })
  })
  it('cannot enable globally disabled or project-mismatched entries, while a retained replay stays non-authorizing', async () => {
    const entry = (await list()).skills[0]; await change(entry.id)
    config.llm_config.proceduralSkillPackages![0].enabled = false
    expect((await list()).skills).toEqual([])
    expect(await change(entry.id)).toMatchObject({ revision: 1, staleDisabledIds: [entry.id] })
    expect(await change(entry.id, true, 1, 'forget-stale')).toMatchObject({ revision: 2, skills: [], staleDisabledIds: [] })
    await expect(change(entry.id, true, 2, 'new-enable')).rejects.toThrow('not globally enabled')
    config.llm_config.proceduralSkillPackages![0].enabled = true; config.llm_config.proceduralSkillPackages![0].projectId = 'other'
    await expect(change(entry.id, true, 2, 'another')).rejects.toThrow('not globally enabled')
    expect(saveConfig).toHaveBeenCalledTimes(2)
  })
  it.each(['navigation', 'scope-switch', 'config-change', 'other-owner-change'] as const)('guards queued config commit after %s, retaining the original state', async mode => {
    const entry = (await list()).skills[0]
    let release!: () => void
    vi.mocked(saveConfig).mockImplementationOnce(async (_patch, guard) => { await new Promise<void>(resolve => { release = resolve }); guard?.() })
    const pending = change(entry.id).catch(error => error)
    await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce())
    if (mode === 'navigation') sender.emit('did-start-navigation')
    else if (mode === 'scope-switch') setAgentSkillScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentSkillScope'))
    else if (mode === 'config-change') config.llm_config.proceduralSkillPackages![0].enabled = false
    else config.llm_config.proceduralSkillSessions = []
    release(); expect(await pending).toBeInstanceOf(Error)
    expect(skillPreferenceSnapshot(config.llm_config.proceduralSkillSessions, scope).revision).toBe(0)
  })
  it('rejects stale tokens, retired binding generations and untrusted or widened callers', async () => {
    const entry = (await list()).skills[0]
    setAgentSkillScope({ ...scope, active: false, lifecycleRevision: 1 }, invoke('setAgentSkillScope'))
    await expect(change(entry.id)).rejects.toThrow('active conversation')
    expect(() => setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentSkillScope'))).toThrow('Retired')
    for (const invocation of [undefined, { ...invoke('listAgentSessionSkills'), isMainFrame: false }, { ...invoke('listAgentSessionSkills'), senderId: 72 }]) await expect(userAgentSkillSession({ ...scope, documentToken: token }, invocation)).rejects.toThrow()
    expect(saveConfig).not.toHaveBeenCalled()
  })
  it('retire-before-activate and newer retirement retain a high-water fence without a usable token', async () => {
    setAgentSkillScope({ ...scope, active: false, lifecycleRevision: 3 }, invoke('setAgentSkillScope'))
    await expect(list()).rejects.toThrow('active conversation')
    expect(() => setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 3 }, invoke('setAgentSkillScope'))).toThrow('Retired')
    expect(() => setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 2 }, invoke('setAgentSkillScope'))).toThrow('Stale')
    token = setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 4 }, invoke('setAgentSkillScope')).documentToken!
    expect((await list()).revision).toBe(0)
    sender.emit('did-start-navigation')
    expect(() => setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 4 }, invoke('setAgentSkillScope'))).toThrow('Retired')
    expect(agentSkillScopeRevision(scope, invoke('agentSkillScopeRevision'))).toEqual({ revision: 4 })
    const fresh = agentSkillScopeRevision(scope, invoke('agentSkillScopeRevision')).revision + 1
    token = setAgentSkillScope({ ...scope, active: true, lifecycleRevision: fresh }, invoke('setAgentSkillScope')).documentToken!
    expect((await list()).revision).toBe(0)
    sender.emit('destroyed') // Next real WebContents starts a fresh lifecycle high-water entry.
    setAgentSkillScope({ ...scope, active: false, lifecycleRevision: 8 }, invoke('setAgentSkillScope'))
    expect(() => setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 8 }, invoke('setAgentSkillScope'))).toThrow('Retired')
    token = setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 9 }, invoke('setAgentSkillScope')).documentToken!
    expect((await list()).skills).toHaveLength(1)
  })
  it('reports an old evicted replay as not applied now, never as proof the earlier request did not commit', async () => {
    const entry = (await list()).skills[0]
    await change(entry.id)
    for (let revision = 1; revision <= 17; revision++) await change(entry.id, revision % 2 === 1, revision, `later-${revision}`)
    expect(await change(entry.id)).toEqual({ status: 'not-applied', reason: 'revision-conflict', operationId: 'operation', currentRevision: 18 })
    expect(saveConfig).toHaveBeenCalledTimes(18)
    expect((await list()).revision).toBe(18)
  })
  it('explicit user show reads current instructions even if session-disabled, but never bypasses global registration', async () => {
    const id = (await list()).skills[0].id; await change(id)
    const request = { ...scope, documentToken: token, name: 'scoped' }
    expect(await showAgentSessionSkill(request, invoke('showAgentSessionSkill'))).toMatchObject({ id, enabled: false, instructions: 'PRIVATE_SKILL_BODY', revision: 1, untrustedData: true, grantsPermission: false, executed: false })
    await fs.appendFile(path.join(h.data, 'pack', 'SKILL.md'), '\nLATEST_TEXT')
    expect((await showAgentSessionSkill({ ...request, name: id }, invoke('showAgentSessionSkill'))).instructions).toContain('LATEST_TEXT')
    config.llm_config.proceduralSkillPackages![0].enabled = false
    await expect(showAgentSessionSkill(request, invoke('showAgentSessionSkill'))).rejects.toThrow('unavailable')
    expect(saveConfig).toHaveBeenCalledOnce()
  })
  it.each(['navigation', 'scope-switch', 'remote', 'preference', 'registration'] as const)('rejects user show after %s during Markdown loading', async mode => {
    const { changeSkillPreference } = await import('../customSkill/sessionPreferences')
    const id = (await list()).skills[0].id, original = fs.open.bind(fs), file = path.join(h.data, 'pack', 'SKILL.md')
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await original(...args)
      if (String(args[0]) === file) {
        if (mode === 'navigation') sender.emit('did-start-navigation')
        else if (mode === 'scope-switch') setAgentSkillScope({ ...scope, conversationId: 'other', active: true, lifecycleRevision: 2 }, invoke('setAgentSkillScope'))
        else if (mode === 'remote') config.use_remote_llm = true
        else if (mode === 'preference') config.llm_config.proceduralSkillSessions = changeSkillPreference(undefined, { ...scope, documentToken: token, id, enabled: false, expectedRevision: 0, operationId: 'mid-show' }).records
        else config.llm_config.proceduralSkillPackages![0].enabled = false
      }
      return handle
    })
    await expect(showAgentSessionSkill({ ...scope, documentToken: token, name: 'scoped' }, invoke('showAgentSessionSkill'))).rejects.toThrow()
    expect(saveConfig).not.toHaveBeenCalled()
  })
  it('refuses widened/malformed user detail, wrong scope or method and ambiguous catalog identity', async () => {
    const request = { ...scope, documentToken: token, name: 'scoped' }
    await expect(showAgentSessionSkill({ ...request, name: 'x'.repeat(129) }, invoke('showAgentSessionSkill'))).rejects.toThrow('Invalid')
    await expect(showAgentSessionSkill({ ...request, all: true } as typeof request, invoke('showAgentSessionSkill'))).rejects.toThrow('Invalid')
    await expect(showAgentSessionSkill(request, invoke('chat'))).rejects.toThrow()
    await expect(showAgentSessionSkill({ ...request, conversationId: 'foreign' }, invoke('showAgentSessionSkill'))).rejects.toThrow()
    await fs.writeFile(path.join(h.data, 'pack', 'duplicate.md'), '---\nname: scoped\n---\nAMBIGUOUS_BODY')
    // A folder SKILL.md beats flat within the same directory by existing contract;
    // a separate registered directory collision must remove both definitions.
    await fs.mkdir(path.join(h.data, 'second')); await fs.writeFile(path.join(h.data, 'second', 'SKILL.md'), '---\nname: scoped\n---\nAMBIGUOUS_BODY')
    config.llm_config.proceduralSkillPackages!.push({ id: 'second', directory: path.join(h.data, 'second'), enabled: true })
    await expect(showAgentSessionSkill(request, invoke('showAgentSessionSkill'))).rejects.toThrow('unavailable')
  })
  it('serializes pending mutations and rejects caller changes and stale revisions before another save', async () => {
    const entry = (await list()).skills[0]
    let release!: () => void
    vi.mocked(saveConfig).mockImplementationOnce(async (patch, guard) => { await new Promise<void>(resolve => { release = resolve }); guard?.(); config.llm_config.proceduralSkillSessions = patch.llm_config!.proceduralSkillSessions as never })
    const pending = change(entry.id); await vi.waitFor(() => expect(saveConfig).toHaveBeenCalledOnce())
    await expect(change(entry.id, true)).rejects.toThrow('busy'); release(); await pending
    await expect(change(entry.id, true, 0, 'stale')).resolves.toEqual({ status: 'not-applied', reason: 'revision-conflict', operationId: 'stale', currentRevision: 1 })
    expect(saveConfig).toHaveBeenCalledOnce()
  })
})
