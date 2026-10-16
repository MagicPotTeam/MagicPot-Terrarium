import { z } from 'zod'
import { ServiceValidationError } from './api/apiUtils/serviceValidation'

export const PROJECT_COMPARISON_PROTOCOL = 1
export const PROJECT_COMPARISON_PROFILES_PATH = '/api/project-comparison/profiles'
export const PROJECT_COMPARISON_CHAT_PATH = '/api/project-comparison/chat'

const MAX_REQUEST_BYTES = 48 * 1024
const MAX_RESULT_BYTES = 16 * 1024
const encoder = new TextEncoder()

const fitsUtf8Budget = (value: string, maxBytes: number): boolean =>
  value.length <= maxBytes && encoder.encode(value).byteLength <= maxBytes

const profileIdSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !/[\s\p{Cc}\p{Cf}]/u.test(value), 'Invalid profile identifier')
const revisionSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/)
const contextTokensSchema = z.number().finite().positive().max(1_000_000_000).optional()

const profileSchema = z
  .object({
    id: profileIdSchema,
    model_name: z.string().max(160),
    configurationRevision: revisionSchema,
    model_use: z
      .enum([
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
      ])
      .optional(),
    deployment: z.enum(['local', 'api']).optional(),
    context_budget_tokens: contextTokensSchema,
    context_window_tokens: contextTokensSchema
  })
  .strict()

export const projectComparisonProfilesResponseSchema = z
  .object({
    protocol: z.literal(PROJECT_COMPARISON_PROTOCOL),
    profiles: z.array(profileSchema).max(256)
  })
  .strict()

// Measure JSON framing and escaping before defaults are applied. The HTTP reader must
// also cap raw body bytes before parsing, since whitespace/escape spelling is lost here.
export const projectComparisonChatRequestSchema = z
  .unknown()
  .refine((value) => {
    try {
      const body = JSON.stringify(value)
      return typeof body === 'string' && fitsUtf8Budget(body, MAX_REQUEST_BYTES)
    } catch {
      return false
    }
  }, 'Invalid project comparison request body')
  .pipe(
    z
      .object({
        protocol: z.literal(PROJECT_COMPARISON_PROTOCOL),
        profileId: profileIdSchema,
        expectedProfileRevision: revisionSchema,
        messages: z
          .array(
            z
              .object({
                role: z.enum(['system', 'user']),
                content: z
                  .string()
                  .refine(
                    (value) => fitsUtf8Budget(value, MAX_REQUEST_BYTES),
                    'Text exceeds UTF-8 byte budget'
                  )
              })
              .strict()
          )
          .min(2)
          .max(4),
        temperature: z.number().finite().min(0).max(1).default(0.2),
        maxOutputTokens: z.number().int().min(1).max(1200).default(1200)
      })
      .strict()
  )

const usageTokensSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()

export const projectComparisonChatResponseSchema = z
  .object({
    protocol: z.literal(PROJECT_COMPARISON_PROTOCOL),
    result: z
      .object({
        content: z
          .string()
          .min(1)
          .refine(
            (value) => fitsUtf8Budget(value, MAX_RESULT_BYTES),
            'Text exceeds UTF-8 byte budget'
          ),
        finishReason: z.enum(['stop', 'length']).optional(),
        usage: z
          .object({
            promptTokens: usageTokensSchema,
            inputTextTokens: usageTokensSchema,
            inputImageTokens: usageTokensSchema,
            completionTokens: usageTokensSchema,
            totalTokens: usageTokensSchema
          })
          .strict()
          .optional()
      })
      .strict()
  })
  .strict()

export type ProjectComparisonProfilesResponse = z.infer<
  typeof projectComparisonProfilesResponseSchema
>
export type ProjectComparisonProfile = ProjectComparisonProfilesResponse['profiles'][number]
export type ProjectComparisonChatRequest = z.infer<typeof projectComparisonChatRequestSchema>
export type ProjectComparisonChatResponse = z.infer<typeof projectComparisonChatResponseSchema>

export function parseProjectComparisonValue<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown
): z.output<Schema> {
  try {
    return schema.parse(value)
  } catch {
    // Never forward Zod issues or a cause: unknown keys and enum values can contain secrets.
    throw new ServiceValidationError('project comparison value', undefined, [])
  }
}
