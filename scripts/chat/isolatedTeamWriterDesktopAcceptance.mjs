// Synthetic writer approval acceptance; never reuse a root or a mutation attempt.
// Requires a newly built app containing the inline approval card identity attributes.
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
import { seedIsolatedTeamLead, createIsolatedDesigner, createIsolatedWriter, verifyIsolatedTeamMembers, waitForIsolatedTeamPane, inspectIsolatedTeamPane, readIsolatedWriterNotes, sendIsolatedWriter, inspectIsolatedWriterApproval, approveIsolatedWriter } from './isolatedTeamDesktopFixture.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normalized(value).startsWith(normalized(parent) + '/')
const counts = (call, result) => ({ design: 0, summary: 0, channel: 0, 'scratchpad-call': call, 'scratchpad-result': result, error: 0 })

async function bounded(action, timeoutMs) {
  let timer
  try { return await Promise.race([Promise.resolve().then(action).then(value => ({ status: 'ok', value }), () => ({ status: 'error' })), new Promise(resolve => { timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}

export async function finalizeWriterRun({ report, app, mock, writeLog, writeResult, timeoutMs = 5000 }) {
  const cleanup = { processTree: 'unknown' }
  let child
  if (app) {
    try { child = app.process() } catch { cleanup.child = 'unknown' }
    const closed = await bounded(() => app.close(), timeoutMs)
    cleanup.appClose = closed.status
    if (closed.status !== 'ok') report.status = 'failed'
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
      cleanup.exitCode = child.exitCode; cleanup.signalCode = child.signalCode
      if (cleanup.child !== 'observed' || child.exitCode !== 0 || child.signalCode !== null || cleanup.killRequested !== undefined) report.status = 'failed'
    } else report.status = 'failed'
  } else { cleanup.child = 'unknown'; report.status = 'failed' }
  if (mock) {
    const closed = await bounded(() => mock.close(), timeoutMs)
    cleanup.mockClose = closed.status
    if (closed.status !== 'ok') report.status = 'failed'
    else {
      const observed = await bounded(() => mock.observations(), timeoutMs)
      cleanup.mockObservations = observed.status
      if (observed.status === 'ok') {
        report.provider = observed.value
        const expected = counts(1, 1), actual = observed.value
        if (!actual || typeof actual !== 'object' || Array.isArray(actual) || Object.keys(actual).sort().join(',') !== Object.keys(expected).sort().join(',') || Object.keys(expected).some(key => actual[key] !== expected[key])) report.status = 'failed'
      } else report.status = 'failed'
    }
  } else report.status = 'failed'
  const log = await bounded(writeLog, timeoutMs)
  cleanup.logWrite = log.status
  if (log.status !== 'ok') report.status = 'failed'
  report.cleanup = cleanup
  const receiptId = randomUUID()
  const serialized = JSON.stringify({ ...report, status: 'observation-only', finalConfirmation: 'not-confirmed', receiptId }, null, 2)
  const sha256 = createHash('sha256').update(serialized, 'utf8').digest('hex')
  const written = await bounded(() => writeResult(serialized), timeoutMs)
  if (written.status !== 'ok') throw Error('WRITER_RESULT_WRITE_FAILED')
  return { ...report, reportReceipt: { receiptId, sha256 } }
}

// Separate readonly transactions are observations, not an atomic snapshot.
async function readWriterSession(page, identity, writerId) {
  await waitForIsolatedTeamPane(page, identity)
  return page.evaluate(async ({ identity, writerId }) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('magicpot-chat', 2)
      req.onupgradeneeded = () => req.transaction.abort()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error || new Error('Cannot open chat database'))
      req.onblocked = () => reject(new Error('Chat database blocked'))
    })
    try {
      if (!db.objectStoreNames.contains('sessions-v2')) throw new Error('Missing sessions-v2')
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions-v2', 'readonly')
        const request = tx.objectStore('sessions-v2').get(`${identity.scope}\u0000${writerId}`)
        let value
        request.onsuccess = () => { value = request.result }
        tx.oncomplete = () => resolve(value)
        tx.onabort = () => reject(tx.error || new Error('Read transaction aborted'))
        tx.onerror = () => reject(tx.error)
      })
      if (row?.id !== writerId || row.storageScope !== identity.scope || row.teamLeadId !== identity.sessionId || !Array.isArray(row.messages)) throw new Error('Writer identity mismatch')
      return { writerId, messageCount: row.messages.length, assistants: row.messages.flatMap((message, index) => message.role === 'assistant' && message.content === '文案结果' ? [{ index, id: message.id ?? null, content: message.content }] : []) }
    } finally { db.close() }
  }, { identity, writerId })
}

