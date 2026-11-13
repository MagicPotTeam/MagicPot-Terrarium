// WIP: a one-shot synthetic desktop observation launcher, not a pass criterion.
// Never call with a personal profile, old/unknown root, non-synthetic data or
// external endpoint. The app bootstrap is not an OS sandbox. A launch timeout
// can leave an unobserved process tree; neither timeout nor failure is retried.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { isolatedImageEnvironment, fixtureConfig, assertIsolatedRuntime } from './isolatedImageDesktopAcceptance.mjs'
import { seedIsolatedTeamLead, waitForIsolatedTeamPane } from './isolatedTeamDesktopFixture.mjs'
import { seedSummaryOnIsolatedPage, readSyntheticSummaryRows } from './isolatedTeamLeadSummaryPage.mjs'
import { startIsolatedTeamLeadSummaryMock, SUMMARY_PROMPT, SUMMARY_OUTPUT } from './isolatedTeamLeadSummaryMock.mjs'

const require = createRequire(import.meta.url)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const scratch = path.resolve(repo, '../../.magicpot-trash')
const normalize = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normalize(value).startsWith(normalize(parent) + '/')
const profileId = 'isolated-image-responses'
const zero = { received: 0, success: 0, rejected: 0, incomplete: 0, active: 0 }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const sendReservations = new WeakSet()

/** Reserve before any await; a rejected durable marker forbids the click. */
export async function sendOnceWithDurableAttempt(owner, persist, click) {
  if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) throw TypeError('Synthetic send owner required')
  if (sendReservations.has(owner)) throw Error('Synthetic send was already attempted; no replay')
  sendReservations.add(owner)
  if (typeof persist !== 'function' || typeof click !== 'function') throw TypeError('Synthetic send callbacks required')
  await persist()
  await click()
}

// Only waits on already-created owned resources; a timeout is explicitly unknown,
// not cancellation, and no later result is used to promote a run to passed.
async function bound(promise, ms) {
  let timer
  try { return await Promise.race([promise.then(value => ({ status: 'ok', value }), () => ({ status: 'error' })), new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'unknown' }), ms) })]) }
  finally { clearTimeout(timer) }
}
// A deadline abandons the caller's continuation, not the underlying operation.
// If a resource is delivered after the deadline, offer it to owned cleanup;
// this is best effort and never establishes that a process tree has exited.
export async function withSyntheticDeadline(start, ms, label, onLateFulfill) {
  if (typeof start !== 'function' || !Number.isFinite(ms) || ms <= 0 || typeof label !== 'string') throw TypeError('Invalid synthetic deadline')
  let expired = false, timer
  const work = Promise.resolve().then(start)
  void work.then(value => {
    if (expired && typeof onLateFulfill === 'function') void Promise.resolve().then(() => onLateFulfill(value)).catch(() => undefined)
  }, () => undefined)
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true
          reject(Object.assign(Error(`Timed out: ${label}; outcome unknown`), { code: 'SYNTHETIC_DEADLINE' }))
        }, ms)
      })
    ])
  } finally { clearTimeout(timer) }
}

// The final receipt survives a failed or timed-out file write in memory; the
// caller must emit it and must not retry the external action or report write.
export async function persistSummaryReceipt(report, write, timeoutMs = 15_000) {
  const receiptId = randomUUID()
  const serialized = JSON.stringify({ ...report, receiptId }, null, 2)
  const base = { status: 'observation-only', receiptId, attempted: report.attempted, outcome: report.outcome, error: report.error, failedStage: report.failedStage ?? null, cleanup: report.cleanup }
  try {
    await withSyntheticDeadline(() => write(serialized), timeoutMs, 'summary report persistence')
    return { ...base, sha256: createHash('sha256').update(serialized).digest('hex'), reportPersistence: 'ok' }
  } catch (failure) {
    return { ...base, observedOutcome: base.outcome, outcome: 'observation-unknown-report-persistence', sha256: null, reportPersistence: failure?.code === 'SYNTHETIC_DEADLINE' ? 'unknown' : 'failed' }
  }
}

