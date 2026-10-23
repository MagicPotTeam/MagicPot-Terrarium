import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { generateKeyPairSync } from 'node:crypto'
import { prepareFigPluginHost } from './prepare-figplugin-host.mjs'
import { buildFigPluginPackage } from './build-figplugin-package.mjs'

for (const host of ['figma', 'photoshop']) {
  test(`${host}: explicit localhost stays exact in native grant, code and signed package`, (t) => {
    const root = fs.mkdtempSync(
      path.join(fs.realpathSync.native(os.tmpdir()), 'magicpot-localhost-owned-')
    )
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const origin = 'http://localhost:49153'
    const output = path.join(root, 'plugin')
    const pluginId = host === 'figma' ? '987654321012345678' : 'owned.localhost.validation'
    prepareFigPluginHost({
      host,
      pluginId,
      publisherId: 'owned.publisher',
      keyId: 'owned.key',
      issuedAt: '2026-10-23T12:00:00Z',
      outputDir: output,
      bridgeOrigin: origin
    })
    const names = fs.readdirSync(output).sort()
    assert.equal(names.length, 4)
    const native = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'))
    const template = JSON.parse(fs.readFileSync(path.join(output, 'package.template.json'), 'utf8'))
    assert.equal(template.bridge.origin, origin)
    assert.deepEqual(
      host === 'figma'
        ? native.networkAccess.allowedDomains
        : native.requiredPermissions.network.domains,
      [origin]
    )
    const code = fs.readFileSync(
      path.join(output, host === 'figma' ? 'code.js' : 'main.js'),
      'utf8'
    )
    const configuration = JSON.parse(
      code.match(/MAGICPOT_BRIDGE_CONFIG = Object.freeze\(([^\n]+)\);/)[1]
    )
    assert.equal(configuration.origin, origin)
    const { privateKey } = generateKeyPairSync('ed25519')
    const input = {
      manifest: template,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      files: template.assets.map((asset) => ({
        path: asset.path,
        data: fs.readFileSync(path.join(output, asset.path))
      }))
    }
    const built = JSON.parse(buildFigPluginPackage(input).packageText)
    assert.equal(built.manifest.bridge.origin, origin)
    assert.equal(built.manifest.permissions.network, 'desktop-bridge')
    const altered = structuredClone(template)
    altered.bridge.origin = 'http://127.0.0.1:49153'
    const other = JSON.parse(buildFigPluginPackage({ ...input, manifest: altered }).packageText)
    assert.notEqual(built.manifest.signature.value, other.manifest.signature.value)
    // Selecting another spelling is a new signed configuration, never a runtime fallback.
    assert.equal(other.manifest.bridge.origin, altered.bridge.origin)
  })
}
