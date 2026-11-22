// Controlled private A/B experiment. One immutable app build, fresh profiles,
// identical synthetic sources and original sending path; only display PNGs differ.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import {
  isolatedImageEnvironment,
  fixtureConfig,
  assertIsolatedRuntime
} from '../isolatedImageDesktopAcceptance.mjs'
import { createDeterministicPng } from '../chatImageMemoryBenchmark.mjs'
import { startSyntheticResponsesMock } from '../syntheticResponsesMock.mjs'
import {
  seedIsolatedImageSession,
  sendIsolatedImageSession,
  inspectIsolatedImageSession
} from '../isolatedImageSendFixture.mjs'

const require = createRequire(import.meta.url)
const { createIsolatedCppPreviewPreloadSource } = require('./isolatedCppPreviewBridge.cjs')
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const normalized = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normalized(value).startsWith(normalized(parent) + '/')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const profileId = 'isolated-image-responses'

async function within(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Timed out: ' + label)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
async function until(check, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await pause(200)
  }
  throw Error('Timed out: ' + label)
}
async function closeOwned(handle) {
  const child = handle.process()
  let forced = false,
    closeError = null
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      forced = true
      child.kill()
    }
  }, 15_000)
  try {
    await within(handle.close(), 20_000, 'owned Electron close')
  } catch (error) {
    closeError = error.message
  } finally {
    clearTimeout(timer)
  }
  if (child.exitCode === null && child.signalCode === null) {
    await within(new Promise((resolve) => child.once('close', resolve)), 5000, 'owned process exit')
  }
  const result = {
    pid: child.pid,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    forced,
    closeError
  }
  assert(!forced && child.exitCode !== null, 'Owned Electron did not exit normally')
  return result
}
function summarizeSamples(samples) {
  const phases = {},
    overall = {}
  const max = (target, name, value) => {
    if (typeof value === 'number') target[name] = Math.max(target[name] ?? 0, value)
  }
  for (const sample of samples) {
    const phase = (phases[sample.phase] ||= {
      processesKB: {},
      rendererHeapBytes: {},
      mainNodeBytes: {}
    })
    for (const process of sample.processesKB ?? []) {
      const category = (phase.processesKB[process.type] ||= {})
      const total = (overall[process.type] ||= {})
      for (const field of ['workingSetSize', 'privateBytes', 'peakWorkingSetSize']) {
        max(category, field, process.memory[field])
        max(total, field, process.memory[field])
      }
    }
    for (const [key, value] of Object.entries(sample.rendererHeapBytes ?? {}))
      max(phase.rendererHeapBytes, key, value)
    for (const [key, value] of Object.entries(sample.mainNodeBytes ?? {}))
      max(phase.mainNodeBytes, key, value)
  }
  return {
    phases,
    overall,
    semantics:
      'Per-type maximum individual process counters; high-water fields are process lifetime values, not phase-local peaks. KB follows Electron. Heap counters are bytes and overlap OS counters.'
  }
}
export function validateMemorySamples(samples) {
  const validRendererSamplesByPhase = {}
  for (const phase of ['draft-ready', 'send', 'idle-after-send']) {
    const selected = samples.filter(
      (sample) =>
        sample.phase === phase &&
        Number.isSafeInteger(sample.rendererPid) &&
        sample.rendererPid > 0 &&
        sample.processesKB?.some(
          (p) =>
            p.pid === sample.rendererPid &&
            Number.isFinite(p.memory?.workingSetSize) &&
            p.memory.workingSetSize > 0
        )
    )
    assert(selected.length > 0, 'Missing valid owned renderer memory samples: ' + phase)
    assert(
      selected.some(
        (s) => Number.isFinite(s.rendererHeapBytes?.used) && s.rendererHeapBytes.used > 0
      ),
      'Missing detailed renderer heap samples: ' + phase
    )
    validRendererSamplesByPhase[phase] = selected.length
  }
  return {
    validRendererSamplesByPhase,
    errorSampleCount: samples.filter((s) => s.errors?.length).length,
    maxRequestedGapMs: samples.reduce(
      (max, s, i) => (i ? Math.max(max, s.requestedAt - samples[i - 1].requestedAt) : max),
      0
    ),
    maxReadDurationMs: Math.max(0, ...samples.map((s) => s.readDurationMs ?? 0))
  }
}
async function createSampler(handle, page) {
  const cdp = await page.context().newCDPSession(page)
  const samples = []
  let phase = 'ready-app',
    pending,
    stopped = false,
    lastDetailed = 0
  const collect = () => {
    if (stopped || pending) return pending
    const requestedAt = Date.now(),
      samplePhase = phase
    const detailed = requestedAt - lastDetailed >= 1000
    if (detailed) lastDetailed = requestedAt
    pending = Promise.allSettled([
      within(
        handle.evaluate(({ app, BrowserWindow }, detailed) => {
          const win = BrowserWindow.getAllWindows().find((item) =>
            item.webContents.getURL().includes('/renderer/index.html')
          )
          const node = detailed ? process.memoryUsage() : undefined
          return {
            sampledAt: Date.now(),
            mainPid: process.pid,
            rendererPid: win?.webContents.getOSProcessId(),
            mainNodeBytes: node && {
              heapUsed: node.heapUsed,
              heapTotal: node.heapTotal,
              external: node.external,
              arrayBuffers: node.arrayBuffers
            },
            processesKB: app
              .getAppMetrics()
              .map(({ pid, type, creationTime, memory }) => ({ pid, type, creationTime, memory }))
          }
        }, detailed),
        5000,
        'memory process sample'
      ),
      detailed
        ? within(cdp.send('Runtime.getHeapUsage'), 5000, 'renderer heap sample')
        : Promise.resolve(null)
    ])
      .then(([os, heap]) => {
        if (samples.length >= 2400) throw Error('Memory sample bound exceeded')
        const raw = heap.status === 'fulfilled' ? heap.value : null
        samples.push({
          phase: samplePhase,
          requestedAt,
          completedAt: Date.now(),
          readDurationMs: Date.now() - requestedAt,
          ...(os.status === 'fulfilled' ? os.value : {}),
          rendererHeapBytes: raw && {
            used: raw.usedSize,
            allocated: raw.totalSize,
            backingStorage: raw.backingStorageSize,
            embedderGcHeap: raw.embedderHeapUsedSize
          },
          errors: [
            os.status === 'rejected' ? 'process-unavailable' : null,
            heap.status === 'rejected' ? 'heap-unavailable' : null
          ].filter(Boolean)
        })
      })
      .finally(() => {
        pending = undefined
      })
    pending.catch(() => {})
    return pending
  }
  const timer = setInterval(collect, 250)
  await collect()
  return {
    async phase(value) {
      if (pending) await within(pending, 6000, 'previous memory sample')
      phase = value
      lastDetailed = 0
      await collect()
    },
    async stop() {
      stopped = true
      clearInterval(timer)
      if (pending) await within(pending, 5000, 'memory sampler stop')
      await cdp.detach().catch(() => {})
      return {
        intervalTargetMs: 250,
        detailedTargetMs: 1000,
        noForcedGc: true,
        screenshotsExcluded: true,
        nativeWorkersExcludedFromElectronMetrics: true,
        summary: summarizeSamples(samples),
        samples
      }
    }
  }
}
async function cppStats(handle) {
  return within(
    handle.evaluate(() => {
      const holder = globalThis.__MAGICPOT_CPP_PREVIEW_STATS__
      return typeof holder?.snapshot === 'function' ? holder.snapshot() : (holder ?? null)
    }),
    5000,
    'private preview statistics'
  )
}
async function prepareCase(runRoot, appSource, rustWorker, cppWorker, enabled) {
  assert(
    inside(privateRoot, runRoot) &&
      inside(privateRoot, appSource) &&
      inside(privateRoot, rustWorker) &&
      inside(privateRoot, cppWorker)
  )
  await fs.mkdir(runRoot, { recursive: false })
  for (const dir of [
    'app',
    'bin',
    'cwd',
    'storage/Data',
    'storage/Projects',
    'home',
    'appdata',
    'localappdata',
    'temp',
    'evidence'
  ])
    await fs.mkdir(path.join(runRoot, dir), { recursive: true })
  const appRoot = path.join(runRoot, 'app')
  const pkg = JSON.parse(await fs.readFile(path.join(appSource, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'magicpot-isolated-image-acceptance')
  await fs.writeFile(path.join(appRoot, 'package.json'), JSON.stringify(pkg, null, 2), {
    flag: 'wx'
  })
  await fs.cp(path.join(appSource, 'out'), path.join(appRoot, 'out'), {
    recursive: true,
    force: false,
    errorOnExist: true
  })
  await fs.symlink(
    path.join(repoRoot, 'node_modules'),
    path.join(appRoot, 'node_modules'),
    'junction'
  )
  const rustPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  const cppPath = path.join(runRoot, 'bin/wic-preview-worker.exe')
  await fs.copyFile(rustWorker, rustPath, constants.COPYFILE_EXCL)
  await fs.copyFile(cppWorker, cppPath, constants.COPYFILE_EXCL)
  await fs.appendFile(
    path.join(appRoot, 'out/preload/index.js'),
    '\n;' + createIsolatedCppPreviewPreloadSource({ enabled }) + '\n'
  )
  return {
    appRoot,
    rustPath,
    cppPath,
    cppSha256: sha256(await fs.readFile(cppPath)),
    rustSha256: sha256(await fs.readFile(rustPath))
  }
}
async function runCase({ runRoot, appSource, rustWorker, cppWorker, enabled, sources }) {
  const files = await prepareCase(runRoot, appSource, rustWorker, cppWorker, enabled)
  const runId = path.basename(runRoot),
    base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  const mock = await startSyntheticResponsesMock({ observeImageHashes: true })
  const report = {
    status: 'running',
    enabled,
    runRoot,
    startedAt: new Date().toISOString(),
    stage: 'prepare',
    sources: sources.hashes,
    rustSha256: files.rustSha256,
    cppSha256: files.cppSha256,
    fixture: 'identical 8x4096 PNG + 3x32 history; injected draft, not OS drag/drop'
  }
  let handle,
    page,
    sampler,
    output = '',
    stderr = ''
  const evidence = path.join(runRoot, 'evidence')
  try {
    await fs.writeFile(
      path.join(runRoot, 'storage/Data/config.json'),
      JSON.stringify(fixtureConfig(mock.baseURL), null, 2),
      { flag: 'wx' }
    )
    const bootstrap = [
      'require(' +
        JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) +
        ').startIsolatedImageDesktop(' +
        JSON.stringify({
          runRoot,
          mainEntry: path.join(files.appRoot, 'out/main/index.js'),
          mockOrigin: new URL(mock.baseURL).origin,
          workerPath: files.rustPath
        }) +
        ');',
      'Promise.resolve(require(' +
        JSON.stringify(path.join(repoRoot, 'scripts/chat/native/isolatedCppPreviewBridge.cjs')) +
        ').installIsolatedCppPreviewBridge(' +
        JSON.stringify({
          runRoot,
          workerPath: files.cppPath,
          workerSha256: files.cppSha256,
          enabled
        }) +
        ')).catch(error => { console.error("private-preview-bridge-start-failed", error.message); process.exit(1) });',
      ''
    ].join('\n')
    await fs.writeFile(path.join(files.appRoot, 'bootstrap.cjs'), bootstrap, { flag: 'wx' })
    report.stage = 'launch'
    handle = await electron.launch({
      executablePath: require('electron'),
      args: [
        files.appRoot,
        '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
        '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'
      ],
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId),
      timeout: 90_000
    })
    handle.process().stdout?.on('data', (value) => {
      output = (output + value.toString()).slice(-65_536)
    })
    handle.process().stderr?.on('data', (value) => {
      stderr = (stderr + value.toString()).slice(-65_536)
    })
    page = await handle.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(
      () =>
        Boolean(
          window.api?.svcState &&
          window.__MAGICPOT_CPP_PREVIEW__ &&
          document.querySelector('#root')?.childElementCount
        ),
      undefined,
      { timeout: 90_000 }
    )
    assert.equal(await page.evaluate(() => window.__MAGICPOT_CPP_PREVIEW__.enabled), enabled)
    await until(
      async () => Boolean(await cppStats(handle)),
      10_000,
      'private preview bridge readiness'
    )
    report.runtimeBefore = await within(
      assertIsolatedRuntime(handle, page, runRoot, mock.baseURL),
      10_000,
      'runtime before'
    )
    sampler = await createSampler(handle, page)
    await pause(1000)
    report.stage = 'fixture-injection'
    await sampler.phase('fixture-injection')
    const readyStarted = Date.now()
    const identity = await seedIsolatedImageSession(page, {
      largePaths: sources.largePaths,
      historyPaths: sources.historyPaths,
      profileId
    })
    report.identity = identity
    await sampler.phase('preview-ready-wait')
    report.stage = 'preview-ready'
    await page.waitForFunction(
      (enabled) => {
        const section = document.querySelector('[data-testid="chat-composer-attachments"]')
        const images = section ? [...section.querySelectorAll('img')] : []
        return (
          images.length === 8 &&
          images.every(
            (img) =>
              img.complete &&
              img.naturalWidth === (enabled ? 512 : 4096) &&
              img.naturalHeight === (enabled ? 512 : 4096)
          )
        )
      },
      enabled,
      { timeout: 90_000 }
    )
    await until(
      async () => (await cppStats(handle))?.inFlight === 0,
      30_000,
      'preview children idle'
    )
    report.draftReadyMs = Date.now() - readyStarted
    report.previewBeforeSend = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="chat-composer-attachments"] img')].map(
        (img) => ({ width: img.naturalWidth, height: img.naturalHeight, complete: img.complete })
      )
    )
    await sampler.phase('draft-ready')
    await pause(1000)
    report.stage = 'send'
    await sampler.phase('send')
    const sendStarted = Date.now()
    await sendIsolatedImageSession(page, identity)
    await until(() => mock.observations().length > 0, 150_000, 'single actual model request')
    await sampler.phase('provider-observed')
    assert.equal(mock.observations().length, 1, 'Duplicate model request')
    assert.equal(mock.observations()[0].imageCount, 11, 'Image count changed')
    assert(mock.observations()[0].bytes <= 28 * 1024 * 1024)
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-chat-message-index]')].some((el) =>
          /\bok\b/.test(el.textContent || '')
        ),
      undefined,
      { timeout: 30_000 }
    )
    report.sendElapsedMs = Date.now() - sendStarted
    await sampler.phase('idle-after-send')
    await pause(3000)
    await until(
      async () => (await cppStats(handle))?.inFlight === 0,
      30_000,
      'all preview children idle'
    )
    report.memory = await sampler.stop()
    sampler = undefined
    report.memory.quality = validateMemorySamples(report.memory.samples)
    // Screenshots and full IDB/string inspection happen only after memory sampling.
    report.cpp = await cppStats(handle)
    assert.equal(report.cpp.inFlight, 0)
    assert.equal(report.cpp.rejected, 0)
    assert.equal(report.cpp.enabled, enabled)
    if (enabled) assert(report.cpp.completed >= 8, 'Native previews were not exercised')
    else assert.equal(report.cpp.requests, 0, 'Control unexpectedly requested native previews')
    report.rendererPreview = await page.evaluate(() => {
      const holder = window.__MAGICPOT_CPP_PREVIEW_RENDERER__
      return typeof holder?.snapshot === 'function' ? holder.snapshot() : (holder ?? null)
    })
    await page.screenshot({ path: path.join(evidence, 'after-send.png'), fullPage: false })
    report.session = await inspectIsolatedImageSession(page, identity)
    assert.equal(report.session.messageAttachmentCount, 11)
    assert.equal(report.session.draft.attachmentCount, 0)
    assert(
      report.session.messages.some(
        (message) => message.role === 'assistant' && message.content.trim() === 'ok'
      )
    )
    assert.deepEqual(
      report.session.messages.flatMap((message) => message.attachments).map((a) => a.urlSha256),
      report.session.seedSources.map((s) => s.urlSha256),
      'Persisted original URLs changed'
    )
    for (const entry of sources.hashes)
      assert.equal(sha256(await fs.readFile(entry.path)), entry.sha256, 'Original source changed')
    report.runtimeAfter = await within(
      assertIsolatedRuntime(handle, page, runRoot, mock.baseURL),
      10_000,
      'runtime after'
    )
    assert.deepEqual(report.runtimeAfter.guard.renderProcessGone, [])
    assert.deepEqual(report.runtimeAfter.guard.pathErrors, [])
    assert.equal(report.runtimeAfter.guard.blockedRequestCount, 0)
    report.provider = mock.observations()
    report.originalFilesUnchanged = true
    report.status = 'passed'
    report.stage = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.error = { message: error.message, stack: error.stack }
    if (sampler) {
      try {
        report.memory = await sampler.stop()
      } catch (e) {
        report.memoryError = e.message
      }
      sampler = undefined
    }
    if (handle)
      try {
        report.cpp = await cppStats(handle)
      } catch {
        /* Bounded diagnostic; always reach cleanup. */
      }
    if (page) {
      try {
        await within(
          page.screenshot({ path: path.join(evidence, 'failure.png') }),
          3000,
          'failure screenshot'
        )
      } catch {
        /* Page may be unavailable. */
      }
      try {
        report.body = (await within(page.locator('body').innerText(), 3000, 'failure text')).slice(
          0,
          6000
        )
      } catch {
        /* Page may be unavailable. */
      }
    }
  } finally {
    if (sampler) {
      try {
        report.memory = await sampler.stop()
      } catch (error) {
        report.memoryError = error.message
      }
    }
    if (handle) {
      try {
        report.cleanup = await closeOwned(handle)
      } catch (error) {
        report.status = 'failed'
        report.cleanupError = error.message
      }
    }
    await mock.close()
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(evidence, 'main-output.log'), output + '\n' + stderr, {
      flag: 'wx'
    })
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2), {
      flag: 'wx'
    })
  }
  return report
}
export async function runIsolatedCppPreviewExperiment({ base, appSource, rustWorker, cppWorker }) {
  for (const value of [base, appSource, rustWorker, cppWorker])
    assert(path.isAbsolute(value) && inside(privateRoot, value), 'Only private experiment paths')
  await fs.mkdir(base, { recursive: false })
  await fs.mkdir(path.join(base, '.magicpot-trash/MagicPot'), { recursive: true })
  const fixtureRoot = path.join(base, 'fixtures')
  await fs.mkdir(fixtureRoot)
  const sources = { largePaths: [], historyPaths: [], hashes: [] }
  for (let index = 0; index < 11; index++) {
    const large = index < 8
    const bytes = createDeterministicPng(
      large ? index : index + 12,
      large ? 4096 : 32,
      large ? 4096 : 32
    )
    const file = path.join(fixtureRoot, (large ? 'large-' : 'history-') + index + '.png')
    await fs.writeFile(file, bytes, { flag: 'wx' })
    ;(large ? sources.largePaths : sources.historyPaths).push(file)
    sources.hashes.push({ path: file, bytes: bytes.length, sha256: sha256(bytes) })
  }
  const comparison = {
    status: 'running',
    startedAt: new Date().toISOString(),
    appSource,
    design:
      'One app artifact; fresh profiles; A B B A order; identical source PNGs; no forced GC; one send per case; no repeated crash acceptance; screenshots after sampling.',
    cases: []
  }
  try {
    for (const [name, enabled] of [
      ['control-1', false],
      ['cpp-1', true],
      ['cpp-2', true],
      ['control-2', false]
    ]) {
      const report = await runCase({
        runRoot: path.join(base, '.magicpot-trash/MagicPot', name),
        appSource,
        rustWorker,
        cppWorker,
        enabled,
        sources
      })
      const summary = {
        name,
        enabled,
        status: report.status,
        stage: report.stage,
        error: report.error,
        runRoot: report.runRoot,
        draftReadyMs: report.draftReadyMs,
        sendElapsedMs: report.sendElapsedMs,
        memory: report.memory?.summary,
        cpp: report.cpp,
        provider: report.provider,
        cleanup: report.cleanup
      }
      comparison.cases.push(summary)
      console.log('cpp-preview-case', JSON.stringify(summary))
      await fs.writeFile(path.join(base, 'comparison.json'), JSON.stringify(comparison, null, 2))
      assert.equal(report.status, 'passed', 'Experiment case failed: ' + name)
    }
    const bodies = comparison.cases.map((c) => c.provider[0].bytes)
    assert(
      bodies.every((value) => value === bodies[0]),
      'Provider payload size differs between identical image cases'
    )
    const firstImages = comparison.cases[0].provider[0].imageUrlSha256
    assert.equal(firstImages.length, 11)
    for (const entry of comparison.cases)
      assert.deepEqual(
        entry.provider[0].imageUrlSha256,
        firstImages,
        'Actual model image bytes or order changed'
      )
    comparison.imagePayloadHashesMatch = true
    comparison.status = 'passed'
  } catch (error) {
    comparison.status = 'failed'
    comparison.error = error.message
  }
  comparison.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(base, 'comparison.json'), JSON.stringify(comparison, null, 2))
  return comparison
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [base, appSource, rustWorker, cppWorker] = process.argv.slice(2)
  assert(
    base && appSource && rustWorker && cppWorker,
    'Pass new base, private app artifact, Rust worker, C++ worker'
  )
  const result = await runIsolatedCppPreviewExperiment({ base, appSource, rustWorker, cppWorker })
  console.log(
    'cpp-preview-comparison',
    JSON.stringify({
      status: result.status,
      error: result.error,
      cases: result.cases.map((c) => ({ name: c.name, status: c.status, runRoot: c.runRoot }))
    })
  )
  if (result.status !== 'passed') process.exitCode = 1
}
