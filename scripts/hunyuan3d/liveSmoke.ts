import fs from 'node:fs/promises'
import path from 'node:path'
import * as clientModule from '../../packages/app/src/main/llmProxy/hunyuan3dClient.ts'
import * as cosModule from '../../packages/app/src/main/llmProxy/hunyuan3dCos.ts'
import type { Config } from '../../packages/app/src/shared/config/config'
import {
  getProSmokeConfig,
  getRapidSmokeConfig,
  normalizeSmokePrefix,
  parseHunyuanLiveSmokeMode
} from './liveSmokeShared'

type Hunyuan3DClientCtor = new (
  apiKey: string,
  baseURL?: string,
  secretId?: string,
  secretKey?: string,
  region?: string
) => {
  generateFromMessages: (
    messages: Array<{ role: string; content: string }>,
    mode?: string,
    options?: Record<string, unknown>
  ) => Promise<string>
}

type HunyuanCosModule = {
  uploadBufferedHy3dModel: (
    credentials: { secretId: string; secretKey: string },
    cosConfig: { bucket: string; region: string; keyPrefix: string },
    fileName: string,
    buffer: Buffer
  ) => Promise<{ key: string; url: string }>
  signHy3dCosModel: (
    credentials: { secretId: string; secretKey: string },
    cosConfig: { bucket: string; region: string; keyPrefix: string },
    key: string
  ) => { url: string; expiresAt: string }
  clearHy3dCosPrefix: (
    credentials: { secretId: string; secretKey: string },
    cosConfig: { bucket: string; region: string; keyPrefix: string }
  ) => Promise<{ matchedCount: number; deletedCount: number; errorCount: number }>
}

const { Hunyuan3DClient } = (
  (clientModule as { Hunyuan3DClient?: Hunyuan3DClientCtor }).Hunyuan3DClient
    ? clientModule
    : (clientModule as { default?: { Hunyuan3DClient: Hunyuan3DClientCtor } }).default!
) as { Hunyuan3DClient: Hunyuan3DClientCtor }

const { uploadBufferedHy3dModel, signHy3dCosModel, clearHy3dCosPrefix } = (
  (cosModule as { uploadBufferedHy3dModel?: HunyuanCosModule['uploadBufferedHy3dModel'] })
    .uploadBufferedHy3dModel
    ? cosModule
    : (cosModule as { default?: HunyuanCosModule }).default!
) as HunyuanCosModule

const DEFAULT_CONFIG_PATH = path.join(process.cwd(), '.aiengineelectron-dev', 'config.json')
const RAPID_PROMPT = 'a simple white ceramic mug with a smooth surface'
const PRO_PROMPT = 'a simple white ceramic mug with a smooth surface'
const MAX_RAPID_SMOKE_ATTEMPTS = 3
const RAPID_SMOKE_RETRY_DELAY_MS = 5000

const readConfig = async (): Promise<Partial<Config>> => {
  const configPath = process.env.HUNYUAN3D_CONFIG_PATH || DEFAULT_CONFIG_PATH
  const content = await fs.readFile(configPath, 'utf8')
  return JSON.parse(content) as Partial<Config>
}

const extractMarkdownUrl = (markdownLink: string): string => {
  const match = markdownLink.match(/\(([^)]+)\)/)
  if (!match?.[1]) {
    throw new Error('Hunyuan3D result did not contain a markdown URL.')
  }
  return match[1]
}

