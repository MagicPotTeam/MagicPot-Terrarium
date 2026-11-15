import { describe, expect, it } from 'vitest'
import { shouldShowNoApiWarning } from './chatAvailability'

describe('shouldShowNoApiWarning', () => {
  it('shows the warning when no runtime is configured', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: false,
        hasExternalAgentSkills: false
      })
    ).toBe(true)
  })

  it('does not show the warning when a model profile or the remote runtime is available', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 1,
        useRemoteLlm: false,
        hasExternalAgentSkills: false
      })
    ).toBe(false)
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: true,
        hasExternalAgentSkills: false
      })
    ).toBe(false)
  })

  it('does not show the warning when an external agent skill can handle requests', () => {
    expect(
      shouldShowNoApiWarning({
        availableProfileCount: 0,
        useRemoteLlm: false,
        hasExternalAgentSkills: true
      })
    ).toBe(false)
  })
})
