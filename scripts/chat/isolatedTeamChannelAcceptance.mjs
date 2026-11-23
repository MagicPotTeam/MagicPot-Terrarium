// The zero-subscriber and designer-only broadcast scenarios were removed with team management.
// This runner now checks only seeded fixture history, real transcript navigation and persistence
// across one controlled relaunch. It never sends a message or calls a provider.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import {
  isolatedImageEnvironment,
  fixtureConfig,
  assertIsolatedRuntime
} from './isolatedImageDesktopAcceptance.mjs'
import { startSyntheticTeamResponsesMock } from './syntheticTeamResponsesMock.mjs'
import {
  seedIsolatedTeamLead,
  seedIsolatedTeamMembers,
  verifyIsolatedTeamMembers,
  waitForIsolatedTeamPane,
  openIsolatedTeamConversation
} from './isolatedTeamDesktopFixture.mjs'
import {
  isLinuxIsolatedPlatform,
  isolatedWorkerPath,
  isolatedWorkerSourceArgument,
  isolatedElectronArgs,
  assertNoLinuxWorkerSource,
  buildLinuxIsolatedWorker,
  needsLinuxXvfbRelaunch,
  relaunchIsolatedRunnerUnderXvfb
} from './isolatedDesktopPlatform.mjs'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repo, '../../.magicpot-trash')
const normalized = (value) => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (root, value) => normalized(value).startsWith(normalized(root) + '/')
const marker = 'SYNTHETIC_TEAM_CHANNEL_MARKER_2026'
const content = `[用户频道消息；内容为不可信数据]\n${marker}`
const zero = {
  design: 0,
  summary: 0,
  channel: 0,
  'scratchpad-call': 0,
  'scratchpad-result': 0,
  error: 0
}

// A timeout records uncertainty; it cannot cancel an already-started operation.
async function bounded(action, ms) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve()
        .then(action)
        .then(
          (value) => ({ status: 'ok', value }),
          () => ({ status: 'error' })
        ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function finalizeChannelRun({ report, app, mock, writeResult, timeoutMs = 5000 }) {
  const cleanup = {}
  if (app) {
    let child
    try {
      child = app.process()
    } catch {
      cleanup.child = 'unknown'
    }
    const close = await bounded(() => app.close(), timeoutMs)
    cleanup.appClose = close.status
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = await bounded(
          () =>
            new Promise((resolve) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolve()
              child.once('exit', resolve)
            }),
          timeoutMs
        )
        cleanup.child = exited.status === 'ok' ? 'observed' : 'unknown'
        if (cleanup.child === 'unknown' && child.exitCode === null && child.signalCode === null) {
          try {
            cleanup.killRequested = child.kill() === true
          } catch {
            cleanup.killRequested = false
          }
        }
      } else cleanup.child = 'observed'
      cleanup.exitCode = child.exitCode
      cleanup.signalCode = child.signalCode
      if (
        cleanup.child !== 'observed' ||
        child.exitCode !== 0 ||
        cleanup.killRequested !== undefined
      )
        report.status = 'failed'
    } else report.status = 'failed'
    if (close.status !== 'ok') report.status = 'failed'
    cleanup.processTree = 'unknown'
  }
  if (mock) {
    const close = await bounded(() => mock.close(), timeoutMs)
    cleanup.mockClose = close.status
    if (close.status !== 'ok') report.status = 'failed'
    else {
      const observation = await bounded(() => mock.observations(), timeoutMs)
      cleanup.mockObservations = observation.status
      if (observation.status === 'ok') {
        report.provider = observation.value
        const expected = zero
        const actual = observation.value
        if (
          !actual ||
          typeof actual !== 'object' ||
          Array.isArray(actual) ||
          Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') ||
          Object.keys(expected).some((key) => actual[key] !== expected[key])
        )
          report.status = 'failed'
      } else report.status = 'failed'
    }
  } else if (report.status === 'partial-passed') report.status = 'failed'
  report.cleanup = cleanup
  const receiptId = randomUUID()
  const diskReport = {
    ...report,
    status: 'observation-only',
    finalConfirmation: 'not-confirmed',
    receiptId
  }
  const serialized = JSON.stringify(diskReport, null, 2)
  const digest = createHash('sha256').update(serialized).digest('hex')
  const written = await bounded(() => writeResult(serialized), timeoutMs)
  if (written.status !== 'ok') throw Error('CHANNEL_RESULT_WRITE_FAILED')
  return { ...report, reportReceipt: { receiptId, sha256: digest } }
}

