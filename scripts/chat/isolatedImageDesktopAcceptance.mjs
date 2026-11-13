import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { _electron as electron } from 'playwright'
import { createDeterministicPng } from './chatImageMemoryBenchmark.mjs'
import { startSyntheticResponsesMock } from './syntheticResponsesMock.mjs'
import { seedIsolatedImageSession, sendIsolatedImageSession, inspectIsolatedImageSession } from './isolatedImageSendFixture.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateScratch = path.resolve(repoRoot, '../../.magicpot-trash')
const profileId = 'isolated-image-responses'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const normal = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normal(value).startsWith(normal(parent) + '/')

export function isolatedImageEnvironment(runRoot, base, runId) {
  const environment = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'].includes(key.toUpperCase())) {
      environment[key] = value
    }
  }
  Object.assign(environment, {
    USERPROFILE: path.join(runRoot, 'home'),
    APPDATA: path.join(runRoot, 'appdata'),
    LOCALAPPDATA: path.join(runRoot, 'localappdata'),
    TEMP: path.join(runRoot, 'temp'),
    TMP: path.join(runRoot, 'temp'),
    MAGICPOT_TEST_UI_MODE: 'offscreen',
    MAGICPOT_TEST_NO_FOCUS: '1',
    MAGICPOT_TEST_AUTOMATED_RUN: '1',
    MAGICPOT_TEST_DESKTOP_PATH: base,
    MAGICPOT_TEST_RUN_ID: runId,
    MAGICPOT_TEST_ARTIFACT_ROOT: runRoot,
    MAGICPOT_STORAGE_ROOT: path.join(runRoot, 'storage'),
    MAGICPOT_MCP_STDIO_SERVER: '0',
    MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH: path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe'),
    VITE_MAGICPOT_AUTO_START_COMFYUI: 'false'
  })
  return environment
}

export function fixtureConfig(baseURL) {
  const mockOrigin = new URL(baseURL).origin
  return {
    use_remote_llm: false,
    use_remote_comfyui: true,
    remote_comfyui_config: { comfyui_origin: mockOrigin, mapping_comfyui_dir: '' },
    comfy_batch_profiles: [{ id: 'isolated-disabled', baseUrl: mockOrigin, enabled: false, maxConcurrency: 1 }],
    local_llm_server_config: { enable_server: false },
    magic_agent_sdk_server_config: { enable_server: false, access_token: '' },
    chat_config: { enable: false },
    mcp_config: { client: { servers: [] }, server: { enabled: false, path: '/api/mcp', auth_token: '', expose_resources: false } },
    figma_config: { personal_access_token: '', auto_check_updates: false },
    plugin_config: { api_profiles: [], usePromptTranslation: false, useImageInterrogation: false },
    llm_config: {
      api_profiles: [{
        id: profileId, name: 'Isolated image Responses', provider: 'openai',
        call_type: 'api', model_use: 'chat', api_mode: 'responses',
        base_url: baseURL, api_key: 'synthetic-placeholder', model_name: 'isolated-image-model',
        enabled: true, showAPI: true, showConfig: true, is_vision_model: true,
        attachment_transports: ['request-data-url'], preferred_attachment_transport: 'request-data-url',
        max_input_images: 50, request_timeout_ms: 120_000
      }],
      customSkills: [], customSkillCategories: [],
      usePromptOptimization: false, usePromptTranslation: false,
      useImageInterrogation: false, useRandomPromptGeneration: false
    }
  }
}

async function until(check, timeout, label) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await check()) return
    await pause(250)
  }
  throw new Error('Timed out: ' + label)
}

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), milliseconds) })
    ])
  } finally { clearTimeout(timer) }
}

