import { z } from 'zod'
export const sshBashConfigSchema = z.object({
  host: z.string().trim().min(1).max(253), port: z.number().int().min(1).max(65535).default(22), user: z.string().min(1).max(256),
  key_filename: z.string().min(1).max(4096).optional(), password: z.string().max(4096).optional(),
  known_hosts_policy: z.enum(['auto_add','reject','warn']).default('auto_add'),
  keep_alive_seconds: z.number().int().min(0).max(3600).default(30),
  default_timeout_seconds: z.number().finite().min(0).max(120).default(120),
  max_result_size_chars: z.number().int().min(1).max(200000).default(200000)
}).strict()