export async function runIsolatedTeamWriterDesktop(runRoot, workerSource) {
  assert(path.isAbsolute(runRoot) && inside(privateRoot, runRoot), 'Use a new owned private run root')
  assert(path.isAbsolute(workerSource) && inside(privateRoot, workerSource), 'Use the owned private worker')
  const runId = path.basename(runRoot), base = path.resolve(runRoot, '../../..')
  assert.equal(normalized(path.join(base, '.magicpot-trash/MagicPot', runId)), normalized(runRoot))
  assert.equal(normalized(await fs.realpath(runRoot)), normalized(runRoot), 'Run root must be canonical')
  assert(inside(privateRoot, await fs.realpath(workerSource)), 'Worker must resolve inside the private root')
  const appRoot = path.join(runRoot, 'app')
  assert.deepEqual((await fs.readdir(runRoot)).sort(), ['app'], 'Use a freshly built, never-run root')
  const appStat = await fs.lstat(appRoot)
  assert(appStat.isDirectory() && !appStat.isSymbolicLink(), 'The built app directory must be owned by this root')
  const packageData = JSON.parse(await fs.readFile(path.join(appRoot, 'package.json'), 'utf8'))
  assert.equal(packageData.name, 'magicpot-isolated-image-acceptance')
  const mainEntry = path.join(appRoot, 'out/main/index.js')
  assert(inside(runRoot, await fs.realpath(mainEntry)), 'The built app must be in this run root')
  await fs.mkdir(path.join(runRoot, 'evidence'))
  const evidence = path.join(runRoot, 'evidence')
  const report = { status: 'running', stage: 'prepare', scope: 'synthetic-writer-approval-only', runRoot, startedAt: new Date().toISOString(), runtime: [], cleanup: [], limitations: ['Lead is seeded, not UI-created.', 'Responses are synthetic, not a real model.', 'Pending inspection and UI click are not atomic.', 'The MAIN decision receipt/current-state observation does not prove this click caused the write.', 'Notes and IndexedDB observations are independent, not an atomic snapshot.', 'Requires a new build with inline approval identity attributes.'] }
  let appHandle, page, identity, mock, outcome
  let stdout = '', stderr = ''
  try {
    for (const directory of ['bin', 'cwd', 'storage', 'home', 'appdata', 'localappdata', 'temp']) await fs.mkdir(path.join(runRoot, directory))
    for (const directory of ['storage/Data', 'storage/Projects']) await fs.mkdir(path.join(runRoot, directory))
    const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
    await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
    mock = await startSyntheticTeamResponsesMock()
    await fs.writeFile(path.join(runRoot, 'storage/Data/config.json'), JSON.stringify(fixtureConfig(mock.baseURL), null, 2), { flag: 'wx' })
    await fs.writeFile(path.join(appRoot, 'bootstrap.cjs'), 'require(' + JSON.stringify(path.join(repoRoot, 'scripts/chat/isolatedImageDesktopBootstrap.cjs')) + ').startIsolatedImageDesktop(' + JSON.stringify({ runRoot, mainEntry, mockOrigin: new URL(mock.baseURL).origin, workerPath }) + ')\n', { flag: 'wx' })
    report.stage = 'launch'
    appHandle = await electron.launch({ executablePath: require('electron'), args: [appRoot, '--user-data-dir=' + path.join(runRoot, 'storage/Data'), '--disk-cache-dir=' + path.join(runRoot, 'storage/Data/cache'), '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'], cwd: path.join(runRoot, 'cwd'), env: isolatedImageEnvironment(runRoot, base, runId), timeout: 90_000 })
    appHandle.process().stdout?.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-65_536) })
    appHandle.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-65_536) })
    page = await appHandle.firstWindow({ timeout: 90_000 })
    page.setDefaultTimeout(30_000)
    await page.waitForFunction(() => Boolean(window.api?.svcState && document.querySelector('#root')?.childElementCount), undefined, { timeout: 90_000 })
    const initial = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.equal(initial.guard.blockedRequestCount, 0); assert.deepEqual(initial.guard.renderProcessGone, []); assert.deepEqual(initial.guard.pathErrors, [])
    assert.deepEqual(mock.observations(), counts(0, 0))
    report.runtime.push({ point: 'launch', ...initial })
    report.stage = 'seed-lead'
    identity = await seedIsolatedTeamLead(page, { profileId: 'isolated-image-responses', freshSyntheticProfile: true })
    report.identity = identity
    report.stage = 'create-designer'; await createIsolatedDesigner(page, identity)
    report.stage = 'create-writer'; await createIsolatedWriter(page, identity)
    report.stage = 'baseline'
    const members = await verifyIsolatedTeamMembers(page, identity)
    report.members = members
    const writer = members.find(member => member.name === '文案')
    assert(writer && writer.messageCount === 0, 'Writer session must be empty')
    const baselineSession = await readWriterSession(page, identity, writer.id)
    assert.equal(baselineSession.messageCount, 0)
    const baselineNotes = await readIsolatedWriterNotes(page, identity)
    assert.equal(baselineNotes.writerId, writer.id)
    assert.equal(baselineNotes.notes?.revision, 0)
    assert.deepEqual(baselineNotes.notes?.notes, [])
    report.route = { channel: 'canvas', scopeType: 'thread', scopeId: identity.projectId, threadId: 'agent-1' }
    report.baseline = { session: baselineSession, notes: baselineNotes }
    assert.deepEqual(mock.observations(), counts(0, 0))
    report.stage = 'send-writer'
    report.sendAttempted = true
    report.send = await sendIsolatedWriter(page, identity)
    report.stage = 'inspect-main-pending'
    const pending = await inspectIsolatedWriterApproval(page, identity)
    assert.equal(pending.writerId, writer.id)
    report.pending = pending
    assert.deepEqual(mock.observations(), counts(1, 0))
    await page.screenshot({ path: path.join(evidence, 'writer-pending.png'), fullPage: false })
    report.stage = 'approve-once'
    report.approvalAttempted = true
    const approved = await approveIsolatedWriter(page, identity, pending)
    report.approvalObservation = approved
    assert.equal(approved.writerId, pending.writerId)
    assert.equal(approved.approvalId, pending.approvalId, 'Pending changed between observations; click causation is not established')
    assert.equal(approved.revision, pending.revision)
    report.stage = 'independent-observations'
    const notes = await readIsolatedWriterNotes(page, identity)
    assert.equal(notes.writerId, writer.id)
    assert.equal(notes.notes?.revision, 1)
    assert.equal(notes.notes?.notes?.length, 1)
    assert.equal(notes.notes.notes[0].key, 'fixture')
    assert.equal(notes.notes.notes[0].value, 'approved-value')
    const session = await readWriterSession(page, identity, writer.id)
    assert.equal(session.assistants.length, 1, 'Expected exactly one stored synthetic writer result')
    report.notesObservation = notes
    report.sessionObservation = session
    await page.screenshot({ path: path.join(evidence, 'writer-result.png'), fullPage: false })
    assert.deepEqual(mock.observations(), counts(1, 1))
    const final = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.equal(final.guard.blockedRequestCount, 0); assert.deepEqual(final.guard.renderProcessGone, []); assert.deepEqual(final.guard.pathErrors, [])
    report.runtime.push({ point: 'observed', ...final })
    report.status = 'partial-passed'; report.stage = 'synthetic-writer-observed'
  } catch (error) {
    report.status = 'failed'; report.error = { message: error.message, stack: error.stack }
    if (page) {
      try { await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }) } catch { /* Best-effort failure evidence. */ }
      try { report.bodyDiagnostic = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 6000) } catch { /* Best-effort failure evidence. */ }
      if (identity) try { report.sessionDiagnostic = await inspectIsolatedTeamPane(page, identity) } catch (failure) { report.sessionDiagnosticError = failure.message }
    }
  } finally {
    report.finishedAt = new Date().toISOString()
    outcome = await finalizeWriterRun({ report, app: appHandle, mock, writeLog: () => fs.writeFile(path.join(evidence, 'main-output.log'), stdout + '\n--- stderr ---\n' + stderr, { flag: 'wx' }), writeResult: data => fs.writeFile(path.join(evidence, 'result.json'), data, { flag: 'wx' }) })
  }
  return outcome
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass a new private run root and private worker path.')
  try {
    const report = await runIsolatedTeamWriterDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
    console.log('isolated-team-writer-result', JSON.stringify({ status: report.status, stage: report.stage, reportReceipt: report.reportReceipt }))
    process.exitCode = report.status === 'partial-passed' ? 0 : 1
  } catch {
    console.error('WRITER_RUN_OR_REPORT_FAILED')
    process.exitCode = 1
  }
}
