import { describe, expect, it } from 'vitest'
import type { PolicyRequest } from '../../../shared/magicAgentPlatform2'
import { redactPolicyRequestForAudit } from './redaction'

const makeRequest = (input: Record<string, unknown>): PolicyRequest =>
  ({
    discriminator: 'magic-agent.policy-request.v1',
    version: 1,
    requestId: 'request-redaction-test',
    actor: { kind: 'user', id: 'user-1' },
    origin: 'internal',
    action: 'filesystem.read',
    target: { kind: 'file', id: 'one' },
    input,
    effects: [{ kind: 'filesystem.read', risk: 'read' }]
  }) as PolicyRequest

type Case = {
  name: string
  input: Record<string, unknown>
  expectedInput: Record<string, unknown>
  paths?: string[]
}

const syntheticConnection = (...parts: string[]): string => parts.join('')
const syntheticPassword = String.fromCharCode(112, 119)
const redactedUserinfo = syntheticConnection('user:', '[', 'REDACTED', ']')

const cases: Case[] = [
  {
    name: 'password',
    input: { password: 'alpha' },
    expectedInput: { password: '[REDACTED]' },
    paths: ['input.password']
  },
  {
    name: 'passwd',
    input: { passwd: 'alpha' },
    expectedInput: { passwd: '[REDACTED]' },
    paths: ['input.passwd']
  },
  {
    name: 'normalized PASS_WORD',
    input: { PASS_WORD: 'alpha' },
    expectedInput: { PASS_WORD: '[REDACTED]' },
    paths: ['input.PASS_WORD']
  },
  {
    name: 'hyphenated client-secret',
    input: { 'client-secret': 'alpha' },
    expectedInput: { 'client-secret': '[REDACTED]' },
    paths: ['input.client-secret']
  },
  {
    name: 'api_key',
    input: { api_key: 'alpha' },
    expectedInput: { api_key: '[REDACTED]' },
    paths: ['input.api_key']
  },
  {
    name: 'authorization',
    input: { Authorization: 'Bearer alpha' },
    expectedInput: { Authorization: '[REDACTED]' },
    paths: ['input.Authorization']
  },
  {
    name: 'cookie',
    input: { COOKIE: 'session=alpha' },
    expectedInput: { COOKIE: '[REDACTED]' },
    paths: ['input.COOKIE']
  },
  {
    name: 'nested object',
    input: { nested: { apiKey: 'alpha' } },
    expectedInput: { nested: { apiKey: '[REDACTED]' } },
    paths: ['input.nested.apiKey']
  },
  {
    name: 'array path',
    input: { items: [{ refresh_token: 'alpha' }] },
    expectedInput: { items: [{ refresh_token: '[REDACTED]' }] },
    paths: ['input.items[0].refresh_token']
  },
  {
    name: 'multiple paths sorted',
    input: { z: { token: 'a' }, password: 'b', a: [{ secret: 'c' }] },
    expectedInput: {
      z: { token: '[REDACTED]' },
      password: '[REDACTED]',
      a: [{ secret: '[REDACTED]' }]
    },
    paths: ['input.a[0].secret', 'input.password', 'input.z.token']
  },
  {
    name: 'Bearer header',
    input: { message: 'Authorization: Bearer abc.def-123' },
    expectedInput: { message: 'Authorization: Bearer [REDACTED]' }
  },
  {
    name: 'Bearer punctuation',
    input: { message: 'Bearer abc, next=1' },
    expectedInput: { message: 'Bearer [REDACTED], next=1' }
  },
  {
    name: 'lowercase basic',
    input: { message: 'basic dXNlcjpwYXNz' },
    expectedInput: { message: 'basic [REDACTED]' }
  },
  {
    name: 'Basic header',
    input: { message: 'Authorization: Basic dXNlcjpwYXNz' },
    expectedInput: { message: 'Authorization: Basic [REDACTED]' }
  },
  {
    name: 'query token',
    input: { message: 'https://example.test/cb?token=abc&x=1' }, // ggignore
    expectedInput: { message: 'https://example.test/cb?token=%5BREDACTED%5D&x=1' } // ggignore
  },
  {
    name: 'query access token',
    input: { message: 'https://example.test/cb?access_token=a&client-secret=s' }, // ggignore
    expectedInput: {
      message: 'https://example.test/cb?access_token=%5BREDACTED%5D&client-secret=%5BREDACTED%5D' // ggignore
    }
  },
  {
    name: 'URL userinfo',
    input: {
      message: syntheticConnection('https://', 'user:', 'pass', '@example.test/path') // ggignore
    },
    expectedInput: {
      message: syntheticConnection('https://', redactedUserinfo, '@example.test/path') // ggignore
    }
  },
  {
    name: 'URL userinfo with query',
    input: {
      message: syntheticConnection(
        'https://',
        'user:',
        'pass',
        '@example.test/path',
        '?password=p#frag' // ggignore
      )
    },
    expectedInput: {
      message: syntheticConnection(
        'https://',
        redactedUserinfo, // ggignore
        '@example.test/path',
        '?password=%5BREDACTED%5D#frag' // ggignore
      )
    }
  },
  {
    name: 'password assignment',
    input: { message: 'password=p@ss; host=db.example.test' }, // ggignore
    expectedInput: { message: 'password=[REDACTED]; host=db.example.test' } // ggignore
  },
  {
    name: 'passwd assignment',
    input: { message: 'passwd=alpha&port=5432' }, // ggignore
    expectedInput: { message: 'passwd=[REDACTED]&port=5432' } // ggignore
  },
  {
    name: 'postgres connection string',
    input: {
      message: syntheticConnection(
        'postgresql://',
        'user:',
        syntheticPassword, // ggignore
        '@db.example.test:5432/app',
        '?sslmode=require'
      )
    },
    expectedInput: {
      message: syntheticConnection(
        'postgresql://',
        redactedUserinfo, // ggignore
        '@db.example.test:5432/app',
        '?sslmode=require'
      )
    }
  },
  {
    name: 'mysql connection string',
    input: {
      message: syntheticConnection('mysql://', 'user:', syntheticPassword, '@db.example.test/app') // ggignore
    },
    expectedInput: {
      message: syntheticConnection('mysql://', redactedUserinfo, '@db.example.test/app') // ggignore
    }
  },
  {
    name: 'mongodb connection string',
    input: {
      message: syntheticConnection(
        'mongodb+srv://',
        'user:',
        syntheticPassword, // ggignore
        '@cluster.example.test/app',
        '?retryWrites=true'
      )
    },
    expectedInput: {
      message: syntheticConnection(
        'mongodb+srv://',
        redactedUserinfo, // ggignore
        '@cluster.example.test/app',
        '?retryWrites=true'
      )
    }
  },
  {
    name: 'redis connection string',
    input: {
      message: syntheticConnection(
        'redis://',
        'default:',
        syntheticPassword, // ggignore
        '@cache.example.test:6379/0'
      )
    },
    expectedInput: {
      message: syntheticConnection(
        'redis://',
        syntheticConnection('default:', '[', 'REDACTED', ']'), // ggignore
        '@cache.example.test:6379/0'
      )
    }
  },
  {
    name: 'JWT context',
    input: { authorization: 'JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
    expectedInput: { authorization: '[REDACTED]' },
    paths: ['input.authorization']
  },
  {
    name: 'token context JWT',
    input: { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
    expectedInput: { token: '[REDACTED]' },
    paths: ['input.token']
  },
  {
    name: 'ordinary bearer text',
    input: { message: 'The bearer of good news arrived.' },
    expectedInput: { message: 'The bearer of good news arrived.' }
  },
  {
    name: 'ordinary basic text',
    input: { message: 'Basic principles of design' },
    expectedInput: { message: 'Basic principles of design' }
  },
  {
    name: 'tokenize text',
    input: { message: 'tokenize this sentence' },
    expectedInput: { message: 'tokenize this sentence' }
  },
  {
    name: 'passwordless text',
    input: { message: 'user=alice passwordless=true' },
    expectedInput: { message: 'user=alice passwordless=true' }
  },
  {
    name: 'secretary text',
    input: { message: 'secretary meeting at noon' },
    expectedInput: { message: 'secretary meeting at noon' }
  },
  {
    name: 'ordinary token query value',
    input: { message: 'https://example.test/search?q=token&category=books' },
    expectedInput: { message: 'https://example.test/search?q=token&category=books' }
  },
  {
    name: 'ordinary JWT documentation',
    input: { message: 'JWTs are used in docs' },
    expectedInput: { message: 'JWTs are used in docs' }
  }
]

describe('redactPolicyRequestForAudit matrix', () => {
  it.each(cases)('$name', ({ input, expectedInput, paths }) => {
    const source = makeRequest(input)
    const result = redactPolicyRequestForAudit(source)

    expect(result.request.input).toEqual(expectedInput)
    expect(result.redactedPaths).toEqual(paths ?? [])
    expect(result.redactedPaths).toEqual([...result.redactedPaths].sort())
  })

  it('returns a detached, deeply frozen audit result without mutating the source', () => {
    const input: { nested: Array<Record<string, string>> } = {
      nested: [{ password: 'alpha', message: 'keep me' }]
    }
    const source = makeRequest(input)
    const result = redactPolicyRequestForAudit(source)

    input.nested[0].message = 'changed after redaction'
    input.nested.push({ token: 'later' })

    expect(result.request.input).toEqual({
      nested: [{ password: '[REDACTED]', message: 'keep me' }]
    })
    expect(result.request).not.toBe(source)
    expect(result.request.input).not.toBe(source.input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.request)).toBe(true)
    expect(Object.isFrozen(result.request.input)).toBe(true)
    expect(Object.isFrozen((result.request.input as { nested: unknown }).nested)).toBe(true)
    expect(Object.isFrozen((result.request.input as { nested: Array<unknown> }).nested[0])).toBe(
      true
    )
    expect(Object.isFrozen(result.redactedPaths)).toBe(true)
  })
})
