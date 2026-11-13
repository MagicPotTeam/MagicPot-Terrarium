import { z } from 'zod'
export const dockerBashConfigSchema = z.object({
  image: z.string().trim().min(1).max(256).default('python:3.13-slim'),
  volumes: z.array(z.string().min(1).max(2048)).max(32).default([]),
  working_dir: z.string().min(1).max(1024).default('/workspace'),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192)).default({}),
  network_mode: z.string().min(1).max(256).default('bridge'),
  auto_remove: z.boolean().default(true), name_prefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/).default('kt-bash-'),
  default_timeout_seconds: z.number().finite().min(0).max(120).default(120),
  max_result_size_chars: z.number().int().min(1).max(200000).default(200000),
  socketPath: z.string().min(1).max(2048).optional()
}).strict()