async function markAttempt(evidence) {
  const file = await fs.open(path.join(evidence, 'send-attempt.json'), 'wx')
  try { await file.writeFile(JSON.stringify({ status: 'attempted', replay: false })); await file.sync() } finally { await file.close() }
}
export async function cleanupOwnedSummaryResources(app, mock) {
  const result = { processTree: 'unknown', app: 'not-created', child: 'unknown', mock: 'not-created' }
  if (app) {
    let child
    try { child = app.process() } catch { /* preserve unknown */ }
    let closePromise
    try { closePromise = Promise.resolve(app.close()) } catch { closePromise = Promise.reject(Error('app close failed')) }
    const closed = await bound(closePromise, 15_000)
    result.app = closed.status
    if (closed.status !== 'ok' && child && child.exitCode === null && child.signalCode === null) {
      try { result.killRequested = child.kill() === true } catch { result.killRequested = false }
    }
    if (child) {
      result.pid = child.pid ?? null
      if (child.exitCode === null && child.signalCode === null) {
        let listener
        const exit = await bound(new Promise(resolve => { listener = resolve; child.once('exit', listener) }), 5000)
        if (listener) child.removeListener('exit', listener)
        if (exit.status !== 'ok' && result.killRequested === undefined && child.exitCode === null && child.signalCode === null) {
          try { result.killRequested = child.kill() === true } catch { result.killRequested = false }
        }
      }
      result.child = child.exitCode !== null || child.signalCode !== null ? 'observed' : 'unknown'
      result.exitCode = child.exitCode; result.signalCode = child.signalCode
    }
  }
  if (mock) {
    // Releasing this port while an unobserved app/tree may still be alive can
    // let a late request hit an unrelated service that reuses it. The launcher
    // must not start a real run until it has an owned quarantine strategy.
    let closePromise
    try { closePromise = Promise.resolve(mock.close()) } catch { closePromise = Promise.reject(Error('mock close failed')) }
    const first = await bound(closePromise, 5000)
    result.mock = first.status
    if (first.status !== 'ok') {
      try { mock.destroyOwnedSockets(); result.destroyOwnedSockets = 'requested' } catch { result.destroyOwnedSockets = 'error' }
      let retryPromise
      try { retryPromise = Promise.resolve(mock.close()) } catch { retryPromise = Promise.reject(Error('mock close failed')) }
      result.mockAfterDestroy = (await bound(retryPromise, 5000)).status
    }
    try { result.provider = mock.observations() } catch { result.provider = 'unknown' }
  }
  return result
}
export function providerSettledExactlyOnce(stats) {
  return stats?.received === 1 && stats.success === 1 && stats.rejected === 0 && stats.incomplete === 0 && stats.active === 0
}
export function classifySummaryFailure(attempted, failure, stage) {
  if (attempted === true) return 'observation-unknown-after-send'
  if (attempted === 'marker-outcome-unknown') return 'observation-unknown-marker'
  if (stage === 'reserve') return 'observation-unknown-root-reservation'
  return failure?.code === 'SYNTHETIC_DEADLINE' ? 'observation-unknown-deadline' : 'not-observed'
}
export function classifySummaryResources(launchInvoked, app, mockStartupInvoked, mock, cleanup) {
  const result = { ...cleanup }
  if (launchInvoked && !app) result.app = 'launch-outcome-unknown'
  if (mockStartupInvoked && !mock) result.mock = 'startup-or-cleanup-unknown'
  return result
}
export function classifySummaryCleanup(outcome, cleanup) {
  if (outcome === 'not-observed' && (cleanup?.processTree !== 'observed' || !['ok', 'not-created'].includes(cleanup?.app) || !['ok', 'not-created'].includes(cleanup?.mock))) return 'observation-unknown-cleanup-after-not-observed'
  if (outcome !== 'synthetic-summary-observed') return outcome
  if (cleanup?.mock !== 'ok' || !providerSettledExactlyOnce(cleanup.provider)) return 'observation-unknown-provider-settlement'
  if (cleanup.app !== 'ok' || cleanup.child !== 'observed' || cleanup.processTree !== 'observed') return 'synthetic-summary-observed-cleanup-unknown'
  return outcome
}
export function assertIsolatedSummaryPackage(pkg) {
  assert.equal(pkg?.name, 'magicpot-isolated-image-acceptance')
  assert.equal(pkg.main, 'bootstrap.cjs', 'Electron must start through the isolated bootstrap')
  assert.equal(pkg.type, 'commonjs', 'Synthetic bootstrap requires commonjs')
}

