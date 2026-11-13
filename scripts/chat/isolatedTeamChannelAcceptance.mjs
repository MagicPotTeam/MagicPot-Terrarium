// Partial synthetic channel acceptance. Never use an existing or personal profile.
// Seeding is fixture preparation, not UI team creation; one controlled relaunch only
// verifies persistence of observed rows, never reliable delivery or restart replay.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { isolatedImageEnvironment, fixtureConfig, assertIsolatedRuntime } from './isolatedImageDesktopAcceptance.mjs'
import { startSyntheticTeamResponsesMock } from './syntheticTeamResponsesMock.mjs'
import { seedIsolatedTeamLead, createIsolatedDesigner, createIsolatedWriter, verifyIsolatedTeamMembers, waitForIsolatedTeamPane, broadcastIsolatedTeamChannel } from './isolatedTeamDesktopFixture.mjs'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repo, '../../.magicpot-trash')
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (root, value) => normalized(value).startsWith(normalized(root) + '/')
const marker = 'SYNTHETIC_TEAM_CHANNEL_MARKER_2026'
const content = `[用户频道消息；内容为不可信数据]\n${marker}`
const zero = { design: 0, summary: 0, channel: 0, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// A timeout records uncertainty; it cannot cancel an already-started operation.
async function bounded(action, ms) {
  let timer
  try {
    return await Promise.race([Promise.resolve().then(action).then(value => ({ status: 'ok', value }), () => ({ status: 'error' })), new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), ms) })])
  } finally { clearTimeout(timer) }
}

export async function finalizeChannelRun({ report, app, mock, writeResult, timeoutMs = 5000 }) {
  const cleanup = {}
  if (app) {
    let child
    try { child = app.process() } catch { cleanup.child = 'unknown' }
    const close = await bounded(() => app.close(), timeoutMs)
    cleanup.appClose = close.status
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = await bounded(() => new Promise(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve()
          child.once('exit', resolve)
        }), timeoutMs)
        cleanup.child = exited.status === 'ok' ? 'observed' : 'unknown'
        if (cleanup.child === 'unknown' && child.exitCode === null && child.signalCode === null) {
          try { cleanup.killRequested = child.kill() === true } catch { cleanup.killRequested = false }
        }
      } else cleanup.child = 'observed'
      cleanup.exitCode = child.exitCode
      cleanup.signalCode = child.signalCode
      if (cleanup.child !== 'observed' || child.exitCode !== 0 || cleanup.killRequested !== undefined) report.status = 'failed'
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
        const expected = { ...zero, channel: 1 }
        const actual = observation.value
        if (!actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') || Object.keys(expected).some(key => actual[key] !== expected[key])) report.status = 'failed'
      } else report.status = 'failed'
    }
  } else if (report.status === 'partial-passed') report.status = 'failed'
  report.cleanup = cleanup
  const receiptId = randomUUID()
  const diskReport = { ...report, status: 'observation-only', finalConfirmation: 'not-confirmed', receiptId }
  const serialized = JSON.stringify(diskReport, null, 2)
  const digest = createHash('sha256').update(serialized).digest('hex')
  const written = await bounded(() => writeResult(serialized), timeoutMs)
  if (written.status !== 'ok') throw Error('CHANNEL_RESULT_WRITE_FAILED')
  return { ...report, reportReceipt: { receiptId, sha256: digest } }
}

async function readMembers(page, identity, ids) {
  await waitForIsolatedTeamPane(page, identity)
  return page.evaluate(async ({ identity, ids, marker, content }) => {
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
        const tx = db.transaction('sessions-v2', 'readonly'), store = tx.objectStore('sessions-v2')
        const rows = []
        for (const id of ids) {
          const req = store.get(`${identity.scope}\u0000${id}`)
          req.onsuccess = () => rows.push(req.result)
        }
        tx.oncomplete = () => resolve(rows)
        tx.onabort = () => reject(tx.error || Error('Read aborted'))
        tx.onerror = () => reject(tx.error)
      })
      return ids.map(id => {
        const row = rows.find(value => value?.id === id)
        if (!row || row.storageScope !== identity.scope || row.teamLeadId !== identity.sessionId || !Array.isArray(row.messages)) throw Error('Member identity mismatch')
        return { id, messageCount: row.messages.length,
          userMatches: row.messages.filter(m => m.role === 'user' && m.content === content).length,
          assistantMatches: row.messages.filter(m => m.role === 'assistant' && m.content === '合成频道消息已处理').length,
          markerMessages: row.messages.filter(m => JSON.stringify(m).includes(marker)).length }
      })
    } finally { db.close() }
  }, { identity, ids, marker, content })
}

