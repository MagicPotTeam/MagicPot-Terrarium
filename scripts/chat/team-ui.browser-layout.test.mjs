// Real component layout fixture in ephemeral Chromium; no Electron or user data.
// Run: MAGICPOT_TEST_CHROME_EXECUTABLE=/absolute/path/to/chrome node scripts/chat/team-ui.browser-layout.test.mjs
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const executablePath = process.env.MAGICPOT_TEST_CHROME_EXECUTABLE
if (!executablePath || !path.isAbsolute(executablePath) || !/^chrome(?:\.exe)?$/i.test(path.basename(executablePath))) throw new Error('Set MAGICPOT_TEST_CHROME_EXECUTABLE to an absolute Chrome executable path; no user profile is accepted.')
const scratch = await mkdtemp(path.join(os.tmpdir(), 'magicpot-team-layout-fixture-'))
let server, browser, context
const errors = []
try {
  server = await createServer({
    configFile: false, root, publicDir: false, cacheDir: path.join(scratch, 'vite-cache'), esbuild: { jsx: 'automatic' },
    resolve: { alias: { '@shared': path.join(root, 'packages/app/src/shared'), '@renderer': path.join(root, 'packages/app/src/renderer/src') } },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', '@mui/material'] },
    server: { host: '127.0.0.1', port: 0, strictPort: true, hmr: false, watch: null, fs: { strict: true, allow: [root] } },
    plugins: [{ name: 'team-layout-fixture', configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url === '/__team_layout__') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'")
          return res.end('<!doctype html><html><head><title>Fixture</title></head><body style="margin:0"><div id="root"></div><script type="module" src="/__team_layout_entry__.jsx"></script></body></html>')
        }
        if (req.url === '/__team_layout_entry__.jsx') {
          res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
          return res.end((await vite.transformRequest('/__virtual_team_entry__.jsx')).code)
        }
        next()
      })
    }, resolveId(id) { if (id === '/__virtual_team_entry__.jsx') return id }, load(id) {
      if (id !== '/__virtual_team_entry__.jsx') return null
      return `import React from 'react';
import {createRoot} from 'react-dom/client';
import AgentTeamMenu from '/packages/app/src/renderer/src/pages/ChatPage/components/AgentTeamMenu.tsx';
const lead={id:'fixture-lead',title:'Fixture',messages:[],profileId:'fixture-model'};
const members=[{id:'fixture-member',title:'Fixture member',teamMemberName:'Fixture member',messages:[]}];
window.fixtureSaves=[];
createRoot(document.getElementById('root')).render(React.createElement(AgentTeamMenu,{lead,members,models:[{id:'fixture-model',name:'Fixture model'}],onSave:async value=>{window.fixtureSaves.push(value);return true},onEnd:()=>{}}));`
    }}]
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
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  for (const width of [640, 960]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${origin}/__team_layout__`)
    await page.getByRole('button', { name: '团队', exact: true }).click()
    const task = page.getByLabel('任务', { exact: true })
    const submit = page.getByRole('button', { name: '添加任务', exact: true })
    await task.waitFor({ state: 'visible' })
    assert.ok(await submit.isVisible(), `submit is not visible at ${width}px`)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `document horizontal overflow at ${width}px`)
    await task.fill(`fixture ${width}`)
    await submit.click()
    await page.waitForFunction(() => window.fixtureSaves.length === 1)
    assert.equal(await page.evaluate(() => window.fixtureSaves[0].teamTasks[0].title), `fixture ${width}`)
    await page.waitForFunction(() => document.querySelector('input[aria-label="任务"]')?.value === '' || [...document.querySelectorAll('input')].some(input => input.value === '' && input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent === '任务'))
    console.log(`PASS: ${width}px fixture, visible task control, no document horizontal overflow, click saved synthetic task`)
  }
  assert.deepEqual(errors, [])
} finally {
  try { await context?.close() } finally {
    try { await browser?.close() } finally {
      try { await server?.close() } finally { await rm(scratch, { recursive: true, force: true }) }
    }
  }
}
