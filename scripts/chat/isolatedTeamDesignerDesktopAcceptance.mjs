// Synthetic designer-image desktop acceptance. Preparation seeds a lead; only
// member forms and the designer send are UI actions. This is not image_gen.
// Never run against a personal profile or reuse a run root after an attempt.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron } from 'playwright'
import { isolatedImageEnvironment, fixtureConfig, assertIsolatedRuntime } from './isolatedImageDesktopAcceptance.mjs'
import { startSyntheticTeamResponsesMock } from './syntheticTeamResponsesMock.mjs'
import { seedIsolatedTeamLead, createIsolatedDesigner, createIsolatedWriter, verifyIsolatedTeamMembers, waitForIsolatedTeamPane, inspectIsolatedTeamPane } from './isolatedTeamDesktopFixture.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const privateRoot = path.resolve(repoRoot, '../../.magicpot-trash')
const profileId = 'isolated-image-responses'
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase()
const inside = (parent, value) => normalized(value).startsWith(normalized(parent) + '/')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function within(promise, milliseconds, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function closeOwned(handle) {
  const child = handle.process()
  let forced = false, closeError
  const fallback = setTimeout(() => { forced = true; child.kill() }, 15_000)
  try {
    try { await handle.close() } catch (error) { closeError = error.message }
    if (child.exitCode === null && child.signalCode === null) await within(new Promise(resolve => child.once('close', resolve)), 20_000, 'owned process exit')
  } finally { clearTimeout(fallback) }
  assert(!forced, 'Owned Electron required forced cleanup')
  assert(child.exitCode !== null || child.signalCode !== null, 'Owned Electron exit was not observed')
  return { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, closeError: closeError ?? null, forced }
}

// Both stores are observed read-only in the live synthetic page. They are not
// a cross-database atomic snapshot. Never open/upgrade a missing database.
async function readEvidence(page, identity, designerId, baselineIds = null) {
  await waitForIsolatedTeamPane(page, identity)
  return page.evaluate(async ({ identity, designerId, baselineIds }) => {
    const expected = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=='
    const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
    async function get(dbName, storeName, key) {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 2)
        req.onupgradeneeded = () => req.transaction.abort()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error || new Error(`Cannot open ${dbName}`))
        req.onblocked = () => reject(new Error(`Blocked ${dbName}`))
      })
      try {
        if (!db.objectStoreNames.contains(storeName)) throw new Error(`Missing ${storeName}`)
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly')
          const request = tx.objectStore(storeName).get(key)
          let value
          request.onsuccess = () => { value = request.result }
          tx.oncomplete = () => resolve(value)
          tx.onabort = () => reject(tx.error || new Error('Read transaction aborted'))
          tx.onerror = () => reject(tx.error)
        })
      } finally { db.close() }
    }
    const row = await get('magicpot-chat', 'sessions-v2', `${identity.scope}\u0000${designerId}`)
    if (row?.id !== designerId || row.storageScope !== identity.scope || row.teamLeadId !== identity.sessionId || !Array.isArray(row.messages)) throw new Error('Designer identity mismatch')
    const canvasDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open('magicpot-canvas', 2)
      request.onupgradeneeded = () => request.transaction.abort()
      request.onerror = () => reject(new Error('Canvas database unavailable or not initialized'))
      request.onblocked = () => reject(new Error('Canvas database blocked'))
      request.onsuccess = () => resolve(request.result)
    })
    let items, binary, selected
    try {
      if (!canvasDb.objectStoreNames.contains('canvas-items') || !canvasDb.objectStoreNames.contains('canvas-blobs')) throw new Error('Canvas stores unavailable')
      await new Promise((resolve, reject) => {
        const tx = canvasDb.transaction(['canvas-items', 'canvas-blobs'], 'readonly')
        const request = tx.objectStore('canvas-items').get(identity.projectId)
        request.onsuccess = () => {
          const canvas = request.result
          items = canvas === undefined ? [] : Array.isArray(canvas) ? canvas : canvas.items
          if (!Array.isArray(items)) { tx.abort(); return }
          if (baselineIds !== null) {
            const added = items.filter(item => !baselineIds.includes(item.id))
            if (added.length === 1 && added[0].type === 'image' && added[0].teamImageLabel === '设计师·图1' && typeof added[0].id === 'string' && added[0].id) {
              selected = added[0]
              if (selected.src === '') {
                const blobRequest = tx.objectStore('canvas-blobs').get(`${identity.projectId}::canvas::${selected.id}`)
                blobRequest.onsuccess = () => { binary = blobRequest.result }
              }
            }
          }
        }
        tx.oncomplete = resolve
        tx.onabort = () => reject(tx.error || new Error('Canvas metadata/blob readonly transaction aborted'))
        tx.onerror = () => reject(tx.error)
      })
    } finally { canvasDb.close() }
    const outputs = []
    for (const [messageIndex, message] of row.messages.entries()) {
      if (message.role !== 'assistant' || message.content !== '设计结果') continue
      for (const [attachmentIndex, attachment] of (message.attachments ?? []).entries()) {
        if (attachment.type !== 'image') continue
        if (typeof attachment.url !== 'string' || attachment.url !== expected || attachment.url.length > 8192) throw new Error('Session image is not the exact bounded synthetic PNG data URL; file URLs are forbidden')
        const bytes = Uint8Array.from(atob(attachment.url.slice('data:image/png;base64,'.length)), ch => ch.charCodeAt(0))
        if (!bytes.byteLength || bytes.byteLength > 8192) throw new Error('Session synthetic PNG size is invalid')
        outputs.push({ messageIndex, attachmentIndex, type: 'image', sha256: await digest(bytes) })
      }
    }
    let blobObservation = null
    if (selected) {
      if (selected.src === expected && selected.src.length <= 8192) {
        const data = Uint8Array.from(atob(selected.src.slice('data:image/png;base64,'.length)), ch => ch.charCodeAt(0))
        if (!data.byteLength || data.byteLength > 8192) throw new Error('Target project data URL size invalid')
        blobObservation = { itemId: selected.id, source: 'metadata-data-url', bytes: data.byteLength, sha256: await digest(data) }
      } else if (selected.src === '') {
        if (!binary) throw new Error('Target project image blob missing in metadata snapshot')
        if (binary.mimeType !== 'image/png') throw new Error('Target project image blob MIME is not image/png')
        const data = binary.data
        if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 8192) throw new Error('Target project image blob type or size invalid')
        blobObservation = { itemId: selected.id, source: 'same-transaction-blob', bytes: data.byteLength, sha256: await digest(data) }
      } else throw new Error('Target project image source is neither fixed synthetic data URL nor empty blob reference')
    }
    return { messageCount: row.messages.length, outputs, items: items.map(item => ({ id: item.id, type: item.type, teamImageLabel: item.teamImageLabel })), blobObservation }
  }, { identity, designerId, baselineIds })
}

