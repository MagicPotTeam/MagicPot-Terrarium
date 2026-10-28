import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'

/** Build-time identity for the fixed Bridge isolation entry. */
export const FIGPLUGIN_BRIDGE_CHILD_ASSET_PROTOCOL =
  'magicpot-figplugin-bridge-child-assets/v1' as const
export const FIGPLUGIN_BRIDGE_CHILD_ENTRY = 'out/bridge-child/index.cjs' as const
export const FIGPLUGIN_BRIDGE_CHILD_MANIFEST = 'out/bridge-child/manifest.json' as const

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

const withinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

/**
 * Verify the app-owned child bytes before launching a utility process. This
 * is closure/corruption detection, not code signing; the package signature
 * remains the platform trust boundary.
 */
export function verifyFigPluginBridgeChildAssets(appRoot: string): string {
  if (!path.isAbsolute(appRoot)) throw new Error('Bridge child root must be absolute')
  try {
    const root = path.resolve(appRoot)
    const manifestPath = path.resolve(root, FIGPLUGIN_BRIDGE_CHILD_MANIFEST)
    const entryPath = path.resolve(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY)
    if (!withinRoot(root, manifestPath) || !withinRoot(root, entryPath))
      throw new Error('Bridge child assets unavailable')

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      protocol?: unknown
      files?: unknown
    }
    if (
      manifest.protocol !== FIGPLUGIN_BRIDGE_CHILD_ASSET_PROTOCOL ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== 1
    )
      throw new Error('Bridge child assets unavailable')
    const file = manifest.files[0] as { path?: unknown; sha256?: unknown }
    if (
      file.path !== FIGPLUGIN_BRIDGE_CHILD_ENTRY ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Bridge child assets unavailable')

    // Development roots are mutable, so reject a symlink/junction in every
    // component. Packaged ASAR paths are regular app-owned virtual entries.
    const segments = path.relative(root, entryPath).split(path.sep)
    let current = root
    for (const segment of segments) {
      current = path.join(current, segment)
      if (lstatSync(current).isSymbolicLink()) throw new Error('Bridge child assets unavailable')
    }
    const digest = sha256(readFileSync(entryPath))
    if (digest !== file.sha256) throw new Error('Bridge child assets unavailable')
    return entryPath
  } catch {
    // Do not leak installation paths or parser errors into lifecycle logs.
    throw new Error('Bridge child assets unavailable')
  }
}