function assertGuard(snapshot) {
  assert.equal(snapshot.guard.blockedRequestCount, 0)
  assert.deepEqual(snapshot.guard.renderProcessGone, [])
  assert.deepEqual(snapshot.guard.pathErrors, [])
}

/** Expects a unique freshly built root containing only app/. Never rerun it. */
// Preflight may be abandoned without creating network resources. A late opened
// file handle is closed best effort; a late read/close remains outcome-unknown.
async function inspectSummaryPreflight(runRoot, workerSource) {
  assert(path.isAbsolute(runRoot) && inside(scratch, runRoot), 'New private run root required')
  assert(path.isAbsolute(workerSource) && inside(scratch, workerSource), 'Private worker required')
  const runId = path.basename(runRoot), base = path.resolve(runRoot, '../../..')
  assert.equal(normalize(path.join(base, '.magicpot-trash/MagicPot', runId)), normalize(runRoot))
  assert.equal(normalize(await fs.realpath(runRoot)), normalize(runRoot), 'Canonical root required')
  const expectedWorker = path.join(scratch, 'chat-image-codec-target-20261111/release/canvas-thumbnail-sidecar.exe')
  assert.equal(normalize(workerSource), normalize(expectedWorker), 'Only the designated private worker is accepted')
  assert.equal(normalize(await fs.realpath(expectedWorker)), normalize(expectedWorker), 'The designated worker must not be a symbolic link')
  const workerStat = await fs.lstat(expectedWorker)
  assert(workerStat.isFile() && !workerStat.isSymbolicLink(), 'Worker must be a regular file')
  const workerReal = expectedWorker
  let workerFile, workerBytes
  try {
    workerFile = await withSyntheticDeadline(() => fs.open(workerReal, 'r'), 15_000, 'open worker snapshot', late => late.close())
    const stat = await workerFile.stat()
    assert(stat.isFile() && stat.size === 2_305_024 && stat.dev === workerStat.dev && stat.ino === workerStat.ino, 'Unexpected worker type, identity or size')
    workerBytes = Buffer.alloc(stat.size)
    const { bytesRead } = await workerFile.read(workerBytes, 0, workerBytes.length, 0)
    assert.equal(bytesRead, workerBytes.length, 'Worker read was incomplete')
  } finally { await workerFile?.close() }
  assert(workerBytes.byteLength === 2_305_024, 'Unexpected worker size')
  const workerDigest = createHash('sha256').update(workerBytes).digest('hex')
  assert.equal(workerDigest, '98c21c7b04f2d4a1c0c98f1bb40904593ee0b7a90d0d31b29b4a9ba66426746e', 'Unrecognized synthetic worker binary')
  assert.deepEqual(await fs.readdir(runRoot), ['app'], 'Root was already used or is incomplete')
  const appRoot = path.join(runRoot, 'app'), appStat = await fs.lstat(appRoot)
  assert(appStat.isDirectory() && !appStat.isSymbolicLink())
  const packagePath = path.join(appRoot, 'package.json')
  assert.equal(normalize(await fs.realpath(packagePath)), normalize(packagePath), 'Package metadata must not be a symbolic link')
  const packageStat = await fs.lstat(packagePath)
  assert(packageStat.isFile() && !packageStat.isSymbolicLink() && packageStat.nlink === 1, 'Package metadata must be a private regular file')
  const pkg = JSON.parse(await fs.readFile(packagePath, 'utf8'))
  assertIsolatedSummaryPackage(pkg)
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  assert(inside(appRoot, await fs.realpath(mainEntry)))
  return { runId, base, workerBytes, workerDigest, appRoot, mainEntry }
}