export async function runIsolatedTeamDesignerDesktop(runRoot, workerSource) {
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
  for (const directory of ['bin', 'cwd', 'storage', 'evidence', 'home', 'appdata', 'localappdata', 'temp']) await fs.mkdir(path.join(runRoot, directory))
  for (const directory of ['storage/Data', 'storage/Projects']) await fs.mkdir(path.join(runRoot, directory))
  const workerPath = path.join(runRoot, 'bin/canvas-thumbnail-sidecar.exe')
  await fs.copyFile(workerSource, workerPath, constants.COPYFILE_EXCL)
  const mock = await startSyntheticTeamResponsesMock()
  const evidence = path.join(runRoot, 'evidence')
  const report = { status: 'running', stage: 'prepare', scope: 'synthetic-designer-image-only', runRoot, startedAt: new Date().toISOString(), states: [], runtime: [], cleanup: [], limitations: ['Lead is seeded, not UI-created.', 'Mock image response is synthetic, not image_gen.', 'Cross-database observations are not atomic.', 'Matching synthetic SHA-256 establishes byte equality, not causal provenance or project-file export.'] }
  let appHandle, page, identity, attempted = false
  let stdout = '', stderr = ''
  try {
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
    assert.deepEqual(mock.observations(), { design: 0, summary: 0, channel: 0, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 })
    report.runtime.push({ point: 'launch', ...initial })
    report.stage = 'seed-lead'
    identity = await seedIsolatedTeamLead(page, { profileId, freshSyntheticProfile: true })
    report.identity = identity
    report.stage = 'create-designer'; await createIsolatedDesigner(page, identity)
    report.stage = 'create-writer'; await createIsolatedWriter(page, identity)
    report.stage = 'verify-members'
    const members = await verifyIsolatedTeamMembers(page, identity)
    const designer = members.find(member => member.name === '设计师')
    assert.equal(designer.messageCount, 0, 'Designer must be empty before the send')
    report.members = members
    report.states.push({ point: 'members-visible', ...await inspectIsolatedTeamPane(page, identity) })
    assert.deepEqual(mock.observations(), { design: 0, summary: 0, channel: 0, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 })
    report.stage = 'baseline'
    let baseline, baselineError
    const baselineDeadline = Date.now() + 60_000
    do {
      try { baseline = await readEvidence(page, identity, designer.id); break }
      catch (error) {
        baselineError = error
        if (!String(error.message).includes('Canvas database unavailable or not initialized')) throw error
        await sleep(200)
      }
    } while (Date.now() < baselineDeadline)
    if (!baseline) throw baselineError
    assert.equal(baseline.messageCount, 0)
    const ids = baseline.items.map(item => item.id)
    assert(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'Invalid baseline item IDs')
    report.baseline = { projectId: identity.projectId, itemIds: ids, designerMessageCount: baseline.messageCount }
    report.stage = 'send-designer'
    const pane = await waitForIsolatedTeamPane(page, identity)
    await pane.locator('[data-testid="chat-composer-input"]').fill('@设计师 设计海报')
    if (attempted) throw new Error('Designer send already attempted')
    attempted = true; report.sendAttempted = true
    await pane.locator('[data-chat-send-btn]').click({ timeout: 60_000 })
    report.stage = 'observe-session-and-project-store'
    let observed, candidate
    const deadline = Date.now() + 90_000
    while (Date.now() < deadline) {
      observed = await readEvidence(page, identity, designer.id, ids)
      const images = observed.outputs.filter(item => item.type === 'image' && item.sha256)
      const added = observed.items.filter(item => !ids.includes(item.id))
      if (images.length > 1 || added.length > 1) throw new Error('Ambiguous designer image or project item')
      if (images.length === 1 && added.length === 1 && added[0].type === 'image' && added[0].teamImageLabel === '设计师·图1' && typeof added[0].id === 'string' && added[0].id) { candidate = { image: images[0], item: added[0], blob: observed.blobObservation }; break }
      await sleep(200)
    }
    if (!candidate) throw new Error('Designer result or unique project image not observed before timeout')
    report.sessionObservation = { designerId: designer.id, messageIndex: candidate.image.messageIndex, attachmentIndex: candidate.image.attachmentIndex, assistantText: '设计结果', imageAttachmentObserved: true }
    report.projectStoreObservation = { projectId: identity.projectId, itemId: candidate.item.id, type: 'image', teamImageLabel: candidate.item.teamImageLabel, newRelativeToBaseline: true }
    report.association = { attachmentSha256: candidate.image.sha256, canvasSha256: candidate.blob?.sha256, canvasBytes: candidate.blob?.bytes, canvasSource: candidate.blob?.source, causalProvenanceProven: false }
    assert(candidate.blob && candidate.blob.itemId === candidate.item.id && candidate.image.sha256 === candidate.blob.sha256, 'Attachment and project image hashes differ; association remains unproven')
    report.stage = 'observe-item-label'
    const label = page.locator('[data-canvas-team-image-label]').filter({ hasText: '设计师·图1' })
    await label.waitFor({ state: 'visible', timeout: 60_000 })
    assert.equal(await label.count(), 1, 'Expected unique team image label')
    assert.equal(await label.getAttribute('data-canvas-team-image-label'), candidate.item.id)
    assert.equal((await label.innerText()).trim(), '设计师·图1')
    await waitForIsolatedTeamPane(page, identity)
    const stable = await readEvidence(page, identity, designer.id, ids)
    assert(stable.outputs.some(item => item.messageIndex === candidate.image.messageIndex && item.attachmentIndex === candidate.image.attachmentIndex && item.sha256 === candidate.image.sha256 && item.type === 'image'), 'Session observation changed')
    assert(stable.items.some(item => item.id === candidate.item.id && item.type === 'image' && item.teamImageLabel === candidate.item.teamImageLabel) && stable.blobObservation?.itemId === candidate.item.id && stable.blobObservation.sha256 === candidate.blob.sha256, 'Project snapshot changed')
    report.uiObservation = { labelVisible: true, itemId: candidate.item.id, label: '设计师·图1' }
    await page.screenshot({ path: path.join(evidence, 'designer-image.png'), fullPage: false })
    const counts = mock.observations()
    assert.deepEqual(counts, { design: 1, summary: 0, channel: 0, 'scratchpad-call': 0, 'scratchpad-result': 0, error: 0 }, 'Unexpected mock scenes')
    const final = await assertIsolatedRuntime(appHandle, page, runRoot, mock.baseURL)
    assert.equal(final.guard.blockedRequestCount, 0); assert.deepEqual(final.guard.renderProcessGone, []); assert.deepEqual(final.guard.pathErrors, [])
    report.runtime.push({ point: 'observed', ...final })
    report.status = 'partial-passed'; report.stage = 'synthetic-designer-image-observed'
  } catch (error) {
    report.status = 'failed'; report.error = { message: error.message, stack: error.stack }
    if (page) {
      try { await page.screenshot({ path: path.join(evidence, 'failure.png'), timeout: 5000 }) } catch (failure) { report.failureScreenshotError = failure.message }
      try { report.bodyDiagnostic = (await page.locator('body').innerText({ timeout: 3000 })).slice(0, 6000) } catch (failure) { report.bodyDiagnosticError = failure.message }
      if (identity) try { report.sessionDiagnostic = await inspectIsolatedTeamPane(page, identity) } catch (failure) { report.sessionDiagnosticError = failure.message }
    }
  } finally {
    if (appHandle) try { report.cleanup.push(await closeOwned(appHandle)) } catch (error) { report.status = 'failed'; report.cleanupError = error.message }
    report.provider = mock.observations()
    await mock.close()
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2), { flag: 'wx' })
    await fs.writeFile(path.join(evidence, 'main-output.log'), stdout + '\n--- stderr ---\n' + stderr, { flag: 'wx' })
  }
  return report
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2] || !process.argv[3]) throw new Error('Pass a new private run root and private worker path.')
  const report = await runIsolatedTeamDesignerDesktop(path.resolve(process.argv[2]), path.resolve(process.argv[3]))
  console.log('isolated-team-designer-result', JSON.stringify({ status: report.status, stage: report.stage, error: report.error?.message, runRoot: report.runRoot, cleanup: report.cleanup }))
  process.exitCode = report.status === 'partial-passed' ? 0 : 1
}