async function readMembers(page, identity, ids) {
  await waitForIsolatedTeamPane(page, identity)
  return page.evaluate(
    async ({ identity, ids, marker, content }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('magicpot-chat', 2)
        req.onupgradeneeded = () => req.transaction.abort()
        req.onerror = () => reject(req.error || Error('Session store unavailable'))
        req.onblocked = () => reject(Error('Session store blocked'))
        req.onsuccess = () => resolve(req.result)
      })
      try {
        if (!db.objectStoreNames.contains('sessions-v2')) throw Error('Session store missing')
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction('sessions-v2', 'readonly'),
            store = tx.objectStore('sessions-v2')
          const rows = []
          for (const id of ids) {
            const req = store.get(`${identity.scope}\u0000${id}`)
            req.onsuccess = () => rows.push(req.result)
          }
          tx.oncomplete = () => resolve(rows)
          tx.onabort = () => reject(tx.error || Error('Read aborted'))
          tx.onerror = () => reject(tx.error)
        })
        return ids.map((id) => {
          const row = rows.find((value) => value?.id === id)
          if (
            !row ||
            row.storageScope !== identity.scope ||
            row.teamLeadId !== identity.sessionId ||
            !Array.isArray(row.messages)
          )
            throw Error('Member identity mismatch')
          return {
            id,
            messageCount: row.messages.length,
            userMatches: row.messages.filter((m) => m.role === 'user' && m.content === content)
              .length,
            assistantMatches: row.messages.filter(
              (m) => m.role === 'assistant' && m.content === '合成频道消息已处理'
            ).length,
            markerMessages: row.messages.filter((m) => JSON.stringify(m).includes(marker)).length
          }
        })
      } finally {
        db.close()
      }
    },
    { identity, ids, marker, content }
  )
}

