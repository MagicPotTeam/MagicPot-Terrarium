import { Buffer } from 'node:buffer'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { z } from 'zod'
import { ServiceValidationError } from './api/apiUtils/serviceValidation'
import {
  PROJECT_COMPARISON_CHAT_PATH,
  PROJECT_COMPARISON_PROFILES_PATH,
  PROJECT_COMPARISON_PROTOCOL,
  parseProjectComparisonValue,
  projectComparisonChatRequestSchema,
  projectComparisonChatResponseSchema,
  projectComparisonProfilesResponseSchema,
  type ProjectComparisonChatRequest
} from './projectComparisonProtocol'

const revision = '0123456789abcdef'.repeat(4)
const profile = {
  id: 'local::provider::model',
  model_name: 'Analysis model',
  configurationRevision: revision
}
const profiles = (overrides: Record<string, unknown> = {}) => ({
  protocol: PROJECT_COMPARISON_PROTOCOL,
  profiles: [{ ...profile, ...overrides }]
})
const request = (content = 'Compare these projects.') => ({
  protocol: PROJECT_COMPARISON_PROTOCOL,
  profileId: profile.id,
  expectedProfileRevision: revision,
  messages: [
    { role: 'system' as const, content: 'Analyze once.' },
    { role: 'user' as const, content }
  ]
})
const response = (overrides: Record<string, unknown> = {}) => ({
  protocol: PROJECT_COMPARISON_PROTOCOL,
  result: { content: 'Comparison complete.', ...overrides }
})
const bodyBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8')
const forbiddenFields = [
  'unknown',
  'route',
  'tools',
  'skillruntime',
  'skillRuntime',
  'attachments',
  'sessionURL',
  'sessionUrl',
  'conversationId',
  'remoteUrl',
  'remoteURL',
  'url',
  'base_url',
  'api_key'
]

