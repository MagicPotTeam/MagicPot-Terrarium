import { z } from 'zod'

const label = z.string().trim().min(1).max(128)
const safeName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
export const executionPreparationSchema = z.discriminatedUnion('backend', [
  z.object({ backend: z.literal('ssh'), label,
    host: z.string().max(253).regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/),
    port: z.number().int().min(1).max(65535), user: safeName,
    hostKeySha256: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/)
  }).strict(),
  z.object({ backend: z.literal('docker'), label, context: safeName, container: safeName }).strict(),
  z.object({ backend: z.literal('database'), label,
    relativePath: z.string().min(1).max(256).refine(value =>
      !value.includes('\\') && !value.includes(':') && !value.includes('\0') &&
      value.split('/').every(part => !!part && part !== '.' && part !== '..') && /\.(?:db|sqlite|sqlite3)$/i.test(value)),
    mode: z.literal('read-only')
  }).strict()
])
export type ExecutionPreparation = z.infer<typeof executionPreparationSchema>

/** Offline declaration only: it contains no credentials, commands, grants or connection code. */
export function createExecutionPreparation(value: unknown) {
  return {
    format: 'magicpot-execution-preparation', version: 1,
    target: executionPreparationSchema.parse(value),
    executionEnabled: false, verified: false, grantsPermission: false
  } as const
}