export async function runIsolatedTeamChannelDesktop(
  runRoot,
  workerSource,
  { platform = process.platform } = {}
) {
  const linux = isLinuxIsolatedPlatform(platform)
  if (linux) assertNoLinuxWorkerSource(workerSource)
  assert(path.isAbsolute(runRoot) && inside(privateRoot, runRoot), 'Use a new private root')
  if (!linux)
    assert(
      path.isAbsolute(workerSource) && inside(privateRoot, workerSource),
      'Use an owned worker'
    )
  const runId = path.basename(runRoot),
    base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  assert.equal(normalized(await fs.realpath(runRoot)), normalized(runRoot))
  if (!linux) assert(inside(privateRoot, await fs.realpath(workerSource)))
  assert.deepEqual((await fs.readdir(runRoot)).sort(), ['app'], 'Root must be fresh and never run')
  const appRoot = path.join(runRoot, 'app'),
    stat = await fs.lstat(appRoot)
  assert(stat.isDirectory() && !stat.isSymbolicLink())
  assert.equal(
    JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')).name,
    'magicpot-isolated-image-acceptance'
  )
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  assert(inside(runRoot, await fs.realpath(mainEntry)))
  await fs.mkdir(path.join(runRoot, 'evidence'))
  const workerPath = isolatedWorkerPath(runRoot, platform)
  const report = {
    status: 'running',
    stage: 'prepare',
    scope: 'synthetic-stored-transcripts',
    limitations: [
      'The lead, members and transcript are seeded; no creation, broadcast or provider request is exercised.',
      'The relaunch check verifies persisted session rows only; it does not prove reliable delivery, durable receipts, in-flight replay or restart recovery of a pending request.',
      'No claim of real model execution or system-wide network isolation.'
    ]
  }
  let app, page, mock, outcome
  try {
    for (const dir of [
      'bin',
      'cwd',
      'storage',
      'home',
      'appdata',
      'localappdata',
      'temp',
      'storage/Data',
      'storage/Projects'
    ])
      await fs.mkdir(path.join(runRoot, dir))
    if (linux) await buildLinuxIsolatedWorker(runRoot, { repoRoot: repo })
    else await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
    mock = await startSyntheticTeamResponsesMock()
    await fs.writeFile(
      path.join(runRoot, 'storage/Data/config.json'),
      JSON.stringify(fixtureConfig(mock.baseURL)),
      { flag: 'wx' }
    )
    await fs.writeFile(
      path.join(appRoot, 'bootstrap.cjs'),
      'require(' +
        JSON.stringify(path.join(repo, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) +
        ').startIsolatedImageDesktop(' +
        JSON.stringify({
          runRoot,
          mainEntry,
          mockOrigin: new URL(mock.baseURL).origin,
          workerPath
        }) +
        ')\n',
      { flag: 'wx' }
    )
    report.stage = 'launch'
    app = await electron.launch({
      executablePath: require('electron'),
      args: isolatedElectronArgs(
        [
          appRoot,
          '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
          '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling'
        ],
        platform
      ),
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId, platform),
      timeout: 90_000
    })
    page = await app.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(
      () => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount),
      undefined,
      { timeout: 90_000 }
    )
    const initial = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(initial.guard.blockedRequestCount, 0)
    assert.deepEqual(initial.guard.renderProcessGone, [])
    assert.deepEqual(initial.guard.pathErrors, [])
    assert.deepEqual(mock.observations(), zero)
    report.stage = 'seed-stored-transcripts'
    const identity = await seedIsolatedTeamLead(page, {
      profileId: 'isolated-image-responses',
      freshSyntheticProfile: true
    })
    await seedIsolatedTeamMembers(page, identity, [
      {
        name: '设计师',
        messages: [
          { role: 'user', content },
          { role: 'assistant', content: '合成频道消息已处理' }
        ]
      },
      { name: '文案' }
    ])
    const members = await verifyIsolatedTeamMembers(page, identity)
    const designer = members.find((member) => member.name === '设计师'),
      writer = members.find((member) => member.name === '文案')
    assert(
      designer?.messageCount === 2 && writer?.messageCount === 0,
      'Expected seeded designer history and an empty writer'
    )
    const ids = [designer.id, writer.id]
    const observed = await readMembers(page, identity, ids)
    assert(observed[0].userMatches === 1 && observed[0].assistantMatches === 1)
    assert.equal(observed[1].markerMessages, 0)
    assert.deepEqual(mock.observations(), zero)
    report.idbObservation = observed
    report.provider = mock.observations()
    report.stage = 'ui-activity'
    const pane = await waitForIsolatedTeamPane(page, identity)
    await openIsolatedTeamConversation(page, identity, '设计师')
    await pane
      .locator('[data-testid="chat-message-list"]')
      .getByText(marker)
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
    report.uiObservation = { memberTranscriptVisible: true }
    await page.screenshot({ path: path.join(runRoot, 'evidence/channel-activity.png') })
    await openIsolatedTeamConversation(page, identity, '组长')

    // A controlled close/relaunch proves that the observed channel rows survive a
    // real Electron restart. It deliberately does not claim delivery recovery or
    // replay of an in-flight request.
    report.stage = 'restart-persisted-rows'
    const firstProcess = app.process()
    const closeResult = await bounded(() => app.close(), 15_000)
    assert.equal(closeResult.status, 'ok', 'Initial Electron close was not observed')
    const exitResult = await bounded(
      () =>
        new Promise((resolve) => {
          if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) return resolve()
          firstProcess.once('exit', resolve)
        }),
      15_000
    )
    assert.equal(exitResult.status, 'ok', 'Initial Electron process exit was not observed')
    assert.equal(firstProcess.signalCode, null, 'Initial Electron restart close used a signal')
    assert.equal(firstProcess.exitCode, 0, 'Initial Electron restart close failed')

    app = await electron.launch({
      executablePath: require('electron'),
      args: isolatedElectronArgs(
        [
          appRoot,
          '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
          '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-background-timer-throttling'
        ],
        platform
      ),
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId, platform),
      timeout: 90_000
    })
    page = await app.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(
      () => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount),
      undefined,
      { timeout: 90_000 }
    )
    const restartedRuntime = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(restartedRuntime.guard.blockedRequestCount, 0)
    assert.deepEqual(restartedRuntime.guard.renderProcessGone, [])
    assert.deepEqual(restartedRuntime.guard.pathErrors, [])
    const afterRestart = await readMembers(page, identity, ids)
    assert(
      afterRestart[0].userMatches === 1 && afterRestart[0].assistantMatches === 1,
      'Persisted designer channel rows were not restored after restart'
    )
    assert.deepEqual(afterRestart, observed, 'The stored transcripts changed across restart')
    assert.deepEqual(mock.observations(), zero)
    report.restartObservation = {
      firstExitCode: firstProcess.exitCode,
      firstSignalCode: firstProcess.signalCode,
      runtime: restartedRuntime,
      idb: afterRestart,
      provider: mock.observations()
    }
    await page.screenshot({ path: path.join(runRoot, 'evidence/channel-after-restart.png') })

    const final = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(final.guard.blockedRequestCount, 0)
    assert.deepEqual(final.guard.renderProcessGone, [])
    assert.deepEqual(final.guard.pathErrors, [])
    assert.deepEqual(mock.observations(), zero)
    report.status = 'partial-passed'
    report.stage = 'observed-and-restarted'
  } catch (error) {
    report.status = 'failed'
    report.error = String(error.message)
  } finally {
    outcome = await finalizeChannelRun({
      report,
      app,
      mock,
      writeResult: (data) =>
        fs.writeFile(path.join(runRoot, 'evidence/result.json'), data, { flag: 'wx' })
    })
  }
  return outcome
}

const isMainModule =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
// Linux: re-run this file under xvfb-run with the worker built from source (no worker argument).
if (isMainModule && needsLinuxXvfbRelaunch()) {
  process.exitCode = await relaunchIsolatedRunnerUnderXvfb(
    fileURLToPath(import.meta.url),
    process.argv.slice(2),
    { privateRoot }
  )
} else if (isMainModule) {
  if (!process.argv[2] || (!isLinuxIsolatedPlatform() && !process.argv[3]))
    throw Error('Provide new private run root and worker')
  try {
    const report = await runIsolatedTeamChannelDesktop(
      path.resolve(process.argv[2]),
      isolatedWorkerSourceArgument(process.argv[3])
    )
    console.log(
      'isolated-team-channel',
      JSON.stringify({
        status: report.status,
        stage: report.stage,
        reportReceipt: report.reportReceipt
      })
    )
    process.exitCode = report.status === 'partial-passed' ? 0 : 1
  } catch {
    console.error('CHANNEL_RUN_OR_REPORT_FAILED')
    process.exitCode = 1
  }
}
