import { afterEach, describe, expect, it, vi } from 'vitest'
import { retiredProfileKind, assertProfileNotRetired } from './retiredProfile'
import { cliFromProfile, isRunnableProfile, resolveProfileCallType, resolveProfileProvider, usesOpenAIResponsesImagePolicy } from './utils'
import { resolveChatProfileCapabilities } from './profileCapabilities'
import { sharedHostExtensionApiV1 } from '@shared/extensions/generatedRegistry'

const kinds = [['chat', 'gpt', '-web'].join(''), ['chat', 'gpt', '-web-playwright'].join('')]
const base = { model_name: 'gpt-5.4', base_url: 'https://api.openai.com/v1', api_key: 'owned' }
afterEach(() => { sharedHostExtensionApiV1.llmProfiles.splice(0); vi.unstubAllGlobals() })
describe('retired browser provider records', () => {
  it.each(kinds.flatMap((kind) => ['call_type', 'model_name', 'provider', 'auth_mode'].map((field) => [kind, field])))('keeps %s in %s inert before any extension or fallback', (kind, field) => {
    const profile = { ...base, [field]: ` ${kind.toUpperCase()} ` }
    const before = JSON.stringify(profile)
    const extension = { id: 'must-not-run', isRunnableProfile: vi.fn(() => true), resolveProfileCallType: vi.fn(() => 'api'), resolveProfileProvider: vi.fn(() => 'openai' as const), createCli: vi.fn(), resolveCapabilities: vi.fn() }
    sharedHostExtensionApiV1.llmProfiles.push(extension)
    expect(retiredProfileKind(profile)).toBe(kind)
    expect(resolveProfileCallType(profile)).toBe(kind)
    expect(resolveProfileProvider(profile)).toBeUndefined()
    expect(isRunnableProfile(profile)).toBe(false)
    expect(usesOpenAIResponsesImagePolicy(profile)).toBe(false)
    expect(() => assertProfileNotRetired(profile)).toThrow('removed')
    expect(() => cliFromProfile(profile)).toThrow(expect.objectContaining({ code: 'LLM_PROFILE_RETIRED' }))
    expect(resolveChatProfileCapabilities({ ...profile, attachment_transports: ['request-data-url'], supports_session_continuation: true })).toMatchObject({ attachmentTransports: [], reasoningEfforts: [], supportsAutoContextCompression: false, supportsSessionContinuation: false })
    for (const [key, fn] of Object.entries(extension)) if (key !== 'id') expect(fn).not.toHaveBeenCalled()
    expect(JSON.stringify(profile)).toBe(before)
  })
  it('does not retire Codex OAuth, CLIProxyAPI, ordinary APIs, or unrelated browser tool names', () => {
    for (const profile of [base, { ...base, auth_mode: 'codex_oauth', call_type: 'codex' }, { ...base, call_type: 'cliproxyapi' }, { ...base, model_name: 'playwright-reviewer' }]) {
      expect(retiredProfileKind(profile)).toBeUndefined()
      expect(() => assertProfileNotRetired(profile)).not.toThrow()
      expect(isRunnableProfile(profile)).toBe(true)
    }
  })
})