// Playwright marks its Page permanently crashed after forcefullyCrashRenderer.
// Recovery is inspected through the SAME native webContents, without reloading it
// from this test or changing the product's automatic recovery behavior.
function nativeRendererProbe(appHandle, webContentsId) {
  return {
    evaluate(fn, argument) {
      const source = '(' + fn.toString() + ')(' + (JSON.stringify(argument) ?? 'undefined') + ')'
      return within(appHandle.evaluate(({ webContents }, { id, source }) => {
        const contents = webContents.fromId(id)
        if (!contents || contents.isDestroyed() || contents.isCrashed() ||
            !contents.getURL().startsWith('file:') || !contents.getURL().includes('/renderer/index.html')) {
          throw new Error('The owned renderer is not available')
        }
        return contents.executeJavaScript(source)
      }, { id: webContentsId, source }), 10_000, 'native renderer inspection')
    },
    async screenshot({ path: filename }) {
      const encoded = await within(appHandle.evaluate(async ({ webContents }, id) => {
        const contents = webContents.fromId(id)
        if (!contents || contents.isDestroyed() || contents.isCrashed()) throw new Error('The owned renderer is not available')
        return (await contents.capturePage()).toPNG().toString('base64')
      }, webContentsId), 5000, 'native renderer screenshot')
      await fs.writeFile(filename, Buffer.from(encoded, 'base64'))
    }
  }
}

function makeSampler(appHandle) {
  const samples = []
  let phase = 'startup'
  let stopped = false
  let pending
  const collect = () => {
    if (stopped || pending) return
    pending = appHandle.evaluate(({ app }) => ({
      now: Date.now(),
      processes: app.getAppMetrics().map(({ pid, type, memory }) => ({ pid, type, memory }))
    })).then(sample => {
      if (samples.length < 2400) samples.push({ phase, ...sample })
    }).catch(() => {}).finally(() => { pending = undefined })
  }
  const timer = setInterval(collect, 250)
  collect()
  return {
    phase(value) { phase = value; collect() },
    async stop() {
      stopped = true
      clearInterval(timer)
      let stopTimedOut = false
      if (pending) {
        try { await within(pending, 5000, 'pending memory sample') } catch { stopTimedOut = true }
      }
      const peaks = {}
      for (const sample of samples) {
        const sums = {}
        for (const entry of sample.processes) {
          sums[entry.type] = (sums[entry.type] || 0) + (entry.memory.workingSetSize || 0)
        }
        peaks[sample.phase] ||= {}
        for (const [type, value] of Object.entries(sums)) {
          peaks[sample.phase][type] = Math.max(peaks[sample.phase][type] || 0, value)
        }
      }
      return { sampleIntervalMs: 250, workingSetUnits: 'KiB', stopTimedOut, coverage: 'Electron app.getAppMetrics processes; native worker not independently measured', peaksByPhaseAndProcessType: peaks, samples }
    }
  }
}

