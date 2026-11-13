// Isolated browser integration fixture; never launch Electron or a persistent profile.
// Run: MAGICPOT_TEST_CHROME_EXECUTABLE=/absolute/path/to/chrome node scripts/chat/chatStorage.browser-isolation.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const executablePath = process.env.MAGICPOT_TEST_CHROME_EXECUTABLE
if (!executablePath || !path.isAbsolute(executablePath) || !/^chrome(?:\.exe)?$/i.test(path.basename(executablePath))) {
  throw new Error('Set MAGICPOT_TEST_CHROME_EXECUTABLE to the absolute path of an installed Chrome executable; no user profile is accepted.')
}
const scratch = await mkdtemp(path.join(os.tmpdir(), 'magicpot-browser-idb-fixture-'))
let server, browser, context
const errors = []
try {
  server = await createServer({
    configFile: false,
    root,
    publicDir: false,
    cacheDir: path.join(scratch, 'vite-cache'),
    resolve: { alias: {
      '@shared': path.join(root, 'packages/app/src/shared'),
      '@renderer': path.join(root, 'packages/app/src/renderer/src')
    } },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null, fs: { strict: true, allow: [root] } },
    plugins: [{
      name: 'isolated-idb-fixture-page',
      configureServer(vite) {
        vite.middlewares.use((req, res, next) => {
          if (req.url !== '/__idb_fixture__') return next()
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'")
          res.end('<!doctype html><html><head><title>IDB fixture</title></head><body></body></html>')
        })
      }
    }]
  })
  await server.listen()
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  assert.equal(address.address, '127.0.0.1')
  const origin = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch({ headless: true, executablePath })
  context = await browser.newContext({ serviceWorkers: 'block' })
  await context.route('**/*', route => {
    const url = new URL(route.request().url())
    if (url.origin === origin) return route.continue()
    errors.push(`Blocked non-fixture request: ${url.origin}`)
    return route.abort()
  })
  await context.addInitScript(() => { window.api = {} })
  const a = await context.newPage()
  const b = await context.newPage()
  for (const page of [a, b]) {
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
    await page.goto(`${origin}/__idb_fixture__`)
    await page.evaluate(async () => {
      window.fixtureStorage = await import('/packages/app/src/renderer/src/pages/ChatPage/chatStorage.ts')
    })
  }
  const baseline = { id: 'fixture-session', title: 'baseline', messages: [{ role: 'user', content: 'initial' }], createdAt: 1 }
  await a.evaluate(async value => window.fixtureStorage.saveSessionToDB(value, 'fixture-a', { expectedSession: null }), baseline)
  const [snapshotA, snapshotB] = await Promise.all([a, b].map(page => page.evaluate(() => window.fixtureStorage.loadSessionFromDB('fixture-session', 'fixture-a'))))
  assert.deepEqual(snapshotA, snapshotB)
  assert.ok(snapshotA)
  await a.evaluate(async snapshot => window.fixtureStorage.saveSessionToDB({ ...snapshot, title: 'confirmed A' }, 'fixture-a', { expectedSession: snapshot }), snapshotA)
  const stale = await b.evaluate(async snapshot => {
    try {
      await window.fixtureStorage.saveSessionToDB({ ...snapshot, title: 'stale B' }, 'fixture-a', { expectedSession: snapshot })
      return 'unexpected success'
    } catch (error) { return error.name }
  }, snapshotB)
  assert.equal(stale, 'ChatSessionSaveConflictError')
  const fromOtherPage = await b.evaluate(() => window.fixtureStorage.loadSessionFromDB('fixture-session', 'fixture-a'))
  assert.equal(fromOtherPage?.title, 'confirmed A')
  assert.deepEqual(fromOtherPage?.messages, baseline.messages)
  await b.evaluate(async value => window.fixtureStorage.saveSessionToDB({ ...value, title: 'scope B' }, 'fixture-b', { expectedSession: null }), baseline)
  const [scopeA, scopeB] = await Promise.all(['fixture-a', 'fixture-b'].map(scope => a.evaluate(scope => window.fixtureStorage.loadSessionFromDB('fixture-session', scope), scope)))
  assert.equal(scopeA?.title, 'confirmed A')
  assert.equal(scopeB?.title, 'scope B')
  assert.deepEqual(scopeA?.messages, baseline.messages)
  assert.deepEqual(scopeB?.messages, baseline.messages)
  assert.deepEqual(errors, [])
  console.log('PASS: real Chromium IndexedDB, two same-origin pages; stale CAS rejected, confirmed write retained, same ID isolated by scope.')
} finally {
  try { await context?.close() } finally {
    try { await browser?.close() } finally {
      try { await server?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  }
}
