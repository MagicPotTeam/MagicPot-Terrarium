import { z } from 'zod'
import { ServiceValidationError } from '../api/apiUtils/serviceValidation'
import {
  canonicalFigPluginJson,
  canonicalizeFigPluginPath,
  FigPluginManifestSchema,
  FigPluginSafeRelativePathSchema,
  type FigPluginManifest
} from './manifest'

export const FIGPLUGIN_PACKAGE_FORMAT = 'magicpot.figplugin.package.v1' as const
export const MAX_ENVELOPE_BYTES = 12 * 1024 * 1024
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024
export const MAX_FILES = 64

const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// Flat repetition avoids regexp stack growth on MiB-sized strings. Unlike $, the
// final assertion cannot accept a trailing newline.
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}(?![\s\S])/

const base64ByteLength = (value: string): number =>
  (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)

const isCanonicalBase64 = (value: string): boolean => {
  if (!value.length || value.length > MAX_BASE64_CHARS || value.length % 4 !== 0) return false
  if (!BASE64_PATTERN.test(value)) return false

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const lastSextet = BASE64_ALPHABET.indexOf(value[value.length - padding - 1])
  return (
    (padding !== 2 || (lastSextet & 15) === 0) &&
    (padding !== 1 || (lastSextet & 3) === 0) &&
    base64ByteLength(value) <= MAX_FILE_BYTES
  )
}

const FigPluginPackageFileSchema = z
  .object({
    path: z
      .string()
      .refine((value) => !/[^A-Za-z0-9._/-]/.test(value), 'path must contain only safe ASCII')
      .pipe(FigPluginSafeRelativePathSchema),
    bytes: z.number().int().min(1).max(MAX_FILE_BYTES),
    sha256: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    contentBase64: z.string().refine(isCanonicalBase64, 'content must be bounded canonical base64')
  })
  .strict()
  .superRefine((file, context) => {
    if (base64ByteLength(file.contentBase64) !== file.bytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['bytes'],
        message: 'declared bytes must match encoded content'
      })
    }
  })

/**
 * Shape validation only; no content is decoded or executed. Main must verify each
 * content hash, provenance.artifactSha256 against the canonical index, and the
 * signature using a separately trusted public key resolved by signature.keyId.
 */
export const FigPluginPackageSchema = z
  .object({
    format: z.literal(FIGPLUGIN_PACKAGE_FORMAT),
    manifest: FigPluginManifestSchema.refine(
      (manifest): manifest is FigPluginManifest & { entryPath: string } =>
        manifest.entryPath !== undefined,
      { path: ['entryPath'], message: 'package entryPath is required' }
    ),
    files: z.array(FigPluginPackageFileSchema).min(1).max(MAX_FILES)
  })
  .strict()
  .superRefine((pkg, context) => {
    const issue = (path: (string | number)[], message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path, message })
    }
    let declaredBytes = 0
    let contentBytes = 0
    const canonicalPaths = new Set<string>()
    const filesByPath = new Map<string, (typeof pkg.files)[number]>()
    for (const [index, file] of pkg.files.entries()) {
      declaredBytes += file.bytes
      contentBytes += base64ByteLength(file.contentBase64)
      filesByPath.set(file.path, file)
      const path = canonicalizeFigPluginPath(file.path)
      if (path === undefined) continue
      if (canonicalPaths.has(path)) issue(['files', index, 'path'], 'duplicate package file path')
      canonicalPaths.add(path)
    }
    if (declaredBytes > MAX_CONTENT_BYTES)
      issue(['files'], 'declared content exceeds package bound')
    if (contentBytes > MAX_CONTENT_BYTES) issue(['files'], 'encoded content exceeds package bound')

    for (const [index, file] of pkg.files.entries()) {
      const path = canonicalizeFigPluginPath(file.path)
      if (path === undefined) continue
      for (let slash = path.indexOf('/'); slash !== -1; slash = path.indexOf('/', slash + 1)) {
        if (canonicalPaths.has(path.slice(0, slash))) {
          issue(['files', index, 'path'], 'file path collides with a directory')
          break
        }
      }
    }

    // Declarations match exact paths for portability; collisions are case-insensitive.
    if (!filesByPath.has(pkg.manifest.entryPath)) {
      issue(['manifest', 'entryPath'], 'entryPath must name a package file')
    }
    if (pkg.manifest.assets.length !== pkg.files.length) {
      issue(['manifest', 'assets'], 'assets must declare every package file exactly once')
    }
    for (const [index, asset] of pkg.manifest.assets.entries()) {
      const file = filesByPath.get(asset.path)
      if (!file || asset.sizeBytes !== file.bytes || asset.sha256 !== file.sha256) {
        issue(
          ['manifest', 'assets', index],
          'asset path, sizeBytes and sha256 must match a package file'
        )
      }
    }
  })

export type FigPluginPackageFile = z.infer<typeof FigPluginPackageFileSchema>
export type FigPluginPackage = z.infer<typeof FigPluginPackageSchema>
export type FigPluginPackageInput = z.input<typeof FigPluginPackageSchema>

/** UTF-8 digest input for a parsed package; the manifest is excluded to avoid a self-hash. */
export const canonicalFigPluginPackageIndex = (pkg: FigPluginPackage): string =>
  canonicalFigPluginJson({
    format: FIGPLUGIN_PACKAGE_FORMAT,
    files: pkg.files
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  })

/** Signing material for a parsed/defaulted manifest, omitting only signature.value. */
export const getFigPluginPackageSigningPayload = (pkg: FigPluginPackage): string => {
  const signature: Partial<FigPluginManifest['signature']> = { ...pkg.manifest.signature }
  delete signature.value
  return `${FIGPLUGIN_PACKAGE_FORMAT}\n${canonicalFigPluginJson({ ...pkg.manifest, signature })}`
}

const fitsEnvelopeBound = (text: string): boolean => {
  if (text.length > MAX_ENVELOPE_BYTES) return false
  let bytes = 0
  // Iteration joins surrogate pairs; lone surrogates take three UTF-8 replacement bytes.
  for (const character of text) {
    const code = character.charCodeAt(0)
    bytes += character.length === 2 ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
    if (bytes > MAX_ENVELOPE_BYTES) return false
  }
  return true
}

export const parseFigPluginPackageText = (text: string): FigPluginPackage => {
  try {
    if (typeof text === 'string' && fitsEnvelopeBound(text)) {
      const result = FigPluginPackageSchema.safeParse(JSON.parse(text))
      if (result.success) return result.data
    }
  } catch {
    // Never expose JSON/Zod errors, raw package contents, or a nested cause.
  }
  throw new ServiceValidationError('FIGPLUGIN package', undefined, [])
}
