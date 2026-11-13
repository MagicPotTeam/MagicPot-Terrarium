import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { isolatedImageEnvironment, fixtureConfig, assertIsolatedRuntime } from './isolatedImageDesktopAcceptance.mjs'
import { startSyntheticResponsesMock } from './syntheticResponsesMock.mjs'
import {
  seedIsolatedThreadGoalsSession, openIsolatedThreadGoals,
  createIsolatedThreadGoal, setIsolatedThreadGoalStatus,
  closeIsolatedThreadGoals, inspectIsolatedThreadGoals
} from './isolatedThreadGoalsFixture.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const profileId = 'isolated-image-responses'
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normalized(value).startsWith(normalized(parent) + '/')

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), milliseconds) })
    ])
  } finally { clearTimeout(timer) }
}

async function privateKeyState(runRoot) {
  const result = {}
  for (const [name, relative] of [
    ['sessionData', 'storage/Data/sessionData/Local State'],
    ['userData', 'storage/Data/Local State']
  ]) {
    try {
      const filename = path.join(runRoot, relative)
      const stat = await fs.lstat(filename)
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024)
      const value = JSON.parse(await fs.readFile(filename, 'utf8'))
      result[name] = { present: true, keyReady: typeof value?.os_crypt?.encrypted_key === 'string' && value.os_crypt.encrypted_key.length > 0 }
    } catch {
      result[name] = { present: false, keyReady: false }
    }
  }
  return result
}

async function inspectDatabase(runRoot, expectedRevision) {
  const filename = path.join(runRoot, 'storage/Data/agent-thread-goals/goals-v1.sqlite')
  assert(inside(runRoot, await fs.realpath(filename)), 'Goal database escaped the owned root')
  const stat = await fs.stat(filename)
  assert(stat.size > 0 && stat.size <= 16 * 1024 * 1024, 'Unexpected private goal database size')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    const rows = database.prepare('SELECT revision, length(cipher) AS cipherBytes, hex(substr(cipher, 1, 8)) AS prefix FROM goals').all()
    const applicationId = database.prepare('PRAGMA application_id').get().application_id
    const userVersion = database.prepare('PRAGMA user_version').get().user_version
    const journalMode = database.prepare('PRAGMA journal_mode').get().journal_mode
    assert.equal(applicationId, 1297106737)
    assert.equal(userVersion, 1)
    assert.equal(journalMode, 'delete')
    assert.equal(rows.length, 1, 'Only the one synthetic goal owner should exist')
    assert.equal(rows[0].revision, expectedRevision)
    assert(rows[0].cipherBytes > 8)
    assert.equal(rows[0].prefix.toUpperCase(), Buffer.from('MPICB001').toString('hex').toUpperCase())
    return { filename, fileBytes: stat.size, applicationId, userVersion, journalMode, rows }
  } finally { database.close() }
}

async function closeOwned(appHandle) {
  const child = appHandle.process()
  let killed = false
  const fallback = setTimeout(() => { killed = true; child.kill() }, 15_000)
  let closeError
  try {
    try { await appHandle.close() } catch (error) { closeError = error.message }
    if (child.exitCode === null && child.signalCode === null) {
      await within(new Promise(resolve => child.once('close', resolve)), 5000, 'owned launched process exit')
    }
  } finally { clearTimeout(fallback) }
  assert(!killed, 'The owned launched process required forced cleanup')
  assert(child.exitCode !== null || child.signalCode !== null, 'The owned launched process exit was not observed')
  return { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closeError: closeError ?? null, forced: killed }
}

/** Real manual Goals UI/IPC/SQLite, followed by a full owned Electron restart.
 * The loopback model remains observation-only: no chat or model call is expected. */