describe('project comparison protocol', () => {
  it('exports the version and dedicated one-shot HTTP paths', () => {
    expect(PROJECT_COMPARISON_PROTOCOL).toBe(1)
    expect(PROJECT_COMPARISON_PROFILES_PATH).toBe('/api/project-comparison/profiles')
    expect(PROJECT_COMPARISON_CHAT_PATH).toBe('/api/project-comparison/chat')
  })

  it('accepts composite profile IDs and applies typed request defaults without mutation', () => {
    expect(
      parseProjectComparisonValue(projectComparisonProfilesResponseSchema, profiles())
    ).toEqual(profiles())
    const input = request()
    const parsed = parseProjectComparisonValue(projectComparisonChatRequestSchema, input)
    expectTypeOf(parsed).toEqualTypeOf<ProjectComparisonChatRequest>()
    expectTypeOf(parsed.temperature).toEqualTypeOf<number>()
    expect(parsed).toEqual({ ...input, temperature: 0.2, maxOutputTokens: 1200 })
    expect(input).not.toHaveProperty('temperature')
    expect(input).not.toHaveProperty('maxOutputTokens')
    expect(parseProjectComparisonValue(projectComparisonChatResponseSchema, response())).toEqual(
      response()
    )
  })

  it.each([undefined, null, 0, 2, '1'])(
    'rejects missing, invalid or future protocol %s',
    (protocol) => {
      expect(
        projectComparisonProfilesResponseSchema.safeParse({ ...profiles(), protocol }).success
      ).toBe(false)
      expect(projectComparisonChatRequestSchema.safeParse({ ...request(), protocol }).success).toBe(
        false
      )
      expect(
        projectComparisonChatResponseSchema.safeParse({ ...response(), protocol }).success
      ).toBe(false)
    }
  )

  it.each([
    undefined,
    '',
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    `${revision}\n`
  ])(
    'rejects missing or malformed revision %# in both profiles and requests',
    (invalidRevision) => {
      expect(
        projectComparisonProfilesResponseSchema.safeParse(
          profiles({ configurationRevision: invalidRevision })
        ).success
      ).toBe(false)
      expect(
        projectComparisonChatRequestSchema.safeParse({
          ...request(),
          expectedProfileRevision: invalidRevision
        }).success
      ).toBe(false)
    }
  )

  it.each([
    '',
    ' ',
    ' local',
    'local ',
    'two words',
    'a\tb',
    'a\nb',
    'a\u0000b',
    'a\u007fb',
    'a\u0085b',
    'a\u200bb',
    'a\u00a0b',
    'x'.repeat(513)
  ])('rejects empty, whitespace, control or oversized profile IDs %#', (id) => {
    expect(projectComparisonProfilesResponseSchema.safeParse(profiles({ id })).success).toBe(false)
    expect(
      projectComparisonChatRequestSchema.safeParse({ ...request(), profileId: id }).success
    ).toBe(false)
  })

  it('accepts bounded profile metadata, empty lists and exactly 256 profiles', () => {
    const input = profiles({
      id: 'x'.repeat(512),
      model_name: 'm'.repeat(160),
      deployment: 'api',
      context_budget_tokens: 0.5,
      context_window_tokens: 1_000_000_000
    })
    expect(projectComparisonProfilesResponseSchema.parse(input)).toEqual(input)
    expect(
      projectComparisonProfilesResponseSchema.safeParse(profiles({ deployment: 'local' })).success
    ).toBe(true)
    expect(
      projectComparisonProfilesResponseSchema.safeParse({ protocol: 1, profiles: [] }).success
    ).toBe(true)
    expect(
      projectComparisonProfilesResponseSchema.safeParse({
        protocol: 1,
        profiles: Array(256).fill(profile)
      }).success
    ).toBe(true)
    expect(
      projectComparisonProfilesResponseSchema.safeParse({
        protocol: 1,
        profiles: Array(257).fill(profile)
      }).success
    ).toBe(false)
    expect(
      projectComparisonProfilesResponseSchema.safeParse(profiles({ model_name: 'm'.repeat(161) }))
        .success
    ).toBe(false)
    expect(
      projectComparisonProfilesResponseSchema.safeParse(profiles({ deployment: 'cloud' })).success
    ).toBe(false)
    expect(
      projectComparisonProfilesResponseSchema.safeParse(profiles({ model_use: 'unknown' })).success
    ).toBe(false)
  })

  it.each([
    'default',
    'chat',
    'agent',
    'multimodal',
    'reasoning',
    'coding',
    'vision',
    'ocr',
    'image',
    'video'
  ])('accepts model use %s', (model_use) => {
    expect(projectComparisonProfilesResponseSchema.safeParse(profiles({ model_use })).success).toBe(
      true
    )
  })

  it.each([0, -1, Infinity, -Infinity, NaN, 1_000_000_001, '1024', null])(
    'rejects invalid context token metadata %#',
    (value) => {
      for (const key of ['context_budget_tokens', 'context_window_tokens']) {
        expect(
          projectComparisonProfilesResponseSchema.safeParse(profiles({ [key]: value })).success
        ).toBe(false)
      }
    }
  )

  it.each(forbiddenFields)('rejects unknown field %s at every object boundary', (key) => {
    const extra = { [key]: 'https://example.invalid/not-fetched' }
    expect(
      projectComparisonProfilesResponseSchema.safeParse({ ...profiles(), ...extra }).success
    ).toBe(false)
    expect(projectComparisonProfilesResponseSchema.safeParse(profiles(extra)).success).toBe(false)
    expect(projectComparisonChatRequestSchema.safeParse({ ...request(), ...extra }).success).toBe(
      false
    )
    expect(
      projectComparisonChatRequestSchema.safeParse({
        ...request(),
        messages: [{ ...request().messages[0], ...extra }, request().messages[1]]
      }).success
    ).toBe(false)
    expect(projectComparisonChatResponseSchema.safeParse({ ...response(), ...extra }).success).toBe(
      false
    )
    expect(projectComparisonChatResponseSchema.safeParse(response(extra)).success).toBe(false)
    expect(projectComparisonChatResponseSchema.safeParse(response({ usage: extra })).success).toBe(
      false
    )
  })

  it('accepts only two to four text-only system/user messages', () => {
    for (const count of [0, 1, 2, 3, 4, 5]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({
          ...request(),
          messages: Array(count).fill({ role: 'user', content: 'Text' })
        }).success
      ).toBe(count >= 2 && count <= 4)
    }
    for (const role of ['assistant', 'tool', 'developer', '', undefined]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({
          ...request(),
          messages: [{ role, content: 'Text' }, request().messages[1]]
        }).success
      ).toBe(false)
    }
  })

  it.each([
    new Uint8Array([1, 2, 3]),
    { type: 'Buffer', data: [1, 2, 3] },
    [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }],
    null
  ])('rejects binary and structured content or attachments %#', (binary) => {
    expect(
      projectComparisonChatRequestSchema.safeParse({
        ...request(),
        messages: [{ role: 'system', content: binary }, request().messages[1]]
      }).success
    ).toBe(false)
    expect(
      projectComparisonChatRequestSchema.safeParse({ ...request(), attachments: binary }).success
    ).toBe(false)
    expect(
      projectComparisonChatRequestSchema.safeParse({
        ...request(),
        messages: [{ ...request().messages[0], attachments: binary }, request().messages[1]]
      }).success
    ).toBe(false)
    expect(
      projectComparisonChatResponseSchema.safeParse(response({ content: binary })).success
    ).toBe(false)
    expect(
      projectComparisonChatResponseSchema.safeParse(response({ attachments: binary })).success
    ).toBe(false)
  })

  it('enforces temperature and integer output-token limits without coercion', () => {
    for (const temperature of [0, 0.2, 1]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({ ...request(), temperature }).success
      ).toBe(true)
    }
    for (const temperature of [-0.1, 1.1, Infinity, NaN, '0.2', null]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({ ...request(), temperature }).success
      ).toBe(false)
    }
    for (const maxOutputTokens of [1, 1200]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({ ...request(), maxOutputTokens }).success
      ).toBe(true)
    }
    for (const maxOutputTokens of [0, -1, 1.5, 1201, Infinity, NaN, '1200', null]) {
      expect(
        projectComparisonChatRequestSchema.safeParse({ ...request(), maxOutputTokens }).success
      ).toBe(false)
    }
  })

  it.each(['x', 'é', '界', '😀', '\n', '"', '\\', '\ud800'])(
    'caps the entire JSON request at exactly 48 KiB including UTF-8 and escaping %#',
    (character) => {
      const limit = 48 * 1024
      const available = limit - bodyBytes(request(''))
      const characterBytes = bodyBytes(character) - 2
      const content =
        character.repeat(Math.floor(available / characterBytes)) +
        'x'.repeat(available % characterBytes)
      const input = request(content)
      expect(bodyBytes(input)).toBe(limit)
      expect(projectComparisonChatRequestSchema.safeParse(input).success).toBe(true)
      expect(projectComparisonChatRequestSchema.safeParse(request(`${content}x`)).success).toBe(
        false
      )
    }
  )

  it('rejects per-message UTF-8 overflow and aggregate overflow across messages', () => {
    expect(
      projectComparisonChatRequestSchema.safeParse(request('界'.repeat(16 * 1024 + 1))).success
    ).toBe(false)
    const messages = [
      { role: 'system', content: '😀'.repeat(7 * 1024) },
      { role: 'user', content: '😀'.repeat(7 * 1024) }
    ]
    expect(messages.every(({ content }) => Buffer.byteLength(content, 'utf8') < 48 * 1024)).toBe(
      true
    )
    expect(projectComparisonChatRequestSchema.safeParse({ ...request(), messages }).success).toBe(
      false
    )
  })

  it.each(['x', 'é', '界', '😀', '\ud800'])(
    'requires nonempty response text of at most 16 KiB of actual UTF-8 %#',
    (character) => {
      const limit = 16 * 1024
      const width = Buffer.byteLength(character, 'utf8')
      const content = character.repeat(Math.floor(limit / width)) + 'x'.repeat(limit % width)
      expect(Buffer.byteLength(content, 'utf8')).toBe(limit)
      expect(projectComparisonChatResponseSchema.safeParse(response({ content })).success).toBe(
        true
      )
      expect(
        projectComparisonChatResponseSchema.safeParse(response({ content: `${content}x` })).success
      ).toBe(false)
      expect(projectComparisonChatResponseSchema.safeParse(response({ content: '' })).success).toBe(
        false
      )
    }
  )

  it('allows only stop or length finish reasons and optional safe-integer usage', () => {
    for (const finishReason of ['stop', 'length', undefined]) {
      expect(
        projectComparisonChatResponseSchema.safeParse(response({ finishReason })).success
      ).toBe(true)
    }
    for (const finishReason of ['tool_call', 'cancelled', 'error', '', null]) {
      expect(
        projectComparisonChatResponseSchema.safeParse(response({ finishReason })).success
      ).toBe(false)
    }
    expect(projectComparisonChatResponseSchema.safeParse(response({ usage: {} })).success).toBe(
      true
    )
    for (const key of [
      'promptTokens',
      'inputTextTokens',
      'inputImageTokens',
      'completionTokens',
      'totalTokens'
    ]) {
      for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
        expect(
          projectComparisonChatResponseSchema.safeParse(response({ usage: { [key]: value } }))
            .success
        ).toBe(true)
      }
      for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
        expect(
          projectComparisonChatResponseSchema.safeParse(response({ usage: { [key]: value } }))
            .success
        ).toBe(false)
      }
    }
  })

  it('returns only a fixed ServiceValidationError without raw secrets, issues or causes', () => {
    const secret = 'synthetic-credential-must-not-leak'
    const assertSafeError = (parse: () => unknown): void => {
      let caught: unknown
      try {
        parse()
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ServiceValidationError)
      const error = caught as ServiceValidationError
      expect(error.message).toBe('Invalid project comparison value')
      expect(error.code).toBe('VALIDATION_ERROR')
      expect(error.issues).toEqual([])
      expect(error.cause).toBeUndefined()
      expect(error.payload).toEqual({ label: 'project comparison value', issues: [] })
      expect(JSON.stringify(error)).not.toContain(secret)
      expect(String(error)).not.toContain(secret)
      expect(error.stack).not.toContain(secret)
    }
    assertSafeError(() =>
      parseProjectComparisonValue(projectComparisonChatRequestSchema, {
        ...request(secret),
        [secret]: secret
      })
    )
    assertSafeError(() =>
      parseProjectComparisonValue(
        projectComparisonProfilesResponseSchema,
        profiles({ model_use: secret })
      )
    )
    assertSafeError(() =>
      parseProjectComparisonValue(
        projectComparisonChatResponseSchema,
        response({ finishReason: secret })
      )
    )
    assertSafeError(() =>
      parseProjectComparisonValue(
        z.string().refine(() => false, secret),
        secret
      )
    )
    assertSafeError(() =>
      parseProjectComparisonValue(
        z.string().transform(() => {
          throw new Error(secret)
        }),
        secret
      )
    )
    const cyclic: Record<string, unknown> = { ...request() }
    cyclic.cycle = cyclic
    assertSafeError(() => parseProjectComparisonValue(projectComparisonChatRequestSchema, cyclic))
  })

  it('supports schema defaults with differing input and output types', () => {
    const parsed = parseProjectComparisonValue(z.number().default(7), undefined)
    expectTypeOf(parsed).toEqualTypeOf<number>()
    expect(parsed).toBe(7)
  })
})
