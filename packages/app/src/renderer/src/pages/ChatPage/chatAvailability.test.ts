import { describe, expect, it } from 'vitest'
import { shouldShowNoApiWarning } from './chatAvailability'

describe('shouldShowNoApiWarning', () => {
  it('shows the warning when no runtime is configured and the skill picker is closed', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: false,
        hasExternalAgentSkills: false,
        compact: true,
        isSkillPickerOpen: false,
        hasCustomSkills: true
      })
    ).toBe(true)
  })

  it('keeps the compact skill browser reachable without a configured runtime', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: false,
        hasExternalAgentSkills: false,
        compact: true,
        isSkillPickerOpen: true,
        hasCustomSkills: true
      })
    ).toBe(false)
  })

  it('does not show the warning when an external agent skill can handle requests', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: false,
        hasExternalAgentSkills: true,
        compact: true,
        isSkillPickerOpen: false,
        hasCustomSkills: true
      })
    ).toBe(false)
  })
})