export async function runIsolatedThreadGoalsDesktop(runRoot, workerSource) {
  assert(path.isAbsolute(runRoot) && inside(privateRoot, runRoot), 'Use a new owned private run root')
  assert(path.isAbsolute(workerSource) && inside(privateRoot, workerSource), 'Use the existing private worker')
  const runId = path.basename(runRoot)
  const base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  const appRoot = path.join(runRoot, 'app')
  const packageData = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageData.name, 'magicpot-isolated-image-acceptance')
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  await fs.access(mainEntry)
  for (const directory of ['bin', 'cwd', 'storage/Data', 'storage/Projects', 'evidence', 'home', 'appdata', 'localappdata', 'temp']) {
    await fs.mkdir(path.join(runRoot, directory), { recursive: true })
  }
  const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
  const mock = await startSyntheticResponsesMock()
  const report = {
    status: 'running', stage: 'prepare', runRoot, startedAt: new Date().toISOString(),
    states: [], runtime: [], database: [], launches: [], cleanup: [], encryptionWarmup: null, initialOpenMustSucceed: true
  }
  let appHandle, page, identity
  const evidence = path.join(runRoot, 'evidence')
  const outputs = []
  const assertNoModelRequest = () => assert.equal(mock.observations().length, 0, 'A manual goal action triggered a model request')

  async function launch(cycle) {
    const handle = await electron.launch({
      executablePath: require('electron'),
      args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'),
        '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'),
        '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling'],
      cwd: path.join(runRoot, 'cwd'),
      env: isolatedImageEnvironment(runRoot, base, runId),
      timeout: 90_000
    })
    appHandle = handle
    const log = { cycle, stdout: '', stderr: '' }
    outputs.push(log)
    handle.process().stdout?.on('data', chunk => { log.stdout = (log.stdout + chunk.toString()).slice(-65_536) })
    handle.process().stderr?.on('data', chunk => { log.stderr = (log.stderr + chunk.toString()).slice(-65_536) })
    page = await handle.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    const runtime = await assertIsolatedRuntime(handle, page, runRoot, mock.baseURL)
    assert.equal(runtime.guard.blockedRequestCount, 0)
    assert.deepEqual(runtime.guard.renderProcessGone, [])
    report.runtime.push({ cycle, point: 'launch', ...runtime })
    report.launches.push({ cycle, pid: handle.process().pid })
    assertNoModelRequest()
  }

  async function capture(label, snapshot) {
    assertNoModelRequest()
    report.states.push({ label, ...snapshot })
    await page.screenshot({ path: path.join(evidence, label + '.png'), fullPage: false })
  }

  try {
    await fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL), null, 2), { flag: 'wx' })
    await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'),
      'require(' + JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' +
      JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n', { flag: 'wx' })
    report.stage = 'launch'
    await launch(1)
    report.stage = 'seed'
    identity = await seedIsolatedThreadGoalsSession(page, { profileId })
    report.identity = identity
    report.stage = 'open'
    // The product must recover its initial read while this panel stays open.
    // This runner does not close/reopen, prime a key, or retry a goal mutation.
    const empty = await openIsolatedThreadGoals(page, identity, { expectedStatus: 'empty' })
    await capture('empty', empty)
    report.stage = 'create'
    await capture('draft', await createIsolatedThreadGoal(page, identity))
    report.database.push({ point: 'draft', ...await inspectDatabase(runRoot, 1) })
    report.stage = 'activate'
    await capture('active', await setIsolatedThreadGoalStatus(page, identity, 'active'))
    report.database.push({ point: 'active', ...await inspectDatabase(runRoot, 2) })
    report.stage = 'pause'
    await capture('paused', await setIsolatedThreadGoalStatus(page, identity, 'paused'))
    report.database.push({ point: 'paused', ...await inspectDatabase(runRoot, 3) })
    report.stage = 'reopen'
    await closeIsolatedThreadGoals(page, identity)
    await capture('reopened', await openIsolatedThreadGoals(page, identity, { expectedStatus: 'paused' }))
    report.runtime.push({ cycle: 1, point: 'before-close', ...await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL) })
    report.stage = 'close-first'
    report.cleanup.push({ cycle: 1, ...await closeOwned(appHandle) })
    appHandle = undefined
    page = undefined

    report.stage = 'restart'
    await launch(2)
    report.stage = 'verify-persistence'
    await capture('after-restart', await openIsolatedThreadGoals(page, identity, { expectedStatus: 'paused' }))
    report.database.push({ point: 'after-restart', ...await inspectDatabase(runRoot, 3) })
    const finalRuntime = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.deepEqual(finalRuntime.guard.renderProcessGone, [])
    assert.equal(finalRuntime.guard.blockedRequestCount, 0)
    assert.deepEqual(finalRuntime.guard.pathErrors, [])
    report.runtime.push({ cycle: 2, point: 'verified', ...finalRuntime })
    assertNoModelRequest()
    report.status = 'passed'
    report.stage = 'complete'
  } catch (error) {
    report.status = 'failed'
    report.error = { message: error.message, stack: error.stack }
    if (page) {
      try { await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }) } catch { /* The owned page may have exited. */ }
      try { report.bodyDiagnostic = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 6000) } catch { /* Preserve the original failure. */ }
      if (identity) {
        try { report.sessionDiagnostic = await inspectIsolatedThreadGoals(page, identity) } catch (failure) { report.sessionDiagnosticError = failure.message }
      }
    }
    report.privateKeyState = await privateKeyState(runRoot)
  } finally {
    if (appHandle) {
      try { report.cleanup.push({ cycle: report.launches.length, ...await closeOwned(appHandle) }) }
      catch (error) { report.status = 'failed'; report.cleanupError = error.message }
    }
    await mock.close()
    report.provider = mock.observations()
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2))
    for (const output of outputs) {
      await fs.writeFile(path.join(evidence, 'main-output-' + output.cycle + '.log'), output.stdout + '\n--- stderr ---\n' + output.stderr)
    }
  }
  console.log('isolated-thread-goals-result', JSON.stringify({
    status: report.status, stage: report.stage, error: report.error?.message, cleanupError: report.cleanupError,
    runRoot, states: report.states.map(item => ({ label: item.label, goals: item.ui.goals })),
    database: report.database.map(item => ({ point: item.point, rows: item.rows })),
    providerRequests: report.provider.length, launches: report.launches, cleanup: report.cleanup,
    encryptionWarmup: report.encryptionWarmup
  }))
  return report
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass the new private run root and private worker path.')
  const report = await runIsolatedThreadGoalsDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  process.exitCode = report.status === 'passed' ? 0 : 1
}