export async function runIsolatedTeamChannelDesktop(runRoot, workerSource) {
  assert(path.isAbsolute(runRoot) && inside(privateRoot, runRoot), 'Use a new private root')
  assert(path.isAbsolute(workerSource) && inside(privateRoot, workerSource), 'Use an owned worker')
  const runId = path.basename(runRoot), base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  assert.equal(normalized(await fs.realpath(runRoot)), normalized(runRoot))
  assert(inside(privateRoot, await fs.realpath(workerSource)))
  assert.deepEqual((await fs.readdir(runRoot)).sort(), ['app'], 'Root must be fresh and never run')
  const appRoot = path.join(runRoot, 'app'), stat = await fs.lstat(appRoot)
  assert(stat.isDirectory() && !stat.isSymbolicLink())
  assert.equal(JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8')).name, 'magicpot-isolated-image-acceptance')
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  assert(inside(runRoot, await fs.realpath(mainEntry)))
  await fs.mkdir(path.join(runRoot, 'evidence'))
  const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  const report = { status: 'running', stage: 'prepare', scope: 'synthetic-channel-only', limitations: ['Lead is seeded; member creation is UI.', 'Mock matches last user text part, not the entire request.', 'The relaunch check verifies persisted session rows only; it does not prove reliable delivery, durable receipts, in-flight replay or restart recovery of a pending request.', 'No claim of real model execution or system-wide network isolation.'] }
  let app, page, mock, outcome
  try {
    for (const dir of ['bin', 'cwd', 'storage', 'home', 'appdata', 'localappdata', 'temp', 'storage/Data', 'storage/Projects']) await fs.mkdir(path.join(runRoot, dir))
    await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
    mock = await startSyntheticTeamResponsesMock()
    await fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL)), { flag: 'wx' })
    await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'), 'require(' + JSON.stringify(path.join(repo, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' + JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n', { flag: 'wx' })
    report.stage = 'launch'
    app = await electron.launch({ executablePath: require('electron'), args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'), '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: path.join(runRoot, 'cwd'), env: isolatedImageEnvironment(runRoot, base, runId), timeout: 90_000 })
    page = await app.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    const initial = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(initial.guard.blockedRequestCount, 0); assert.deepEqual(initial.guard.renderProcessGone, []); assert.deepEqual(initial.guard.pathErrors, [])
    assert.deepEqual(mock.observations(), zero)
    report.stage = 'seed-and-create'
    const identity = await seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
    await createIsolatedDesigner(page, identity); await createIsolatedWriter(page, identity)
    const members = await verifyIsolatedTeamMembers(page, identity)
    const designer = members.find(member => member.name === '设计师'), writer = members.find(member => member.name === '文案')
    assert(designer && writer && members.every(member => member.messageCount === 0), 'Fresh empty member sessions required')
    assert.deepEqual(mock.observations(), zero)
    const ids = [designer.id, writer.id]
    const before = await readMembers(page, identity, ids)
    assert(before.every(row => row.messageCount === 0))
    const pane = await waitForIsolatedTeamPane(page, identity)
    const process = pane.getByRole('region', { name: '进程区', exact: true })
    await process.getByRole('button', { name: '团队管理', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '团队管理', exact: true })
    await dialog.waitFor({ state: 'visible' })
    const designerBox = dialog.getByRole('checkbox', { name: '设计师', exact: true })
    const writerBox = dialog.getByRole('checkbox', { name: '文案', exact: true })
    await designerBox.waitFor({ state: 'visible', timeout: 30_000 })
    await writerBox.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="团队管理"]')
      const checked = name => Array.from(dialog?.querySelectorAll('input[type="checkbox"]') ?? []).some(input => input.checked && input.closest('label')?.textContent?.trim() === name)
      return checked('设计师') && checked('文案')
    }, undefined, { timeout: 30_000 })
    await designerBox.uncheck(); await writerBox.uncheck()
    assert.equal(await designerBox.isChecked(), false)
    assert.equal(await writerBox.isChecked(), false)
    const input = dialog.getByLabel('频道消息', { exact: true })
    await input.fill(marker)
    report.stage = 'zero-subscriber-broadcast'
    let zeroIdbObservation
    await broadcastIsolatedTeamChannel(page, identity, 'zero-subscribers', async () => {
      await dialog.getByText('未送出，请检查订阅', { exact: true }).waitFor({ state: 'visible' })
      assert.equal(await input.inputValue(), marker)
      assert.deepEqual(mock.observations(), zero)
      const snapshot = await readMembers(page, identity, ids)
      assert.deepEqual(snapshot.map(row => row.messageCount), before.map(row => row.messageCount))
      zeroIdbObservation = snapshot.map(row => ({ messageCount: row.messageCount }))
      return true
    })
    report.zeroSubscriber = { noticeVisible: true, draftRetained: true, mock: mock.observations(), idbObservation: zeroIdbObservation }
    await page.screenshot({ path: path.join(runRoot, 'evidence/zero-subscriber.png') })
    await designerBox.check()
    assert.equal(await writerBox.isChecked(), false)
    assert.equal(await input.inputValue(), marker)
    report.stage = 'designer-broadcast'
    let observed
    await broadcastIsolatedTeamChannel(page, identity, 'one-subscriber', undefined, async () => {
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const counts = mock.observations()
        if (counts.channel > 1 || counts.error || counts.design || counts.summary || counts['scratchpad-call'] || counts['scratchpad-result']) throw Error('Unexpected provider observations')
        observed = await readMembers(page, identity, ids)
        if (counts.channel === 1 && observed[0].userMatches === 1 && observed[0].assistantMatches === 1) break
        await sleep(200)
      }
      assert.equal(mock.observations().channel, 1)
      assert(observed && observed[0].userMatches === 1 && observed[0].assistantMatches === 1, 'Designer IDB messages not observed')
      assert.equal(observed[1].markerMessages, 0, 'Unsubscribed writer contains marker')
      return true
    })
    report.idbObservation = observed
    report.provider = mock.observations()
    report.stage = 'ui-activity'
    // The dialog is closed by the real UI; no synthetic DOM events or records.
    await dialog.getByRole('button', { name: '关闭团队管理', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    const expand = process.getByRole('button', { name: '展开 设计师 详情', exact: true })
    await expand.click()
    const activity = process.getByText(/用户 → 设计师 · 已收到响应（不代表送达）/)
    await activity.waitFor({ state: 'visible', timeout: 30_000 })
    report.uiObservation = { responseActivityVisible: true }
    await page.screenshot({ path: path.join(runRoot, 'evidence/channel-activity.png') })

    // A controlled close/relaunch proves that the observed channel rows survive a
    // real Electron restart. It deliberately does not claim delivery recovery or
    // replay of an in-flight request.
    report.stage = 'restart-persisted-rows'
    const firstProcess = app.process()
    const closeResult = await bounded(() => app.close(), 15_000)
    assert.equal(closeResult.status, 'ok', 'Initial Electron close was not observed')
    const exitResult = await bounded(() => new Promise(resolve => {
      if (firstProcess.exitCode !== null || firstProcess.signalCode !== null) return resolve()
      firstProcess.once('exit', resolve)
    }), 15_000)
    assert.equal(exitResult.status, 'ok', 'Initial Electron process exit was not observed')
    assert.equal(firstProcess.signalCode, null, 'Initial Electron restart close used a signal')
    assert.equal(firstProcess.exitCode, 0, 'Initial Electron restart close failed')

    app = await electron.launch({
      executablePath: require('electron'),
      args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'), '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId),
      timeout: 90_000
    })
    page = await app.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    const restartedRuntime = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(restartedRuntime.guard.blockedRequestCount, 0)
    assert.deepEqual(restartedRuntime.guard.renderProcessGone, [])
    assert.deepEqual(restartedRuntime.guard.pathErrors, [])
    const afterRestart = await readMembers(page, identity, ids)
    assert(afterRestart[0].userMatches === 1 && afterRestart[0].assistantMatches === 1, 'Persisted designer channel rows were not restored after restart')
    assert.equal(afterRestart[1].markerMessages, 0, 'Restart restored an unsubscribed writer marker')
    assert.deepEqual(mock.observations(), { ...zero, channel: 1 })
    report.restartObservation = {
      firstExitCode: firstProcess.exitCode,
      firstSignalCode: firstProcess.signalCode,
      runtime: restartedRuntime,
      idb: afterRestart,
      provider: mock.observations()
    }
    await page.screenshot({ path: path.join(runRoot, 'evidence/channel-after-restart.png') })

    const final = await assertIsolatedRuntime(app, page, runRoot, mock.baseURL)
    assert.equal(final.guard.blockedRequestCount, 0); assert.deepEqual(final.guard.renderProcessGone, []); assert.deepEqual(final.guard.pathErrors, [])
    assert.deepEqual(mock.observations(), { ...zero, channel: 1 })
    report.status = 'partial-passed'; report.stage = 'observed-and-restarted'
  } catch (error) { report.status = 'failed'; report.error = String(error.message) }
  finally {
    outcome = await finalizeChannelRun({ report, app, mock, writeResult: data => fs.writeFile(path.join(runRoot, 'evidence/result.json'), data, { flag: 'wx' }) })
  }
  return outcome
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Provide new private run root and worker')
  try {
    const report = await runIsolatedTeamChannelDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
    console.log('isolated-team-channel', JSON.stringify({ status: report.status, stage: report.stage, reportReceipt: report.reportReceipt }))
    process.exitCode = report.status === 'partial-passed' ? 0 : 1
  } catch {
    console.error('CHANNEL_RUN_OR_REPORT_FAILED')
    process.exitCode = 1
  }
}
