import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.unmock('node:fs'); vi.unmock('node:fs/promises')
const h = vi.hoisted(() => ({ root: '', fromId: vi.fn(), parent: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => h.root }, webContents: { fromId: h.fromId }, BrowserWindow: { fromWebContents: h.parent } }))
vi.mock('../config/buildEnv', () => ({ getBuildEnv: () => ({ ...DEFAULT_BUILD_ENV, pathMap: { ...DEFAULT_BUILD_ENV.pathMap, data: h.root, file: h.root, resources: '' } }) }))
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import { getConfig, initConfig, listenConfig, saveConfig } from '../config/config'
import { userAgentSkillSession } from './agentThreadSkillSession'
import { setAgentSkillScope } from './agentThreadSkillScope'
import { registerMagicAgentTrustedRouteBinding, clearMagicAgentTrustedRouteBindingsForTest } from '../magicAgentRuntime/trustedRouteBinding'
const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'p', threadId: 't' } as const, scope = { route, conversationId: 'chat' }
const url = 'file:///D:/app/index.html#/canvas?id=p', invoke = (method: string) => ({ methodName: `svcLLMProxy.${method}`, senderId: 171, isMainFrame: true, frameUrl: url, senderUrl: url })
let sender: EventEmitter, documentToken: string
beforeEach(async () => {
  h.root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'skill-session-config-')))
  sender = Object.assign(new EventEmitter(), { id: 171, isDestroyed: () => false, getURL: () => url }); h.fromId.mockReturnValue(sender); h.parent.mockReturnValue({ isDestroyed: () => false, webContents: sender })
  registerMagicAgentTrustedRouteBinding(171, route, { trustedUrl: url, trustedWebContents: sender as never })
  await fs.mkdir(path.join(h.root, 'pack')); await fs.writeFile(path.join(h.root, 'pack', 'SKILL.md'), '---\nname: durable\ndescription: Metadata only\n---\nPRIVATE_DURABLE_BODY')
  await initConfig()
  await saveConfig({ llm_config: { proceduralSkillPackages: [{ id: 'pack', directory: path.join(h.root, 'pack'), enabled: true }] } })
  documentToken = setAgentSkillScope({ ...scope, active: true, lifecycleRevision: 1 }, invoke('setAgentSkillScope')).documentToken!
})
afterEach(async () => { sender.emit('did-start-navigation'); sender.emit('destroyed'); clearMagicAgentTrustedRouteBindingsForTest(); vi.restoreAllMocks(); await fs.rm(h.root, { recursive: true, force: true }) })
const list = () => userAgentSkillSession({ ...scope, documentToken }, invoke('listAgentSessionSkills'))
const mutation = (id: string) => ({ ...scope, documentToken, id, enabled: false, expectedRevision: 0, operationId: 'durable-disable' })
describe('actual guarded config persistence for skill session preferences', () => {
  it('persists and reloads scoped metadata-only denial and recovers the retained operation receipt', async () => {
    const id = (await list()).skills[0].id, request = mutation(id)
    expect(await userAgentSkillSession(request, invoke('setAgentSkillPreference'), request)).toMatchObject({ revision: 1, skills: [{ enabled: false }] })
    const disk = JSON.parse(await fs.readFile(path.join(h.root, 'config.json'), 'utf8'))
    expect(disk.llm_config.proceduralSkillSessions[0]).toMatchObject({ revision: 1, disabledIds: [id], receipts: [{ operationId: request.operationId }] })
    expect(JSON.stringify(disk.llm_config.proceduralSkillSessions)).not.toContain('PRIVATE_DURABLE_BODY')
    await initConfig()
    expect((await list()).skills[0].enabled).toBe(false)
    expect(await userAgentSkillSession(request, invoke('setAgentSkillPreference'), request)).toMatchObject({ revision: 1 })
  })
  it('rejects a scope retired after the actual temp write and before synchronous config rename', async () => {
    const request = mutation((await list()).skills[0].id), before = await fs.readFile(path.join(h.root, 'config.json'), 'utf8')
    const original = fs.writeFile.bind(fs), gate = Promise.withResolvers<void>()
    const write = vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { await original(...args); await gate.promise })
    try {
      const pending = userAgentSkillSession(request, invoke('setAgentSkillPreference'), request).catch(error => error)
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
      setAgentSkillScope({ ...scope, active: false, lifecycleRevision: 1 }, invoke('setAgentSkillScope'))
      gate.resolve(); expect(await pending).toBeInstanceOf(Error)
      expect(await fs.readFile(path.join(h.root, 'config.json'), 'utf8')).toBe(before)
      expect(getConfig().llm_config.proceduralSkillSessions).toBeUndefined()
      expect((await fs.readdir(h.root)).some(name => name.endsWith('.tmp'))).toBe(false)
    } finally { gate.resolve(); write.mockRestore() }
  })
  it('does not misclassify a post-commit listener error as rejection or reapply a committed change', async () => {
    const request = mutation((await list()).skills[0].id)
    let fail = true
    listenConfig({ id: 'skill-post-commit-test', onEnd: () => undefined, onEvent: () => { if (fail) { fail = false; throw new Error('listener failed after commit') } } })
    await expect(userAgentSkillSession(request, invoke('setAgentSkillPreference'), request)).rejects.toThrow('listener failed after commit')
    expect(getConfig().llm_config.proceduralSkillSessions?.[0].revision).toBe(1)
    expect(JSON.parse(await fs.readFile(path.join(h.root, 'config.json'), 'utf8')).llm_config.proceduralSkillSessions[0].revision).toBe(1)
    expect(await userAgentSkillSession(request, invoke('setAgentSkillPreference'), request)).toMatchObject({ revision: 1, skills: [{ enabled: false }] })
  })
})
