import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'
import {
  requiredRuntimeFiles,
  verifyPackagedRuntimeDependencies
} from './verify-packaged-runtime-dependencies.mjs'

const tempRoots = []

function createTempApp(includedFiles) {
  const trashRoot = path.join(process.cwd(), '.magicpot-trash')
  fs.mkdirSync(trashRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(trashRoot, 'packaged-runtime-dependencies-test-'))
  tempRoots.push(root)

  const sourceDir = path.join(root, 'source')
  const appOutDir = path.join(root, 'win-unpacked')
  fs.mkdirSync(path.join(appOutDir, 'resources'), { recursive: true })
  for (const relativePath of includedFiles) {
    const filePath = path.join(sourceDir, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{}\n')
  }

  return createPackage(sourceDir, path.join(appOutDir, 'resources', 'app.asar')).then(
    () => appOutDir
  )
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('verify-packaged-runtime-dependencies', () => {
  it('accepts an app.asar containing all required MCP runtime files', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles)
    expect(() => verifyPackagedRuntimeDependencies(appOutDir)).not.toThrow()
  })

  it('reports missing runtime entrypoints', async () => {
    const appOutDir = await createTempApp([
      'node_modules/@modelcontextprotocol/sdk/package.json',
      'node_modules/@hono/node-server/package.json',
      'node_modules/hono/package.json'
    ])
    expect(() => verifyPackagedRuntimeDependencies(appOutDir)).toThrow(
      'node_modules/@hono/node-server/dist/index.js'
    )
  })

  it('uses the packager resources path for platform-specific layouts', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles)
    const resourcesDir = path.join(appOutDir, 'resources')
    const platformAppOutDir = path.join(path.dirname(appOutDir), 'MagicPot.app')
    const packager = { getResourcesDir: () => resourcesDir }

    expect(() => verifyPackagedRuntimeDependencies(platformAppOutDir, packager)).not.toThrow()
  })
})
