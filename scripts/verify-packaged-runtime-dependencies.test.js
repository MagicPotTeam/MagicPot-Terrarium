import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackage } from '@electron/asar'
import {
  requiredRuntimeFiles,
  documentWorkerRuntimeAssets,
  verifyPackagedDocumentWorker,
  verifyPackagedRuntimeDependencies
} from './verify-packaged-runtime-dependencies.mjs'

const tempRoots = []
const require = createRequire(import.meta.url)
const { createTransformer } = require('app-builder-lib/out/fileTransformer.js')

async function createTempApp(
  includedFiles,
  packageJsonByRoot = {},
  corruptDocument = false,
  transformPdfMetadata = false
) {
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

  // Synthetic packaged closure: real hashes of owned fixture bytes, not production assets.
  const manifestPath = path.join(sourceDir, 'out/document-worker/manifest.json')
  if (fs.existsSync(manifestPath)) {
    const pdfPackagePath = path.join(sourceDir, 'node_modules/pdfjs-dist/package.json')
    if (fs.existsSync(pdfPackagePath))
      fs.writeFileSync(
        pdfPackagePath,
        JSON.stringify({
          name: 'pdfjs-dist',
          version: '6.3.289',
          main: 'build/pdf.mjs',
          keywords: ['fixture'],
          bugs: 'https://fixture.invalid/',
          scripts: {},
          ...packageJsonByRoot['node_modules/pdfjs-dist']
        })
      )
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        protocol: 'magicpot-document-worker-assets/v2',
        pdfjsVersion: '6.3.289',
        saxesVersion: '6.0.0',
        files: documentWorkerRuntimeAssets.map((relative) => ({
          path: relative,
          sha256: fs.existsSync(path.join(sourceDir, relative))
            ? createHash('sha256')
                .update(fs.readFileSync(path.join(sourceDir, relative)))
                .digest('hex')
            : '0'.repeat(64)
        }))
      })
    )
  }

  if (transformPdfMetadata) {
    const metadata = path.join(sourceDir, 'node_modules/pdfjs-dist/package.json')
    const transformer = createTransformer(sourceDir, {}, {})
    const changed = await transformer(metadata)
    expect(changed).not.toBeNull()
    expect(JSON.parse(changed)).not.toHaveProperty('scripts')
    expect(JSON.parse(changed)).not.toHaveProperty('keywords')
    fs.writeFileSync(metadata, changed)
  }

  if (corruptDocument)
    fs.writeFileSync(path.join(sourceDir, 'out/document-worker/index.cjs'), 'corrupt owned bytes')

  const helper = path.join(appOutDir, 'bin', 'magicpot-command-job', 'magicpot-command-job.exe')
  fs.mkdirSync(path.dirname(helper), { recursive: true })
  fs.writeFileSync(helper, 'trusted-helper')
  fs.writeFileSync(
    `${helper}.sha256`,
    `${createHash('sha256').update(fs.readFileSync(helper)).digest('hex')}\n`
  )
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
  it('rejects a missing PDF module in the packaged document closure', async () => {
    const appOutDir = await createTempApp(
      requiredRuntimeFiles.filter(
        (file) => file !== 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
      )
    )
    expect(() => verifyPackagedDocumentWorker(path.join(appOutDir, 'resources/app.asar'))).toThrow(
      'asset missing'
    )
  })

  it('rejects an altered document asset rather than trusting a stale manifest', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {}, true)
    expect(() => verifyPackagedDocumentWorker(path.join(appOutDir, 'resources/app.asar'))).toThrow(
      'SHA-256 mismatch'
    )
  })

  it('accepts real electron-builder metadata rewriting without weakening code asset hashes', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {}, false, true)
    expect(() =>
      verifyPackagedDocumentWorker(path.join(appOutDir, 'resources/app.asar'))
    ).not.toThrow()
  })

  it('rejects missing PDF metadata even though it is not a code byte-hash entry', async () => {
    const appOutDir = await createTempApp(
      requiredRuntimeFiles.filter((file) => file !== 'node_modules/pdfjs-dist/package.json')
    )
    expect(() => verifyPackagedDocumentWorker(path.join(appOutDir, 'resources/app.asar'))).toThrow(
      'PDF metadata unavailable'
    )
  })

  it.each([
    { name: 'wrong-owned-name' },
    { version: '0.0.0' },
    { main: '../../wrong-owned-entry.mjs' },
    { exports: null }
  ])('rejects module resolution metadata mismatch %j', async (metadata) => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {
      'node_modules/pdfjs-dist': metadata
    })
    expect(() => verifyPackagedDocumentWorker(path.join(appOutDir, 'resources/app.asar'))).toThrow(
      'PDF resolution mismatch'
    )
  })

  it('accepts an app.asar containing the required MCP runtime closure', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {
      'node_modules/@modelcontextprotocol/sdk': {
        name: '@modelcontextprotocol/sdk',
        dependencies: {
          '@hono/node-server': '2.1.0',
          hono: '4.12.26',
          'zod-to-json-schema': '3.25.2'
        }
      },
      'node_modules/@hono/node-server': {
        name: '@hono/node-server',
        version: '2.1.0',
        main: 'dist/index.mjs'
      },
      'node_modules/hono': { name: 'hono' },
      'node_modules/zod-to-json-schema': { name: 'zod-to-json-schema' }
    })
    expect(() => verifyPackagedRuntimeDependencies(appOutDir, undefined, 'win32')).not.toThrow()
  })

  it('rejects a missing or tampered Windows Job Object helper for a Windows target', async () => {
    const appOutDir = await createTempApp(requiredRuntimeFiles, {
      'node_modules/@modelcontextprotocol/sdk': { name: '@modelcontextprotocol/sdk' }
    })
    const helper = path.join(appOutDir, 'bin', 'magicpot-command-job', 'magicpot-command-job.exe')
    fs.writeFileSync(helper, 'tampered-helper')
    expect(() => verifyPackagedRuntimeDependencies(appOutDir, undefined, 'win32')).toThrow(
      'SHA-256 mismatch'
    )
    fs.rmSync(helper)
    expect(() => verifyPackagedRuntimeDependencies(appOutDir, undefined, 'win32')).toThrow(
      'helper was not found'
    )
  })

  it.each(['darwin', 'linux'])(
    'does not require the Windows Job Object helper for a %s target',
    async (electronPlatformName) => {
      const appOutDir = await createTempApp(requiredRuntimeFiles, {
        'node_modules/@modelcontextprotocol/sdk': { name: '@modelcontextprotocol/sdk' }
      })
      fs.rmSync(path.join(appOutDir, 'bin'), { recursive: true, force: true })

      expect(() =>
        verifyPackagedRuntimeDependencies(appOutDir, undefined, electronPlatformName)
      ).not.toThrow()
    }
  )

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
    expect(() => verifyPackagedRuntimeDependencies(appOutDir, undefined, 'win32')).toThrow(
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

    expect(() =>
      verifyPackagedRuntimeDependencies(platformAppOutDir, packager, 'win32')
    ).not.toThrow()
  })
})
