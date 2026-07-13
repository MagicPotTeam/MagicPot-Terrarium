import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'
import {
  requiredRuntimeFiles,
  verifyPackagedRuntimeDependencies
} from './verify-packaged-runtime-dependencies.mjs'

const tempRoots = []

function createTempApp(includedFiles, packageJsonByRoot = {}) {
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
    const packageRoot = path.posix.dirname(relativePath)
    const packageJson = packageJsonByRoot[packageRoot]
    fs.writeFileSync(
      filePath,
      relativePath.endsWith('/package.json') && packageJson
        ? `${JSON.stringify(packageJson)}\n`
        : '{}\n'
    )
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
  it('accepts an app.asar containing the required MCP runtime closure', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {
      'node_modules/@modelcontextprotocol/sdk': {
        name: '@modelcontextprotocol/sdk',
        dependencies: {
          '@hono/node-server': '1.19.13',
          hono: '4.12.26',
          'zod-to-json-schema': '3.25.2'
        }
      },
      'node_modules/@hono/node-server': { name: '@hono/node-server' },
      'node_modules/hono': { name: 'hono' },
      'node_modules/zod-to-json-schema': { name: 'zod-to-json-schema' }
    })
    expect(() => verifyPackagedRuntimeDependencies(appOutDir)).not.toThrow()
  })

  it('reports missing transitive MCP runtime dependencies', async () => {
    const appOutDir = await createTempApp(
      requiredRuntimeFiles.filter(
        (relativePath) => relativePath !== 'node_modules/zod-to-json-schema/package.json'
      ),
      {
        'node_modules/@modelcontextprotocol/sdk': {
          name: '@modelcontextprotocol/sdk',
          dependencies: { 'zod-to-json-schema': '3.25.2' }
        }
      }
    )
    expect(() => verifyPackagedRuntimeDependencies(appOutDir)).toThrow(
      '@modelcontextprotocol/sdk -> zod-to-json-schema'
    )
  })

  it('uses the packager resources path for platform-specific layouts', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {
      'node_modules/@modelcontextprotocol/sdk': { name: '@modelcontextprotocol/sdk' }
    })
    const resourcesDir = path.join(appOutDir, 'resources')
    const platformAppOutDir = path.join(path.dirname(appOutDir), 'MagicPot.app')
    const packager = { getResourcesDir: () => resourcesDir }

    expect(() => verifyPackagedRuntimeDependencies(platformAppOutDir, packager)).not.toThrow()
  })
})