async function runtimeSnapshot(appHandle) {
  return appHandle.evaluate(({ app, BrowserWindow }) => {
    const state = globalThis.__MAGICPOT_IMAGE_DESKTOP__
    const paths = Object.fromEntries(
      ['home', 'appData', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp', 'desktop', 'documents', 'downloads']
        .map(name => [name, app.getPath(name)])
    )
    return {
      cwd: process.cwd(), paths,
      windows: BrowserWindow.getAllWindows().map(win => ({
        id: win.id, webContentsId: win.webContents.id, focused: win.isFocused(), visible: win.isVisible(), bounds: win.getBounds(),
        url: win.webContents.getURL()
      })),
      guard: state?.snapshot ? state.snapshot() : state
    }
  })
}

export async function assertIsolatedRuntime(appHandle, page, runRoot, baseURL) {
  const snapshot = await runtimeSnapshot(appHandle)
  assert.equal(normal(snapshot.cwd), normal(path.join(runRoot, 'cwd')))
  for (const [name, value] of Object.entries(snapshot.paths)) {
    assert(inside(runRoot, value), 'App path escaped the new root: ' + name)
  }
  assert.equal(normal(snapshot.paths.userData), normal(path.join(runRoot, 'storage/Data')))
  assert(snapshot.windows.every(win => !win.focused), 'An isolated window took focus')
  assert(snapshot.guard, 'The private bootstrap did not expose its guard state')
  const config = await page.evaluate(async () => {
    const result = await window.api.svcState.getConfig({})
    const value = result.config ?? result
    return {
      use_remote_llm: value.use_remote_llm,
      profiles: value.llm_config.api_profiles.map(profile => ({ id: profile.id, base_url: profile.base_url })),
      comfyEnabled: (value.comfy_batch_profiles || []).some(profile => profile.enabled !== false),
      mcpServers: value.mcp_config.client.servers.length,
      mcpServerEnabled: value.mcp_config.server.enabled,
      localServerEnabled: value.local_llm_server_config.enable_server,
      sdkServerEnabled: value.magic_agent_sdk_server_config.enable_server,
      downloadDir: value.download_dir
    }
  })
  assert.equal(config.use_remote_llm, false)
  assert.deepEqual(config.profiles, [{ id: profileId, base_url: baseURL }])
  assert.equal(config.comfyEnabled, false)
  assert.equal(config.mcpServers, 0)
  assert.equal(config.mcpServerEnabled, false)
  assert.equal(config.localServerEnabled, false)
  assert.equal(config.sdkServerEnabled, false)
  assert(inside(runRoot, config.downloadDir), 'Download directory escaped the isolated root')
  return { ...snapshot, config }
}

/** Real application and renderer/IPC/provider path, with only synthetic sources
 * and a loopback model fixture. The seeded draft is not a drag/drop/import test. */
export async function runIsolatedImageDesktop(runRoot, workerSource, { crashTwice = true } = {}) {
  assert(path.isAbsolute(runRoot) && inside(privateScratch, runRoot), 'Invalid isolated run root')
  assert(path.isAbsolute(workerSource) && inside(privateScratch, workerSource), 'Use only the owned private worker')
  const runId = path.basename(runRoot)
  const base = path.resolve(runRoot, '../../..')
  assert.equal(normal(path.join(base, '.magicpot-trash/MagicPot', runId)), normal(runRoot))
  const appRoot = path.join(runRoot, 'app')
  const packageData = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageData.name, 'magicpot-isolated-image-acceptance')
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  await fs.access(mainEntry)
  const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  for (const directory of ['bin', 'cwd', 'storage/Data', 'storage/Projects', 'fixtures', 'evidence', 'home', 'appdata', 'localappdata', 'temp']) {
    await fs.mkdir(path.join(runRoot, directory), { recursive: true })
  }
  await fs.copyFile(workerSource, workerPath)
  const largePaths = [], historyPaths = [], originalHashes = []
  let sourceBytes = 0
  for (let index = 0; index < 11; index++) {
    const large = index < 8
    const bytes = createDeterministicPng(large ? index : index + 12, large ? 4096 : 32, large ? 4096 : 32)
    const destination = path.join(runRoot, 'fixtures', (large ? 'large-' : 'history-') + index + '.png')
    await fs.writeFile(destination, bytes)
    ;(large ? largePaths : historyPaths).push(destination)
    originalHashes.push({ path: destination, sha256: sha256(bytes) })
    sourceBytes += bytes.length
  }
  const mock = await startSyntheticResponsesMock()
  let appHandle, page, sampler, identity, nativePage
  const report = { status: 'running', stage: 'prepare', startedAt: new Date().toISOString(), runRoot, fixture: { sourceBytes, largeCount: 8, historyCount: 3, seededDraft: true }, recovery: [] }
  const evidence = path.join(runRoot, 'evidence')
  let output = '', errors = ''
  try {
    await fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL), null, 2))
    await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'),
      'require(' + JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' +
      JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n')
    report.stage = 'launch'
    appHandle = await electron.launch({
      executablePath: require('electron'),
      args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
        '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'],
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId),
      timeout: 90_000
    })
    appHandle.process().stdout?.on('data', chunk => { output = (output + chunk.toString()).slice(-65_536) })
    appHandle.process().stderr?.on('data', chunk => { errors = (errors + chunk.toString()).slice(-65_536) })
    sampler = makeSampler(appHandle)
    page = await appHandle.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    report.runtimeBefore = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    report.stage = 'seed'
    sampler.phase('seed')
    identity = await seedIsolatedImageSession(page, { largePaths, historyPaths, profileId })
    report.identity = identity
    await page.locator('[data-testid="chat-composer-attachments"]').waitFor({ state: 'visible', timeout: 90_000 })
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-composer-attachments"]')?.children.length === 8, undefined, { timeout: 90_000 })
    await page.screenshot({ path: path.join(evidence, 'before-send.png'), fullPage: false })
    report.stage = 'send'
    sampler.phase('send')
    const sendStarted = Date.now()
    await sendIsolatedImageSession(page, identity)
    await until(() => mock.observations().length > 0, 150_000, 'the real model request')
    const observations = mock.observations()
    assert.equal(observations.length, 1, 'Expected exactly one model POST')
    assert.equal(observations[0].imageCount, 11, 'The real renderer request lost or added images')
    assert(observations[0].bytes <= 28 * 1024 * 1024, 'Provider JSON exceeded its limit')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-chat-message-index]')].some(element => element.textContent?.trim() === 'ok' || /\bok\b/.test(element.textContent || '')), undefined, { timeout: 30_000 })
    report.sendElapsedMs = Date.now() - sendStarted
    sampler.phase('settled')
    await pause(1200)
    await page.screenshot({ path: path.join(evidence, 'after-send.png'), fullPage: false })
    report.memory = await sampler.stop()
    sampler = undefined
    assert(report.memory.samples.some(sample => sample.phase === 'send' && sample.processes.some(entry => entry.type === 'Tab' && entry.memory.workingSetSize > 0)), 'No renderer memory sample was collected during send')
    report.provider = observations
    report.session = await inspectIsolatedImageSession(page, identity)
    assert.equal(report.session.messageAttachmentCount, 11)
    assert.equal(report.session.draft.attachmentCount, 0)
    assert(report.session.messages.some(message => message.role === 'assistant' && message.content.trim() === 'ok'))
    const storedHashes = report.session.messages.flatMap(message => message.attachments).map(attachment => attachment.urlSha256)
    assert.deepEqual(storedHashes, report.session.seedSources.map(source => source.urlSha256), 'Persisted original attachment URLs changed')
    report.originalFilesUnchanged = true
    for (const entry of originalHashes) {
      assert.equal(sha256(await fs.readFile(entry.path)), entry.sha256, 'A synthetic source file changed')
    }
    const beforeCrashes = await runtimeSnapshot(appHandle)
    report.runtimeAfterSend = beforeCrashes
    assert.deepEqual(beforeCrashes.guard.renderProcessGone, [], 'A renderer exited naturally before the intentional recovery test')
    if (crashTwice) {
      const ownedWindow = beforeCrashes.windows.find(win => win.url.includes('/renderer/index.html'))
      assert(ownedWindow, 'Owned renderer window is missing')
      nativePage = nativeRendererProbe(appHandle, ownedWindow.webContentsId)
      for (let attempt = 1; attempt <= 2; attempt++) {
        report.stage = 'forced-recovery-' + attempt
        const recoveryStarted = Date.now()
        await appHandle.evaluate(({ webContents }, { id, attempt }) => {
          const contents = webContents.fromId(id)
          if (!contents || contents.isDestroyed() || contents.isCrashed()) throw new Error('Owned renderer is unavailable before crash')
          const probe = { attempt, webContentsId: id, loaded: false }
          globalThis.__MAGICPOT_IMAGE_DESKTOP__.recoveryProbe = probe
          contents.once('did-finish-load', () => { probe.loaded = true })
          contents.forcefullyCrashRenderer()
        }, { id: ownedWindow.webContentsId, attempt })
        await until(async () => {
          const loaded = await within(appHandle.evaluate(() => globalThis.__MAGICPOT_IMAGE_DESKTOP__.recoveryProbe?.loaded === true), 5000, 'native load state')
          if (!loaded) return false
          try {
            return await nativePage.evaluate(({ scope, sessionId }) => {
              const pane = document.querySelector('[data-agent-workspace-pane="agent-1"][data-agent-workspace-scope="' + scope + '"]')
              const rows = [...(pane?.querySelectorAll('[data-chat-message-index]') || [])]
              return pane?.getAttribute('aria-hidden') === 'false' &&
                Boolean(pane.querySelector('[data-chat-scroll-container="true"]') && pane.querySelector('[data-testid="chat-composer-input"]')) &&
                localStorage.getItem('chat.currentSessionId.' + scope) === sessionId &&
                rows.some(row => (row.textContent || '').includes('Fixture ' + sessionId)) &&
                rows.some(row => /\bok\b/.test(row.textContent || ''))
            }, identity)
          } catch { return false }
        }, 60_000, 'automatic renderer recovery ' + attempt)
        const recovered = await inspectIsolatedImageSession(page, identity, { evaluate: nativePage.evaluate })
        assert.equal(recovered.currentSessionId, identity.sessionId)
        assert.equal(recovered.messageAttachmentCount, 11)
        assert.equal(recovered.messageCount, report.session.messageCount)
        assert(recovered.ui.panePresent && recovered.ui.sendButtonPresent && recovered.ui.errorTexts.length === 0)
        assert(recovered.messages.some(message => message.role === 'assistant' && message.content.trim() === 'ok'))
        assert.deepEqual(recovered.messages.flatMap(message => message.attachments).map(attachment => attachment.urlSha256), storedHashes)
        assert.equal(mock.observations().length, 1, 'Recovery replayed the model request')
        await nativePage.screenshot({ path: path.join(evidence, 'recovered-' + attempt + '.png') })
        report.recovery.push({ attempt, uiMessagesVerified: true, elapsedMs: Date.now() - recoveryStarted, webContentsId: ownedWindow.webContentsId, messageCount: recovered.messageCount, attachmentCount: recovered.messageAttachmentCount, currentSessionId: recovered.currentSessionId })
      }
    }
    report.runtimeFinal = await assertIsolatedRuntime(appHandle, nativePage ?? page, runRoot, mock.baseURL)
    assert.equal(report.runtimeFinal.guard.renderProcessGone.length, crashTwice ? 2 : 0, 'Unexpected renderer exit count')
    assert(report.runtimeFinal.guard.renderProcessGone.every(event => event.reason === 'crashed'), 'Unexpected renderer exit reason')
    report.status = 'passed'
    report.stage = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error.name, message: error.message, stack: error.stack }
    if (sampler) {
      report.memory = await sampler.stop()
      sampler = undefined
    }
    if (page) {
      try { await (nativePage ?? page).screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }) } catch { /* A failed renderer may not support screenshots. */ }
      try { report.bodyDiagnostic = await (nativePage ?? page).evaluate(() => (document.body?.innerText || '').slice(0, 6000)) } catch { /* Preserve the original failure if the page is gone. */ }
      if (identity) {
        try { report.session = await inspectIsolatedImageSession(page, identity, nativePage ? { evaluate: nativePage.evaluate } : undefined) } catch { /* Database diagnostics are best effort after a failure. */ }
      }
    }
    if (appHandle) {
      try { report.runtimeFinal = await runtimeSnapshot(appHandle) } catch { /* The owned process may already have exited. */ }
    }
    report.provider = mock.observations()
  } finally {
    if (sampler) report.memory = await sampler.stop()
    if (appHandle) {
      const child = appHandle.process()
      const deadline = setTimeout(() => child.kill(), 15_000)
      try { await appHandle.close() } catch { /* The owned process may already have exited. */ }
      clearTimeout(deadline)
    }
    await mock.close()
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
    await fs.writeFile(path.join(evidence, 'main-output.log'), output + '\n--- stderr ---\n' + errors)
  }
  console.log('isolated-image-desktop-result', JSON.stringify({
    status: report.status, stage: report.stage, error: report.error?.message,
    runRoot, sendElapsedMs: report.sendElapsedMs, provider: report.provider,
    peaks: report.memory?.peaksByPhaseAndProcessType,
    recovery: report.recovery
  }))
  return report
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass isolated runRoot and private worker source paths.')
  const result = await runIsolatedImageDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]), { crashTwice: !process.argv.includes('--no-crash-recovery') })
  process.exitCode = result.status === 'passed' ? 0 : 1
}
