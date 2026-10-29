import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { parse } from 'yaml'
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

  it('separates PR refs from event and fixed release checkouts without skipping validation', () => {
    const definition = parse(
      fs.readFileSync(path.join(projectRoot, '.github/workflows/call-ci.yml'), 'utf8')
    )
    const steps = definition.jobs['test-lint-typecheck'].steps
    const step = (name) => steps.find((entry) => entry.name === name)
    expect(steps.some((entry) => entry.name === 'Resolve checkout ref')).toBe(false)
    expect(step('Checkout event commit').with.ref).toBe('${{ github.sha }}')
    expect(step('Checkout owned release candidate').with.ref).toBe('refs/heads/release/nightly')
    expect(step('Setup Node.js').with).not.toHaveProperty('cache')
    for (const checkout of steps.filter((entry) => entry.uses?.startsWith('actions/checkout@'))) {
      expect(checkout.with['persist-credentials']).toBe(false)
    }
    const guard = step('Verify trusted checkout identity before executing repository code')
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(step('Install dependencies')))
    const head = '1234567890abcdef1234567890abcdef12345678'
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash'
    const check = (overrides) =>
      spawnSync(shell, ['-c', 'git() { printf "%s\\n" "$TEST_CHECKOUT_SHA"; }\n' + guard.run], {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          TEST_CHECKOUT_SHA: head,
          GITHUB_REF: 'refs/heads/master',
          GITHUB_EVENT_NAME: 'push',
          GITHUB_SHA: head,
          REQUESTED_REF: 'refs/heads/master',
          RELEASE_CANDIDATE: 'false',
          ...overrides
        }
      })
    expect(check({}).status).toBe(0)
    expect(
      check({
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REF: 'refs/pull/126/merge',
        REQUESTED_REF: 'refs/pull/126/merge'
      }).status
    ).toBe(0)
    expect(check({ REQUESTED_REF: 'refs/heads/unreviewed' }).status).not.toBe(0)
    expect(
      check({ RELEASE_CANDIDATE: 'true', GITHUB_EVENT_NAME: 'schedule', REQUESTED_REF: head })
        .status
    ).toBe(0)
    expect(
      check({
        RELEASE_CANDIDATE: 'true',
        GITHUB_EVENT_NAME: 'schedule',
        REQUESTED_REF: '0'.repeat(40)
      }).status
    ).not.toBe(0)
    expect(
      check({
        RELEASE_CANDIDATE: 'true',
        GITHUB_EVENT_NAME: 'schedule',
        REQUESTED_REF: head,
        GITHUB_REF: 'refs/heads/unreviewed'
      }).status
    ).not.toBe(0)
    const nightly = parse(
      fs.readFileSync(path.join(projectRoot, '.github/workflows/nightly-bump-version.yml'), 'utf8')
    )
    expect(nightly.jobs['candidate-ci'].with.release_candidate).toBe(true)
    expect(nightly.jobs['candidate-ci'].with.ref).toBe('${{ needs.bump-version.outputs.ref }}')
  })

  it('keeps both package-manager locks on the same patched adapter integrity', () => {
    const npmLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'))
    const pnpm = parse(fs.readFileSync(path.join(projectRoot, 'pnpm-lock.yaml'), 'utf8'))
    expect(pnpm.importers['.'].dependencies['@hono/node-server']).toEqual({
      specifier: '2.1.5',
      version: '2.1.5(hono@4.13.11)'
    })
    expect(pnpm.packages['@hono/node-server@2.1.5'].resolution.integrity).toBe(
      npmLock.packages['node_modules/@hono/node-server'].integrity
    )
    expect(
      pnpm.snapshots['@modelcontextprotocol/sdk@1.32.2(zod@4.6.7)'].dependencies[
        '@hono/node-server'
      ]
    ).toBe('2.1.5(hono@4.13.11)')
    expect(pnpm.packages).not.toHaveProperty('@hono/node-server@2.1.0')
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
