import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { startSyntheticResponsesMock } from './syntheticResponsesMock.mjs'
import { isolatedImageEnvironment, assertIsolatedRuntime } from './isolatedImageDesktopAcceptance.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const sourceRoot = path.join(privateRoot, 'MagicPot', 'goal-complete-20261113-6')
const runId = 'trigger-desktop-acceptance-20261113-1'
const runRoot = path.join(privateRoot, 'MagicPot', runId)
const sourceApp = path.join(sourceRoot, 'app')
const sourceWorker = path.join(sourceRoot, 'bin', 'canvas-thumbnail-sidecar.exe')
const token = 'trigger-desktop-acceptance-token'
const sdkPort = 15437
const sdkBase = `http://127.0.0.1:${sdkPort}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const inside = (parent, value) => {
  const relative = path.relative(path.resolve(parent), path.resolve(value))
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
const request = async (method, payload) => {
  const response = await fetch(`${sdkBase}/v2/sdk/${encodeURIComponent(method)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  })
  const body = await response.json()
  return { status: response.status, body }
}
const waitForSdk = async (timeoutMs = 60_000) => {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try {
      const result = await request('trigger.list', {})
      if (result.status === 200) return result
      last = result
    } catch (error) {
      last = { error: error.message }
    }
    await sleep(250)
  }
  throw new Error(`SDK server did not become ready: ${JSON.stringify(last)}`)
}
const copyPrivateApp = async () => {
  await fs.rm(runRoot, { recursive: true, force: true })
  await fs.mkdir(runRoot, { recursive: true })
  const appDest = path.join(runRoot, 'app')
  await fs.cp(sourceApp, appDest, { recursive: true, filter: source => path.basename(source) !== 'node_modules' })
  await fs.symlink(path.join(repoRoot, 'node_modules'), path.join(appDest, 'node_modules'), 'junction')
  await fs.mkdir(path.join(runRoot, 'bin'), { recursive: true })
  await fs.copyFile(sourceWorker, path.join(runRoot, 'bin', 'canvas-thumbnail-sidecar.exe'))
  for (const dir of ['cwd', 'storage/Data', 'storage/Projects', 'evidence', 'home', 'appdata', 'localappdata', 'temp'])
    await fs.mkdir(path.join(runRoot, dir), { recursive: true })
}
const configure = async mockOrigin => {
  const configPath = path.join(runRoot, 'storage', 'Data', 'config.json')
  const config = JSON.parse(await fs.readFile(path.join(sourceRoot, 'storage', 'Data', 'config.json'), 'utf8'))
  config.remote_comfyui_config = { ...(config.remote_comfyui_config ?? {}), comfyui_origin: mockOrigin }
  config.magic_agent_sdk_server_config = {
    enable_server: true,
    port: sdkPort,
    access_token: token,
    actor_kind: 'user',
    actor_id: 'trigger-acceptance-user'
  }
  config.llm_config = {
    ...(config.llm_config ?? {}),
    api_profiles: (config.llm_config?.api_profiles ?? []).map(profile => ({ ...profile, base_url: `${mockOrigin}/v1` }))
  }
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { flag: 'wx' })
  const appRoot = path.join(runRoot, 'app')
  const mainEntry = path.join(appRoot, 'out', 'main', 'index.js')
  const workerPath = path.join(runRoot, 'bin', 'canvas-thumbnail-sidecar.exe')
  const bootstrap = `require(${JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs'))}).startIsolatedImageDesktop(${JSON.stringify({ runRoot, mainEntry, mockOrigin, workerPath })})\n`
  await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'), bootstrap, { flag: 'w' })
}
const querySqliteEvidence = async () => {
  const dataRoot = path.join(runRoot, 'storage', 'Data')
  const found = []
  const walk = async directory => {
    let entries = []
    try { entries = await fs.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (entry.name.endsWith('.sqlite') || entry.name.endsWith('.sqlite3')) found.push(filename)
    }
  }
  await walk(dataRoot)
  const result = []
  const { DatabaseSync } = await import('node:sqlite')
  for (const filename of found) {
    try {
      const stat = await fs.stat(filename)
      const db = new DatabaseSync(filename, { readOnly: true })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      result.push({ filename, bytes: stat.size, tables })
      db.close()
    } catch (error) {
      result.push({ filename, error: error.message })
    }
  }
  return result
}
const run = async () => {
  assert(inside(privateRoot, runRoot))
  await copyPrivateApp()
  const mock = await startSyntheticResponsesMock()
  const mockOrigin = new URL(mock.baseURL).origin
  await configure(mockOrigin)
  const appRoot = path.join(runRoot, 'app')
  const launch = await electron.launch({
    executablePath: require('electron'),
    args: [
      appRoot,
      '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
      '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling'
    ],
    cwd: path.join(runRoot, 'cwd'),
    env: isolatedImageEnvironment(runRoot, path.resolve(runRoot, '../../..'), runId),
    timeout: 90_000
  })
  const output = { runRoot, sdkBase, mockOrigin, status: 'running', launch: { pid: launch.process().pid }, runtime: null, create: null, trigger: null, providerRequests: null, sqlite: null, close: null }
  let page
  const stdout = [], stderr = []
  launch.process().stdout?.on('data', chunk => stdout.push(chunk.toString()))
  launch.process().stderr?.on('data', chunk => stderr.push(chunk.toString()))
  try {
    page = await launch.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    output.runtime = await assertIsolatedRuntime(launch, page, runRoot, mockOrigin)
    const ready = await waitForSdk()
    output.sdkReady = ready.status
    const now = Date.now()
    const create = await request('trigger.create', {
      trigger: {
        id: 'desktop-schedule-acceptance',
        type: 'schedule',
        title: 'Desktop scheduler fail-closed acceptance',
        enabled: true,
        config: { target: { kind: 'agent-run', agentId: 'missing-agent', prompt: 'loopback synthetic scheduler probe' } }
      },
      schedule: { type: 'interval', intervalMs: 100, missedRunPolicy: 'run-once' },
      nextFireAt: now + 200,
      createdAt: now,
      idempotencyKey: 'desktop-schedule-create'
    })
    output.create = create
    await sleep(3_000)
    output.trigger = await request('trigger.get', { triggerId: 'desktop-schedule-acceptance' })
    output.providerRequests = mock.observations()
    output.status = 'passed'
  } catch (error) {
    output.status = 'failed'
    output.error = { message: error.message, stack: error.stack }
  } finally {
    output.stdout = stdout.join('').slice(-65_536)
    output.stderr = stderr.join('').slice(-65_536)
    try {
      await launch.close()
      output.close = { pid: launch.process().pid, exitCode: launch.process().exitCode, signalCode: launch.process().signalCode }
    } catch (error) {
      output.close = { error: error.message }
      try { launch.process().kill() } catch {}
    }
    try { output.providerRequests = mock.observations() } catch {}
    try { output.sqlite = await querySqliteEvidence() } catch (error) { output.sqliteError = error.message }
    await mock.close()
    await fs.writeFile(path.join(runRoot, 'evidence', 'trigger-result.json'), JSON.stringify(output, null, 2))
  }
  console.log(JSON.stringify({ status: output.status, runRoot, create: output.create, trigger: output.trigger, providerRequests: output.providerRequests, runtime: output.runtime?.guard, sqlite: output.sqlite, close: output.close }))
  return output
}
const result = await run()
process.exitCode = result.status === 'passed' ? 0 : 1
