// Partial isolated-team desktop runner. The seed is fixture preparation; only
// the member forms are real UI. This is NOT the approval/image/summary acceptance.
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
  seedIsolatedTeamLead, createIsolatedDesigner, createIsolatedWriter, inspectIsolatedTeamPane, verifyIsolatedTeamMembers
} from './isolatedTeamDesktopFixture.mjs'

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

async function closeOwned(handle) {
  const child = handle.process()
  let forced = false
  const fallback = setTimeout(() => { forced = true; child.kill() }, 15_000)
  let closeError
  try {
    try { await handle.close() } catch (error) { closeError = error.message }
    if (child.exitCode === null && child.signalCode === null) {
      await within(new Promise(resolve => child.once('close', resolve)), 5000, 'owned process exit')
    }
  } finally { clearTimeout(fallback) }
  assert(!forced, 'Owned Electron required forced cleanup')
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned Electron exit was not observed')
  return { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closeError: closeError ?? null, forced }
}

/** The caller must pass a freshly built run root. Never reuse a partial run. */
export async function runIsolatedTeamDesktop(runRoot, workerSource) {
  assert(path.isAbsolute(runRoot) && inside(privateRoot, runRoot), 'Use a new owned private run root')
  assert(path.isAbsolute(workerSource) && inside(privateRoot, workerSource), 'Use the owned private worker')
  const runId = path.basename(runRoot)
  const base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  assert.equal(normalized(await fs.realpath(runRoot)), normalized(runRoot), 'Run root must be canonical')
  assert(inside(privateRoot, await fs.realpath(workerSource)), 'Worker must resolve inside the private root')
  const appRoot = path.join(runRoot, 'app')
  // A build creates only app/. Refuse a root with any prior profile, evidence,
  // or other leftovers before making directories, configuring or launching.
  assert.deepEqual((await fs.readdir(runRoot)).sort(), ['app'], 'Use a freshly built, never-run root')
  const appStat = await fs.lstat(appRoot)
  assert(appStat.isDirectory() && !appStat.isSymbolicLink(), 'The built app directory must be owned by this root')
  const packageData = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageData.name, 'magicpot-isolated-image-acceptance')
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  assert(inside(runRoot, await fs.realpath(mainEntry)), 'The built app must be in this run root')
  for (const directory of ['bin', 'cwd', 'storage', 'evidence', 'home', 'appdata', 'localappdata', 'temp']) {
    await fs.mkdir(path.join(runRoot, directory))
  }
  for (const directory of ['storage/Data', 'storage/Projects']) {
    await fs.mkdir(path.join(runRoot, directory))
  }
  const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
  const mock = await startSyntheticResponsesMock()
  const evidence = path.join(runRoot, 'evidence')
  const report = { status: 'running', stage: 'prepare', scope: 'synthetic-lead-and-two-ui-member-creations-only', runRoot, startedAt: new Date().toISOString(), states: [], runtime: [], cleanup: [] }
  let appHandle, page, identity
  let stdout = '', stderr = ''
  try {
    await fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL), null, 2), { flag: 'wx' })
    await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'),
      'require(' + JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' +
      JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n', { flag: 'wx' })
    report.stage = 'launch'
    appHandle = await electron.launch({
      executablePath: require('electron'),
      args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'), '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
      cwd: path.join(runRoot, 'cwd'), env: isolatedImageEnvironment(runRoot, base, runId), timeout: 90_000
    })
    appHandle.process().stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65_536) })
    appHandle.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65_536) })
    page = await appHandle.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    const initial = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.equal(initial.guard.blockedRequestCount, 0)
    assert.deepEqual(initial.guard.renderProcessGone, [])
    assert.deepEqual(initial.guard.pathErrors, [])
    assert.equal(mock.observations().length, 0, 'The initial page must not call the model')
    report.runtime.push({ point: 'launch', ...initial })
    report.stage = 'seed-lead'
    identity = await seedIsolatedTeamLead(page, { profileId, freshSyntheticProfile: true })
    report.identity = identity
    report.stage = 'create-designer'
    await createIsolatedDesigner(page, identity)
    report.states.push({ point: 'designer-visible', ...await inspectIsolatedTeamPane(page, identity) })
    await page.screenshot({ path: path.join(evidence, 'designer.png'), fullPage: false })
    report.stage = 'create-writer'
    await createIsolatedWriter(page, identity)
    report.states.push({ point: 'writer-visible', ...await inspectIsolatedTeamPane(page, identity) })
    await page.screenshot({ path: path.join(evidence, 'two-members.png'), fullPage: false })
    report.stage = 'verify-member-storage'
    report.persistedMembers = await verifyIsolatedTeamMembers(page, identity)
    const final = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.equal(final.guard.blockedRequestCount, 0)
    assert.deepEqual(final.guard.renderProcessGone, [])
    assert.deepEqual(final.guard.pathErrors, [])
    assert.equal(mock.observations().length, 0, 'Member creation must not call the model')
    report.runtime.push({ point: 'created', ...final })
    report.status = 'partial-passed'
    report.stage = 'two-ui-members-visible-and-in-session-store'
  } catch (error) {
    report.status = 'failed'
    report.error = { message: error.message, stack: error.stack }
    if (page) {
      try { await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }) } catch { /* Preserve the original error. */ }
      try { report.bodyDiagnostic = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 6000) } catch { /* The owned page may have exited. */ }
      if (identity) {
        try { report.sessionDiagnostic = await inspectIsolatedTeamPane(page, identity) } catch (failure) { report.sessionDiagnosticError = failure.message }
      }
    }
  } finally {
    if (appHandle) {
      try { report.cleanup.push(await closeOwned(appHandle)) }
      catch (error) { report.status = 'failed'; report.cleanupError = error.message }
    }
    report.provider = mock.observations()
    await mock.close()
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    await fs.writeFile(path.join(evidence, 'main-output.log'), stdout + '\n--- stderr ---\n' + stderr, { flag: 'wx' })
  }
  console.log('isolated-team-partial-result', JSON.stringify({ status: report.status, stage: report.stage, error: report.error?.message, cleanupError: report.cleanupError, runRoot, cleanup: report.cleanup }))
  return report
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass a new private run root and private worker path.')
  const report = await runIsolatedTeamDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  process.exitCode = report.status === 'partial-passed' ? 0 : 1
}