const QUARANTINE_IMPLEMENTED = false
/** Expects a unique freshly built root containing only app/. Never rerun it. */
export async function runLeadSummaryLauncher(runRoot, workerSource) {
  if (!QUARANTINE_IMPLEMENTED) throw Error('Synthetic launcher disabled: owned quarantine for unknown app/process-tree exit is not implemented')
  const { runId, base, workerBytes, workerDigest, appRoot, mainEntry } = await withSyntheticDeadline(() => inspectSummaryPreflight(runRoot, workerSource), 90_000, 'preflight')
  const evidence = path.join(runRoot, 'evidence')
  let app, page, mock, identity, outcome = 'not-observed', error = null, launchInvoked = false, mockStartupInvoked = false
  const seedController = new AbortController()
  const report = { status: 'observation-only', finalConfirmation: 'not-confirmed', runRoot, stage: 'reserved', attempted: false, processTree: 'unknown', seedIsSynthetic: true, startedAt: new Date().toISOString(), guards: {}, screenshots: [] }
  let receipt, evidenceOwned = false
  try {
    // A pending reservation is never retried, and cannot lead to socket/launch.
    report.stage = 'reserve'
    await withSyntheticDeadline(() => fs.mkdir(evidence), 15_000, 'reserve evidence directory')
    evidenceOwned = true
    await withSyntheticDeadline(() => fs.writeFile(path.join(evidence, 'reserved.json'), JSON.stringify({ kind: 'synthetic-summary', replay: false }), { flag: 'wx' }), 15_000, 'write root reservation')
    report.stage = 'reserved'
    for (const directory of ['bin', 'cwd', 'storage', 'home', 'appdata', 'localappdata', 'temp', 'playwright-artifacts']) await withSyntheticDeadline(() => fs.mkdir(path.join(runRoot, directory)), 15_000, `create ${directory}`)
    for (const directory of ['storage/Data', 'storage/Projects']) await withSyntheticDeadline(() => fs.mkdir(path.join(runRoot, directory)), 15_000, `create ${directory}`)
    const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
    await withSyntheticDeadline(() => fs.writeFile(workerPath, workerBytes, { flag: 'wx' }), 15_000, 'write synthetic worker')
    assert.equal(createHash('sha256').update(await withSyntheticDeadline(() => fs.readFile(workerPath), 15_000, 'verify synthetic worker')).digest('hex'), workerDigest, 'Copied worker verification failed')
    mockStartupInvoked = true
    mock = await withSyntheticDeadline(() => startIsolatedTeamLeadSummaryMock(), 10_000, 'mock startup', late => cleanupOwnedSummaryResources(undefined, late))
    await withSyntheticDeadline(() => fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL)), { flag: 'wx' }), 15_000, 'synthetic config write')
    await withSyntheticDeadline(() => fs.writeFile(path.join(appRoot, 'bootstrap.cjs'), 'require(' + JSON.stringify(path.join(repo, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' + JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n', { flag: 'wx' }), 15_000, 'synthetic bootstrap write')
    report.stage = 'launch'
    launchInvoked = true
    app = await withSyntheticDeadline(() => electron.launch({ executablePath: require('electron'), args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'), '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: path.join(runRoot, 'cwd'), artifactsDir: path.join(runRoot, 'playwright-artifacts'), env: isolatedImageEnvironment(runRoot, base, runId), timeout: 90_000 }), 100_000, 'Electron launch', late => cleanupOwnedSummaryResources(late, undefined))
    page = await withSyntheticDeadline(() => app.firstWindow({ timeout: 90_000 }), 95_000, 'first window'); page.setDefaultTimeout(30_000)
    await withSyntheticDeadline(() => page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 }), 95_000, 'renderer startup')
    const initial = await withSyntheticDeadline(() => assertIsolatedRuntime(app, page, runRoot, mock.baseURL), 45_000, 'startup runtime inspection')
    report.guards.startup = { blockedRequestCount: initial.guard.blockedRequestCount, pathErrors: initial.guard.pathErrors.length, renderProcessGone: initial.guard.renderProcessGone.length }
    assertGuard(initial)
    assert.deepEqual(mock.observations(), zero)
    report.stage = 'seed'
    identity = await withSyntheticDeadline(() => seedIsolatedTeamLead(page, { profileId, freshSyntheticProfile: true, signal: seedController.signal }), 135_000, 'lead seed')
    const memberIds = [randomUUID(), randomUUID()].map(id => `isolated-summary-member-${id}`)
    const members = await withSyntheticDeadline(() => seedSummaryOnIsolatedPage(page, identity, memberIds, { signal: seedController.signal }), 135_000, 'member seed')
    const pane = await withSyntheticDeadline(() => waitForIsolatedTeamPane(page, identity), 65_000, 'team pane')
    const process = pane.getByRole('region', { name: '进程区', exact: true })
    await withSyntheticDeadline(() => process.getByRole('button', { name: '打开 设计师', exact: true }).waitFor({ state: 'visible', timeout: 60_000 }), 65_000, 'designer visibility')
    await withSyntheticDeadline(() => process.getByRole('button', { name: '打开 文案', exact: true }).waitFor({ state: 'visible', timeout: 60_000 }), 65_000, 'writer visibility')
    assert.deepEqual(await withSyntheticDeadline(() => page.evaluate(readSyntheticSummaryRows, { keys: members.map(row => row.storageKey) }), 30_000, 'member readback'), members)
    const [emptyLead] = await withSyntheticDeadline(() => page.evaluate(readSyntheticSummaryRows, { keys: [`${identity.scope}\u0000${identity.sessionId}`] }), 30_000, 'lead readback')
    assert(emptyLead?.id === identity.sessionId && emptyLead.storageScope === identity.scope && emptyLead.profileId === identity.profileId && !emptyLead.skillId && !emptyLead.contextCompression && !emptyLead.sessionUrl && !emptyLead.teamLeadId && !emptyLead.teamEnded && !emptyLead.archived && Array.isArray(emptyLead.messages) && emptyLead.messages.length === 0 && !emptyLead.draft, 'Lead must be empty before the synthetic send')
    report.identity = { scope: identity.scope, sessionId: identity.sessionId, profileId: identity.profileId, memberIds }
    report.baseline = { leadMessageCount: emptyLead.messages.length, memberMessageCounts: members.map(member => member.messages.length), memberCreatedAt: members.map(member => member.createdAt) }
    const before = await withSyntheticDeadline(() => assertIsolatedRuntime(app, page, runRoot, mock.baseURL), 45_000, 'pre-send runtime inspection')
    report.guards.beforeSend = { blockedRequestCount: before.guard.blockedRequestCount, pathErrors: before.guard.pathErrors.length, renderProcessGone: before.guard.renderProcessGone.length }
    assertGuard(before)
    assert.deepEqual(mock.observations(), zero)
    await withSyntheticDeadline(() => page.screenshot({ path: path.join(evidence, 'before-summary.png') }), 35_000, 'pre-send screenshot')
    report.screenshots.push('before-summary.png')
    const input = pane.locator('[data-testid="chat-composer-input"]')
    await withSyntheticDeadline(() => input.fill(SUMMARY_PROMPT), 35_000, 'fill composer')
    assert.equal(await withSyntheticDeadline(() => input.inputValue(), 35_000, 'read composer'), SUMMARY_PROMPT)
    await withSyntheticDeadline(() => page.waitForFunction(({ pane, scope, sessionId, profileId, prompt }) => {
      const node = document.querySelector(pane)
      const box = node?.querySelector('[data-testid="chat-composer-input"]')
      const button = node?.querySelector('button[data-chat-send-btn]')
      return node?.getAttribute('aria-hidden') === 'false' && localStorage.getItem(`chat.currentSessionId.${scope}`) === sessionId && localStorage.getItem(`chat.selectedProfileId.${scope}`) === profileId && box?.value === prompt && !box.disabled && Boolean(button && !button.disabled)
    }, { pane: `[data-agent-workspace-pane="agent-1"][data-agent-workspace-scope="${identity.scope}"]`, scope: identity.scope, sessionId: identity.sessionId, profileId: identity.profileId, prompt: SUMMARY_PROMPT }, { timeout: 30_000 }), 35_000, 'composer readiness')
    let markerStarted = false
    try {
      await sendOnceWithDurableAttempt(identity, () => { markerStarted = true; return withSyntheticDeadline(() => markAttempt(evidence), 10_000, 'durable send marker') }, async () => {
        report.attempted = true; report.stage = 'send-attempted'
        await withSyntheticDeadline(() => pane.locator('button[data-chat-send-btn]').click({ timeout: 30_000 }), 35_000, 'single send click')
      })
    } catch (failure) {
      if (markerStarted && report.attempted === false) report.attempted = 'marker-outcome-unknown'
      throw failure
    }
    report.stage = 'observe'
    const deadline = Date.now() + 90_000
    let lead
    while (Date.now() < deadline) {
      const stats = mock.observations()
      if (stats.received > 1 || stats.rejected || stats.incomplete) throw Error('Unexpected synthetic request observation')
      const rows = await withSyntheticDeadline(() => page.evaluate(readSyntheticSummaryRows, { keys: [`${identity.scope}\u0000${identity.sessionId}`] }), Math.max(1, Math.min(10_000, deadline - Date.now())), 'lead observation read')
      lead = rows[0]
      if (!lead || lead.id !== identity.sessionId || lead.storageScope !== identity.scope || lead.profileId !== identity.profileId || !Array.isArray(lead.messages)) throw Error('Lead observation identity mismatch')
      if (stats.success === 1 && lead.messages.some(message => message.role === 'assistant' && message.content === SUMMARY_OUTPUT)) break
      await sleep(200)
    }
    assert.equal(mock.observations().success, 1)
    assert(lead.messages.some(message => message.role === 'user' && message.content === SUMMARY_PROMPT))
    assert(lead.messages.some(message => message.role === 'assistant' && message.content === SUMMARY_OUTPUT))
    report.observed = { leadMessageCount: lead.messages.length, userPromptFound: true, assistantOutputFound: true }
    await withSyntheticDeadline(() => pane.getByText(SUMMARY_OUTPUT, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 }), 35_000, 'summary visibility')
    await withSyntheticDeadline(() => page.screenshot({ path: path.join(evidence, 'after-summary.png') }), 35_000, 'post-send screenshot')
    report.screenshots.push('after-summary.png')
    const after = await withSyntheticDeadline(() => assertIsolatedRuntime(app, page, runRoot, mock.baseURL), 45_000, 'post-send runtime inspection')
    report.guards.afterSend = { blockedRequestCount: after.guard.blockedRequestCount, pathErrors: after.guard.pathErrors.length, renderProcessGone: after.guard.renderProcessGone.length }
    assertGuard(after)
    outcome = 'synthetic-summary-observed'
  } catch (failure) {
    report.failedStage = report.stage
    outcome = classifySummaryFailure(report.attempted, failure, report.stage)
    error = failure instanceof Error ? failure.message : 'unknown failure'
  } finally {
    seedController.abort()
    const outcomeBeforeCleanup = outcome
    try {
      report.cleanup = await withSyntheticDeadline(() => cleanupOwnedSummaryResources(app, mock), 38_000, 'resource cleanup')
    } catch {
      report.cleanup = { processTree: 'unknown', app: 'unknown', child: 'unknown', mock: 'unknown' }
      outcome = 'observation-unknown-cleanup'
    }
    report.cleanup = classifySummaryResources(launchInvoked, app, mockStartupInvoked, mock, report.cleanup)
    outcome = classifySummaryCleanup(outcome, report.cleanup)
    report.outcome = outcome; report.error = error; report.stage = 'finished'; report.finishedAt = new Date().toISOString()
    if (outcome !== outcomeBeforeCleanup) report.outcomeBeforeCleanup = outcomeBeforeCleanup
    receipt = await persistSummaryReceipt(report, async serialized => {
      if (!evidenceOwned) throw Error('Evidence directory was not exclusively reserved; refusing report write')
      const file = await fs.open(path.join(evidence, 'result.json'), 'wx')
      try { await file.writeFile(serialized); await file.sync() } finally { await file.close() }
    })
  }
  return receipt
}

// Nonzero exit with no structured receipt means preflight or persistence itself
// failed; the root must be considered used or unknown and must not be replayed.
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw Error('Pass one new built private root and private worker')
  const receipt = await runLeadSummaryLauncher(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  console.log('synthetic-lead-summary-observation', JSON.stringify(receipt))
  // Always nonzero: receipt remains observation-only until an independent verifier exists.
  process.exitCode = 1
}
