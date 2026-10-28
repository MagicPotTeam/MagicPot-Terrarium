import { TextDecoder } from 'node:util'
import { z } from 'zod'
import {
  FIGPLUGIN_BRIDGE_MANIFEST_VERSION,
  FIGPLUGIN_SCHEMA_VERSION,
  FigPluginDesktopBridgeOriginSchema,
  isSafeRelativePath
} from '@shared/figplugin/manifest'
import { FigPluginManagementError } from '@shared/figplugin/management'
import type { FigPluginPackage } from '@shared/figplugin/package'

export type VerifiedNativePluginManifest = {
  kind: 'figma-development' | 'photoshop-uxp-development'
  entryPath: string
  displayHost: string
}

const MAX_NATIVE_MANIFEST_BYTES = 64 * 1024
const NativePathSchema = z.string().min(1).max(512).refine(isSafeRelativePath)
const NameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value.trim() === value)
const PublisherIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?![\s\S])/)
const VersionSchema = z
  .string()
  .max(50)
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/)
  .refine((value) => value.split('.').every((part) => Number.isSafeInteger(Number(part))))

// This deliberately excludes build (shell execution), proposed/private APIs and permissions.
const FigmaManifestSchema = z
  .object({
    name: NameSchema,
    id: z.string().regex(/^[0-9]{5,32}(?![\s\S])/),
    api: z.literal('1.0.0'),
    editorType: z.tuple([z.literal('figma')]),
    main: NativePathSchema,
    ui: NativePathSchema.optional(),
    documentAccess: z.literal('dynamic-page'),
    networkAccess: z
      .object({
        allowedDomains: z.tuple([z.literal('none')]),
        devAllowedDomains: z.tuple([]).optional()
      })
      .strict()
  })
  .strict()

const FigmaBridgeManifestSchema = FigmaManifestSchema.extend({
  networkAccess: FigmaManifestSchema.shape.networkAccess.extend({
    allowedDomains: z.tuple([FigPluginDesktopBridgeOriginSchema]),
    reasoning: z.literal('Connect only to the locally paired MagicPot desktop bridge.')
  })
})

const DimensionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
const PhotoshopManifestSchema = z
  .object({
    manifestVersion: z.literal(5),
    id: PublisherIdSchema,
    name: NameSchema,
    version: VersionSchema,
    main: NativePathSchema,
    host: z
      .object({
        app: z.literal('PS'),
        minVersion: VersionSchema.refine((value) => {
          const [major, minor] = value.split('.').map(Number)
          return major > 23 || (major === 23 && minor >= 3)
        })
      })
      .strict(),
    entrypoints: z.tuple([
      z
        .object({
          type: z.literal('panel'),
          id: PublisherIdSchema,
          label: z.object({ default: NameSchema }).strict(),
          minimumSize: z
            .object({ width: DimensionSchema, height: DimensionSchema })
            .strict()
            .optional()
        })
        .strict()
    ]),
    requiredPermissions: z
      .object({ localFileSystem: z.literal('plugin').optional() })
      .strict()
      .optional()
  })
  .strict()

const PhotoshopBridgeManifestSchema = PhotoshopManifestSchema.extend({
  requiredPermissions: z
    .object({
      localFileSystem: z.literal('plugin').optional(),
      network: z.object({ domains: z.tuple([FigPluginDesktopBridgeOriginSchema]) }).strict()
    })
    .strict()
})

function invalid(): never {
  throw new FigPluginManagementError('INVALID_PACKAGE')
}

function parseDescriptor(text: string): unknown {
  const value: unknown = JSON.parse(text)
  // JSON.parse discards duplicate keys; native hosts must not interpret permissions differently.
  const objects: Set<string>[] = []
  let previous = ''
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}:]/g)) {
    if (token === '{') objects.push(new Set())
    else if (token === '}') objects.pop()
    else if (token === ':') {
      const key = JSON.parse(previous) as string
      const keys = objects[objects.length - 1]
      if (keys.has(key)) invalid()
      keys.add(key)
    }
    previous = token
  }
  return value
}

function requireReference(pkg: FigPluginPackage, reference: string, extension: string): void {
  const directory = pkg.manifest.entryPath.slice(0, pkg.manifest.entryPath.lastIndexOf('/') + 1)
  const target = directory + reference
  if (
    !reference.endsWith(extension) ||
    !NativePathSchema.safeParse(target).success ||
    !pkg.files.some((file) => file.path === target)
  ) {
    invalid()
  }
}

/**
 * Call after package signature/hash verification, before approval or materialization.
 * Validates a development descriptor, not code safety, host availability or adapter readiness.
 * HTML/JS stays opaque; the native host enforces offline or exact-bridge/sandbox-only permissions.
 */
export function verifyNativePluginManifest(pkg: FigPluginPackage): VerifiedNativePluginManifest {
  try {
    const entryPath = NativePathSchema.parse(pkg.manifest.entryPath)
    const { schemaVersion, permissions, bridge } = pkg.manifest
    if (entryPath.split('/').at(-1) !== 'manifest.json' || permissions.filesystem !== 'none') {
      return invalid()
    }
    let bridgeOrigin: string | undefined
    if (schemaVersion === FIGPLUGIN_BRIDGE_MANIFEST_VERSION) {
      if (permissions.network !== 'desktop-bridge' || bridge?.protocol !== 1) return invalid()
      bridgeOrigin = FigPluginDesktopBridgeOriginSchema.parse(bridge.origin)
    } else if (
      schemaVersion !== FIGPLUGIN_SCHEMA_VERSION ||
      permissions.network !== 'none' ||
      'bridge' in pkg.manifest
    ) {
      return invalid()
    }
    const file = pkg.files.find((candidate) => candidate.path === entryPath)
    if (
      !file ||
      file.bytes > MAX_NATIVE_MANIFEST_BYTES ||
      file.contentBase64.length > Math.ceil(MAX_NATIVE_MANIFEST_BYTES / 3) * 4
    ) {
      return invalid()
    }
    const bytes = Buffer.from(file.contentBase64, 'base64')
    if (bytes.length !== file.bytes || bytes.length > MAX_NATIVE_MANIFEST_BYTES) return invalid()
    // Preserve a BOM so strict JSON parsing rejects it rather than silently stripping it.
    const native = parseDescriptor(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    )
    if (pkg.manifest.host === 'figma') {
      const manifest =
        bridgeOrigin === undefined
          ? FigmaManifestSchema.parse(native)
          : FigmaBridgeManifestSchema.refine(
              (value) => value.networkAccess.allowedDomains[0] === bridgeOrigin
            ).parse(native)
      if (manifest.name !== pkg.manifest.name) return invalid()
      requireReference(pkg, manifest.main, '.js')
      if (manifest.ui !== undefined) requireReference(pkg, manifest.ui, '.html')
      return { kind: 'figma-development', entryPath, displayHost: 'Figma' }
    }
    if (pkg.manifest.host === 'photoshop') {
      const manifest =
        bridgeOrigin === undefined
          ? PhotoshopManifestSchema.parse(native)
          : PhotoshopBridgeManifestSchema.refine(
              (value) => value.requiredPermissions.network.domains[0] === bridgeOrigin
            ).parse(native)
      if (manifest.name !== pkg.manifest.name || manifest.version !== pkg.manifest.version) {
        return invalid()
      }
      requireReference(pkg, manifest.main, '.html')
      return { kind: 'photoshop-uxp-development', entryPath, displayHost: 'Adobe Photoshop' }
    }
  } catch {
    // Do not expose parser issues, raw contents, IDs, paths or a nested cause.
  }
  return invalid()
}
