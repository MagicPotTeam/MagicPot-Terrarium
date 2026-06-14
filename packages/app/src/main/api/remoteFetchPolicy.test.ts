import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config } from '@shared/config/config'

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn()
}))

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: lookupMock
  },
  lookup: lookupMock
}))

import { parseAndValidateRemoteFetchRequest } from './remoteFetchPolicy'

const createConfig = (apiAddress = 'https://skills.example.com/agent'): Config =>
  ({
    ...DEFAULT_CONFIG,
    llm_config: {
      ...DEFAULT_CONFIG.llm_config,
      customSkills: [
        {
          id: 'agent-skill',
          category: 'Agents',
          skillName: 'Agent Skill',
          prompt: 'Handle externally.',
          type: 'agent',
          apiAddress
        }
      ]
    }
  }) as Config

describe('remoteFetchPolicy', () => {
  beforeEach(() => {
    lookupMock.mockReset()
  })

  it('allows configured HTTPS external agent endpoints on public DNS addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])

    const result = await parseAndValidateRemoteFetchRequest(
      {
        url: 'https://skills.example.com/agent',
        method: 'POST',
        timeoutMs: 2000,
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer token'
        },
        body: JSON.stringify({ messages: [] })
      },
      createConfig()
    )

    expect(result.parsedUrl.toString()).toBe('https://skills.example.com/agent')
    expect(result.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token'
    })
    expect(result.timeoutMs).toBe(2000)
    expect(result.resolvedAddress).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('rejects unconfigured endpoints even when they are public HTTPS URLs', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])

    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'https://other.example.com/agent',
          method: 'POST'
        },
        createConfig()
      )
    ).rejects.toThrow('configured external agent')
  })

  it('rejects plain HTTP endpoints', async () => {
    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'http://skills.example.com/agent',
          method: 'POST'
        },
        createConfig('http://skills.example.com/agent')
      )
    ).rejects.toThrow('https')
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('rejects local and private hosts before making a request', async () => {
    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'https://127.0.0.1/agent',
          method: 'POST'
        },
        createConfig('https://127.0.0.1/agent')
      )
    ).rejects.toThrow('public host')
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('rejects public hostnames that resolve to private addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }])

    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'https://skills.example.com/agent',
          method: 'POST'
        },
        createConfig()
      )
    ).rejects.toThrow('private or local address')
  })

  it('rejects header injection and hop-by-hop header overrides', async () => {
    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'https://skills.example.com/agent',
          method: 'POST',
          headers: {
            Host: 'attacker.example'
          }
        },
        createConfig()
      )
    ).rejects.toThrow('Host header')

    await expect(
      parseAndValidateRemoteFetchRequest(
        {
          url: 'https://skills.example.com/agent',
          method: 'POST',
          headers: {
            'X-Test': 'ok\r\nInjected: yes'
          }
        },
        createConfig()
      )
    ).rejects.toThrow('line breaks')
  })
})
