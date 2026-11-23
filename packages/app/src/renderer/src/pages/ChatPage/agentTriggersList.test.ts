import { describe, expect, it } from 'vitest'
import { formatAgentTriggers, localIsoSeconds } from './agentTriggersList'

describe('/triggers text (KohakuTerrarium 2.2.3)', () => {
  it("prints KT's header and padded rows, with the next fire time", () => {
    const createdAt = new Date(2026, 0, 2, 3, 4, 5).getTime()
    expect(localIsoSeconds(createdAt)).toBe('2026-01-02T03:04:05')
    expect(
      formatAgentTriggers([
        {
          id: 'tick',
          type: 'TimerTrigger',
          running: true,
          createdAt,
          nextFireAt: createdAt + 60_000,
          prompt: 'p'
        }
      ])
    ).toBe(
      `Active triggers (1):\n  ${'● running'.padEnd(10)} ${'tick'.padEnd(24)} ${'TimerTrigger'.padEnd(20)} 2026-01-02T03:04:05  next 2026-01-02T03:05:05`
    )
  })

  it('has no text for no triggers (the caller shows "No active triggers.")', () => {
    expect(formatAgentTriggers([])).toBeUndefined()
  })
})
