import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { serveStatic } from '@hono/node-server/serve-static'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const roots = []
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const trash = path.join(projectRoot, '.magicpot-trash')
  fs.mkdirSync(trash, { recursive: true })
  const root = fs.mkdtempSync(path.join(trash, 'hono-static-security-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'static', 'admin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'static', 'admin', 'secret.txt'), 'private fixture bytes')
  fs.writeFileSync(path.join(root, 'static', 'hello world.txt'), 'public fixture bytes')
  fs.writeFileSync(path.join(root, 'static', '炎.txt'), 'unicode fixture bytes')
  const rewriteRequestPath = vi.fn((requestPath) => requestPath)
  const app = new Hono()
  app.use('/static/admin/*', (c) => c.text('Unauthorized', 401))
  app.use('/static/*', serveStatic({ root, rewriteRequestPath }))
  return { app, rewriteRequestPath }
}

describe('Hono Node adapter production security', () => {
  it('keeps production audit as a mandatory CI step before the full test suite', () => {
    const workflow = fs
      .readFileSync(path.join(projectRoot, '.github/workflows/call-ci.yml'), 'utf8')
      .replace(/\r\n/g, '\n')
    const audit = workflow.indexOf(
      '      - name: Audit production dependencies\n        run: npm audit --omit=dev'
    )
    expect(audit).toBeGreaterThan(
      workflow.indexOf('        run: npm ci --prefer-offline --no-audit')
    )
    expect(audit).toBeLessThan(workflow.indexOf('      - name: Test\n'))
    expect(workflow).not.toContain('continue-on-error: true')
    expect(workflow).not.toContain('audit --omit=dev ||')
  })

  it('pins the patched adapter in the manifest, lock and actual MCP resolution', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
    const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
    expect(manifest.dependencies['@hono/node-server']).toBe('2.1.5')
    expect(lock.packages[''].dependencies['@hono/node-server']).toBe('2.1.5')
    expect(lock.packages['node_modules/@hono/node-server'].version).toBe('2.1.5')
    const require = createRequire(import.meta.url)
    const sdkRequire = createRequire(
      require.resolve('@modelcontextprotocol/sdk/server/streamableHttp.js')
    )
    const adapterRoot = path.dirname(path.dirname(sdkRequire.resolve('@hono/node-server')))
    expect(
      JSON.parse(fs.readFileSync(path.join(adapterRoot, 'package.json'), 'utf8')).version
    ).toBe('2.1.5')
  })

  it.each(['/static/admin/secret.txt', '/static/%61dmin/secret.txt'])(
    'preserves protected-prefix authentication for %s',
    async (url) => {
      const { app, rewriteRequestPath } = fixture()
      const response = await app.request(url)
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('Unauthorized')
      expect(rewriteRequestPath).not.toHaveBeenCalled()
    }
  )

  it('rejects the GHSA-rmxm-3fg6-px4f second-decode bypass before filesystem rewriting', async () => {
    const { app, rewriteRequestPath } = fixture()
    const response = await app.request('/static/%%36%31dmin/secret.txt')
    expect(response.status).toBe(404)
    expect(await response.text()).not.toContain('private fixture bytes')
    expect(rewriteRequestPath).not.toHaveBeenCalled()
  })

  it.each([
    ['/static/hello%20world.txt', 'public fixture bytes'],
    ['/static/%E7%82%8E.txt', 'unicode fixture bytes']
  ])('still serves normally encoded public files: %s', async (url, expected) => {
    const { app } = fixture()
    const response = await app.request(url)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(expected)
  })
})
