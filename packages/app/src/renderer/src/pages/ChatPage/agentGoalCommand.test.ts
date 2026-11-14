import { describe, expect, it } from 'vitest'
import { isAgentGoalCommand } from './agentGoalCommand'

describe('agentGoalCommand', () => {
  it('recognizes /goal as the first token, with or without text after it', () => {
    expect(isAgentGoalCommand('/goal')).toBe(true)
    expect(isAgentGoalCommand('  /GOAL ')).toBe(true)
    expect(isAgentGoalCommand('/goal ship the poster')).toBe(true)
    expect(isAgentGoalCommand('/goal\nship the poster')).toBe(true)
  })

  it('leaves other drafts to the ordinary send path', () => {
    expect(isAgentGoalCommand('/goals')).toBe(false)
    expect(isAgentGoalCommand('/goalkeeper')).toBe(false)
    expect(isAgentGoalCommand('goal')).toBe(false)
    expect(isAgentGoalCommand('please run /goal')).toBe(false)
  })
})
