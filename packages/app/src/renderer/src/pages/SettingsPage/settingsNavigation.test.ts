import { describe, expect, it } from 'vitest'
import { getSettingsTab, SETTINGS_GROUPS, SETTINGS_TABS } from './settingsNavigation'

const legacyTabs = ['general', 'llm', 'environment', 'plugin', 'mcp', 'updates', 'about'] as const

describe('settingsNavigation', () => {
  it('groups all legacy IDs exactly once in product order', () => {
    expect(SETTINGS_GROUPS.map(({ id, tabs }) => ({ id, tabs }))).toEqual([
      { id: 'general', tabs: ['general'] },
      { id: 'models', tabs: ['llm', 'environment'] },
      { id: 'tools', tabs: ['plugin', 'mcp'] },
      { id: 'application', tabs: ['updates', 'about'] }
    ])
    expect(SETTINGS_TABS).toEqual(legacyTabs)
    expect(new Set(SETTINGS_TABS).size).toBe(legacyTabs.length)
  })

  it.each(legacyTabs)('resolves %s from legacy state or a shareable query', (tab) => {
    expect(getSettingsTab({ state: { tab } })).toBe(tab)
    expect(getSettingsTab({ search: `?source=legacy&tab=${tab}` })).toBe(tab)
    expect(getSettingsTab({ state: { tab }, search: '?tab=unknown' })).toBe(tab)
  })

  it('gives valid legacy state precedence without mutating location', () => {
    const state = Object.freeze({ tab: 'updates', returnTo: '/workshop' })
    const location = Object.freeze({ state, search: '?tab=llm' })
    expect(getSettingsTab(location)).toBe('updates')
    expect(location.state).toBe(state)
    expect(location.search).toBe('?tab=llm')
  })

  it.each([undefined, null, {}, { tab: 'unknown' }, { tab: 3 }, { tab: null }, 'llm', []])(
    'uses the query when state is not a valid legacy link: %j',
    (state) => {
      expect(getSettingsTab({ state, search: '?tab=plugin' })).toBe('plugin')
    }
  )

  it.each(['', '?tab=', '?tab=unknown', '?tab=LLM', '?tab=__proto__', '?tab=%00', '?other=llm'])(
    'safely falls back for an absent or unknown query: %s',
    (search) => {
      expect(getSettingsTab({ state: { tab: 'invalid' }, search })).toBe('general')
    }
  )

  it('defaults to general without location fields', () => {
    expect(getSettingsTab({})).toBe('general')
  })
})
