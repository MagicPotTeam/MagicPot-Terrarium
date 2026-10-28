import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FIGPLUGIN_BRIDGE_CHILD_ASSET_PROTOCOL,
  FIGPLUGIN_BRIDGE_CHILD_ENTRY,
  verifyFigPluginBridgeChildAssets
} from './bridgeChildAssets'

// Asset fixtures exercise the real filesystem rather than the node test
// environment's memfs shim.
vi.unmock('node:fs')
vi.unmock('node:fs/promises')
vi.unmock('fs')
vi.unmock('fs/promises')

const roots: string[] = []
const makeRoot = (): string => {
  const root = mkdtempSync(path.join(process.cwd(), '.tmp-bridge-child-'))
  roots.push(root)
  const output = path.join(root, 'out', 'bridge-child')
  mkdirSync(output, { recursive: true })
  const entry = path.join(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY)
  const bytes = Buffer.from('trusted child bytes')
  writeFileSync(entry, bytes)
  writeFileSync(
    path.join(output, 'manifest.json'),
    JSON.stringify({
      protocol: FIGPLUGIN_BRIDGE_CHILD_ASSET_PROTOCOL,
      files: [
        {
          path: FIGPLUGIN_BRIDGE_CHILD_ENTRY,
          sha256: createHash('sha256').update(bytes).digest('hex')
        }
      ]
    })
  )
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Bridge child asset verification', () => {
  it('accepts the app-owned entry only when the manifest hash matches', () => {
    const root = makeRoot()
    expect(verifyFigPluginBridgeChildAssets(root)).toBe(
      path.join(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY)
    )
  })

  it('fails closed for a changed entry, wrong protocol, or non-absolute root', () => {
    const root = makeRoot()
    writeFileSync(path.join(root, FIGPLUGIN_BRIDGE_CHILD_ENTRY), 'changed')
    expect(() => verifyFigPluginBridgeChildAssets(root)).toThrow()
    expect(() => verifyFigPluginBridgeChildAssets('relative-root')).toThrow()
  })
})