const fetchRange = async (
  url: string
): Promise<{ status: number; ok: boolean; bytesRead: number }> => {
  const response = await fetch(url, {
    headers: {
      Range: 'bytes=0-31'
    }
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    ok: response.ok,
    bytesRead: buffer.length
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const isTransientTencentSmokeError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error || '')
  return (
    message.includes('FailedOperation.InnerError') ||
    message.includes('Internal error') ||
    message.includes('SystemError') ||
    message.includes('资源不足') ||
    message.toLowerCase().includes('resource')
  )
}

const runSmokeWithRetries = async <T>(
  label: string,
  run: () => Promise<T>
): Promise<{ attempts: number; elapsedMs: number; result: T }> => {
  const startedAt = Date.now()

  for (let attempt = 1; attempt <= MAX_RAPID_SMOKE_ATTEMPTS; attempt += 1) {
    try {
      return {
        attempts: attempt,
        elapsedMs: Date.now() - startedAt,
        result: await run()
      }
    } catch (error) {
      const transient = isTransientTencentSmokeError(error)
      if (attempt >= MAX_RAPID_SMOKE_ATTEMPTS || !transient) {
        const finalError =
          error instanceof Error ? error : new Error(String(error || `${label} live smoke failed.`))
        ;(
          finalError as Error & {
            attempts?: number
            transient?: boolean
          }
        ).attempts = attempt
        ;(
          finalError as Error & {
            attempts?: number
            transient?: boolean
          }
        ).transient = transient
        throw finalError
      }

      console.warn(
        `[hunyuan3d live smoke] ${label} attempt ${attempt}/${MAX_RAPID_SMOKE_ATTEMPTS} failed with a transient Tencent error, retrying...`
      )
      await delay(RAPID_SMOKE_RETRY_DELAY_MS)
    }
  }

  throw new Error(`${label} live smoke exhausted all retry attempts.`)
}

const main = async () => {
  const rootConfig = await readConfig()
  const smokeMode = parseHunyuanLiveSmokeMode(process.env.HUNYUAN3D_SMOKE_MODE)
  const result: Record<string, unknown> = {
    ok: true,
    mode: smokeMode
  }

  if (smokeMode === 'rapid' || smokeMode === 'all') {
    const rapidConfig = getRapidSmokeConfig(rootConfig)
    const rapidClient = new Hunyuan3DClient(
      '',
      '',
      rapidConfig.credentials.secretId,
      rapidConfig.credentials.secretKey,
      rapidConfig.apiRegion
    )

    const rapid = await runSmokeWithRetries('rapid', () =>
      rapidClient.generateFromMessages(
        [{ role: 'user', content: RAPID_PROMPT }],
        'SubmitHunyuanTo3DRapidJob',
        { TargetFormat: 'GLB' }
      )
    )
    const rapidUrl = extractMarkdownUrl(rapid.result)
    const rapidFetch = await fetchRange(rapidUrl)

    const smokePrefix = `${normalizeSmokePrefix(rapidConfig.cos.keyPrefix)}/smoke/${Date.now()}`
    const cosConfig = {
      bucket: rapidConfig.cos.bucket,
      region: rapidConfig.cos.region,
      keyPrefix: smokePrefix
    }
    const smokeModel = ['o SmokeCube', 'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'f 1 2 3', ''].join('\n')

    const uploaded = await uploadBufferedHy3dModel(
      rapidConfig.credentials,
      cosConfig,
      'smoke.obj',
      Buffer.from(smokeModel, 'utf8')
    )
    const signed = signHy3dCosModel(rapidConfig.credentials, cosConfig, uploaded.key)
    const signedFetch = await fetchRange(signed.url)
    const cleanup = await clearHy3dCosPrefix(rapidConfig.credentials, cosConfig)

    result.rapid = {
      mode: 'SubmitHunyuanTo3DRapidJob',
      region: rapidConfig.apiRegion,
      attempts: rapid.attempts,
      elapsedSeconds: Math.round(rapid.elapsedMs / 1000),
      resultHost: new URL(rapidUrl).host,
      resultPathSuffix: new URL(rapidUrl).pathname.split('/').slice(-2).join('/'),
      rangeFetch: rapidFetch
    }
    result.cos = {
      smokePrefix,
      uploadedKey: uploaded.key,
      signedFetch,
      cleanup
    }
  }

  if (smokeMode === 'pro' || smokeMode === 'all') {
    const proConfig = getProSmokeConfig(rootConfig)
    const proClient = new Hunyuan3DClient(proConfig.apiKey, proConfig.baseURL)

    const pro = await runSmokeWithRetries('pro', () =>
      proClient.generateFromMessages(
        [{ role: 'user', content: PRO_PROMPT }],
        'SubmitHunyuanTo3DProJob',
        { Model: '3.1', GenerateType: 'Normal' }
      )
    )
    const proUrl = extractMarkdownUrl(pro.result)
    const proFetch = await fetchRange(proUrl)

    result.pro = {
      mode: 'SubmitHunyuanTo3DProJob',
      profileId: proConfig.profileId,
      modelName: proConfig.modelName,
      baseURL: proConfig.baseURL,
      attempts: pro.attempts,
      elapsedSeconds: Math.round(pro.elapsedMs / 1000),
      resultHost: new URL(proUrl).host,
      resultPathSuffix: new URL(proUrl).pathname.split('/').slice(-2).join('/'),
      rangeFetch: proFetch
    }
  }

  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        attempts:
          error &&
          typeof error === 'object' &&
          'attempts' in error &&
          typeof (error as { attempts?: unknown }).attempts === 'number'
            ? (error as { attempts: number }).attempts
            : undefined,
        transient:
          error &&
          typeof error === 'object' &&
          'transient' in error &&
          typeof (error as { transient?: unknown }).transient === 'boolean'
            ? (error as { transient: boolean }).transient
            : undefined
      },
      null,
      2
    )
  )
  process.exitCode = 1
})
