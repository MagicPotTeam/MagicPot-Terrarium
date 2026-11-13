// Synthetic fixture preparation for a caller-owned, fresh isolated Electron profile.
// IMPORTANT: this module does not launch, isolate, authenticate, or configure a
// runner. The caller must establish those boundaries before invoking it. Seeding
// is fixture preparation, NOT UI team creation, approval, or model execution.
import { randomUUID } from 'node:crypto'

const PANE = 'agent-1'
const TIMEOUT = 60_000
const fixtures = new Map()
const attemptedPages = new WeakSet()
const memberAttempts = new WeakMap()
const flowAttempts = new WeakMap()

function validateIdentity(identity) {
  const saved = fixtures.get(identity?.sessionId)
  if (!saved || saved !== identity) throw new Error('Use the identity returned by this fixture in this runner process.')
  return saved
}

function selector(identity) {
  validateIdentity(identity)
  // Generated values contain only known literals and UUID characters.
  return `[data-agent-workspace-pane="${PANE}"][data-agent-workspace-scope="${identity.scope}"]`
}

/**
 * Prepare only a synthetic lead session and canvas pane. This writes to the
 * supplied page's IndexedDB/localStorage and reloads it. The caller MUST first
 * verify a new isolated profile, synthetic configuration and provider, and all
 * relevant paths/network boundaries. Never point this at a personal profile.
 * An attempted seed is never retried by this module, even after an error.
 */
export async function seedIsolatedTeamLead(page, { profileId, freshSyntheticProfile, signal } = {}) {
  if (freshSyntheticProfile !== true) throw new Error('Caller must verify and explicitly attest a fresh synthetic profile.')
  if (attemptedPages.has(page)) throw new Error('Seed already attempted on this page; outcome may be unknown.')
  if (typeof profileId !== 'string' || !profileId.trim() || profileId !== profileId.trim()) {
    throw new TypeError('Provide the exact synthetic profileId configured by the caller.')
  }
  attemptedPages.add(page)
  const assertActive = () => { if (signal?.aborted) throw new Error('Synthetic lead seed aborted; outcome may be unknown') }
  assertActive()
  const suffix = randomUUID()
  const projectId = `tab-project-isolated-team-${suffix}`
  const sessionId = `isolated-team-lead-${suffix}`
  const scope = `${projectId}.${PANE}`
  const identity = Object.freeze({ projectId, sessionId, scope, profileId })
  const session = {
    id: sessionId, storageKey: `${scope}\u0000${sessionId}`, storageScope: scope,
    title: '合成团队验收组长', profileId, createdAt: Date.now(), messages: []
  }
  await page.waitForFunction(() => Boolean(window.api && document.querySelector('#root')?.childElementCount), undefined, { timeout: TIMEOUT })
  assertActive()
  await page.evaluate(async ({ session, projectId, paneId }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open('magicpot-chat', 2)
      let settled = false
      open.onupgradeneeded = () => {
        // A blocked/error open may later become unblocked. Do not create or
        // upgrade anything after the caller has already observed failure.
        if (settled) { open.transaction.abort(); return }
        if (!open.result.objectStoreNames.contains('sessions-v2')) open.result.createObjectStore('sessions-v2', { keyPath: 'storageKey' })
      }
      open.onerror = () => { if (!settled) { settled = true; reject(open.error || new Error('Synthetic fixture database unavailable.')) } }
      open.onblocked = () => { if (!settled) { settled = true; reject(new Error('Synthetic fixture database blocked.')) } }
      open.onsuccess = () => { if (settled) open.result.close(); else { settled = true; resolve(open.result) } }
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions-v2', 'readwrite')
        const store = tx.objectStore('sessions-v2')
        let abortReason
        tx.oncomplete = () => resolve()
        // Error events may bubble before the transaction's abort event. Only a
        // terminal transaction event establishes whether the write finished.
        tx.onabort = () => reject(abortReason || tx.error || new Error('Synthetic lead write aborted.'))
        if (store.keyPath !== 'storageKey') { abortReason = new Error('Unexpected chat store key.'); tx.abort(); return }
        store.add(session)
      })
    } finally { db.close() }
    const route = `/canvas?id=${encodeURIComponent(projectId)}`
    localStorage.setItem(`agent.workspace.${projectId}`, JSON.stringify([{ id: paneId, enabled: true }]))
    localStorage.setItem(`agent.workspace.active.${projectId}`, paneId)
    localStorage.setItem(`chat.currentSessionId.${session.storageScope}`, session.id)
    localStorage.setItem(`chat.selectedProfileId.${session.storageScope}`, session.profileId)
    localStorage.setItem('app.hasLaunched', '1')
    localStorage.setItem('layout.state', JSON.stringify({ activeSidePanel: 'explorer', sidePanelWidth: 320, rightPanelVisible: true, bottomPanelVisible: false, bottomPanelActiveTab: 'terminal', openTabs: [{ id: projectId, label: session.title, routePath: route, closable: true }], activeTabId: projectId, lastActiveProjectId: projectId, lastRoutePath: route }))
    window.history.replaceState(null, '', '#' + route)
  }, { session, projectId, paneId: PANE })
  assertActive()
  fixtures.set(sessionId, identity)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT })
  assertActive()
  await waitForIsolatedTeamPane(page, identity)
  assertActive()
  return identity
}

/** Observe the actual scoped ChatPage, not a fabricated team or approval. */
export async function waitForIsolatedTeamPane(page, identity) {
  const pane = selector(identity)
  await page.waitForFunction(({ pane, identity }) => {
    const node = document.querySelector(pane)
    return node?.getAttribute('aria-hidden') === 'false' &&
      localStorage.getItem(`chat.currentSessionId.${identity.scope}`) === identity.sessionId &&
      localStorage.getItem(`chat.selectedProfileId.${identity.scope}`) === identity.profileId &&
      Boolean(node.querySelector('[data-testid="chat-composer-input"]'))
  }, { pane, identity }, { timeout: TIMEOUT })
  return page.locator(pane)
}

/** Read-only UI snapshot. Text is synthetic-only; no delivery is inferred. */
export async function inspectIsolatedTeamPane(page, identity) {
  await waitForIsolatedTeamPane(page, identity)
  return page.locator(selector(identity)).evaluate(pane => {
    const process = pane.querySelector('section[aria-label="进程区"]')
    const approvals = pane.querySelector('[data-testid="team-inline-approvals"]')
    return {
      composerPresent: Boolean(pane.querySelector('[data-testid="chat-composer-input"]')),
      processVisible: Boolean(process && !process.hidden),
      processText: process?.innerText ?? null,
      approvalText: approvals?.innerText ?? null
    }
  })
}

async function createMember(page, identity, name) {
  validateIdentity(identity)
  let attempts = memberAttempts.get(identity)
  if (!attempts) { attempts = new Set(); memberAttempts.set(identity, attempts) }
  if (attempts.has(name)) throw new Error(`${name} creation was already attempted; outcome may be unknown.`)
  // Reserve before any awaited UI action: concurrent calls and unknown results
  // cannot re-open or replay the creation flow in this runner process.
  attempts.add(name)
  const pane = await waitForIsolatedTeamPane(page, identity)
  const process = pane.getByRole('region', { name: '进程区', exact: true })
  if (name === '设计师') {
    // Select the actual localized control, not MUI's development-only icon test id.
    await pane.locator('[data-testid="chat-composer-left-controls"]').getByRole('button', { name: '添加文件', exact: true }).click({ timeout: TIMEOUT })
    await page.getByRole('menuitem', { name: '组建团队 / 添加成员', exact: true }).click({ timeout: TIMEOUT })
  } else {
    await process.getByRole('button', { name: '打开 设计师', exact: true }).waitFor({ state: 'visible', timeout: TIMEOUT })
    await process.getByRole('button', { name: '团队管理', exact: true }).click({ timeout: TIMEOUT })
    const management = page.getByRole('dialog', { name: '团队管理', exact: true })
    await management.waitFor({ state: 'visible', timeout: TIMEOUT })
    await management.getByRole('button', { name: '组建团队 / 添加成员', exact: true }).click({ timeout: TIMEOUT })
  }
  const form = page.getByRole('dialog', { name: '创建成员', exact: true })
  await form.waitFor({ state: 'visible', timeout: TIMEOUT })
  await form.getByLabel('成员名', { exact: true }).fill(name)
  await form.getByLabel('角色 / 当前任务', { exact: true }).fill(name)
  // A visible form is not a successful commit. One click only; timeout throws.
  await form.getByRole('button', { name: '确认创建成员', exact: true }).click({ timeout: TIMEOUT })
  await form.waitFor({ state: 'hidden', timeout: TIMEOUT })
  await process.getByRole('button', { name: `打开 ${name}`, exact: true }).waitFor({ state: 'visible', timeout: TIMEOUT })
}

/** Uses the real composer menu and real member creation form, once. */
export async function createIsolatedDesigner(page, identity) {
  return createMember(page, identity, '设计师')
}

/** Uses the real process management dialog and real member creation form, once. */
export async function createIsolatedWriter(page, identity) {
  return createMember(page, identity, '文案')
}

/** Read the real profile's session store without writing or replaying UI actions. */
export async function verifyIsolatedTeamMembers(page, identity) {
  await waitForIsolatedTeamPane(page, identity)
  return page.evaluate(async ({ scope, leadId }) => {
    // Abort rather than create or upgrade a database if the expected DB is absent.
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('magicpot-chat', 2)
      request.onupgradeneeded = () => { request.transaction.abort() }
      request.onerror = () => reject(request.error || new Error('Session database unavailable.'))
      request.onblocked = () => reject(new Error('Session database blocked.'))
      request.onsuccess = () => resolve(request.result)
    })
    try {
      if (!db.objectStoreNames.contains('sessions-v2')) throw new Error('Session store unavailable.')
      const rows = await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions-v2', 'readonly')
        const request = tx.objectStore('sessions-v2').getAll()
        let result
        request.onsuccess = () => { result = request.result }
        request.onerror = () => reject(request.error)
        tx.oncomplete = () => resolve(result)
        tx.onabort = () => reject(tx.error || new Error('Session read aborted.'))
        tx.onerror = () => reject(tx.error)
      })
      const members = rows.filter(row => row.storageScope === scope && row.teamLeadId === leadId && !row.archived)
      if (members.length !== 2 || new Set(members.map(member => member.id)).size !== 2 ||
          members.some(member => typeof member.id !== 'string' || !member.id || !Array.isArray(member.messages)) ||
          ['设计师', '文案'].some(name => members.filter(member => member.teamMemberName === name).length !== 1)) {
        throw new Error('Expected exactly two unique synthetic team members with message arrays in this scope.')
      }
      return members.map(member => ({ id: member.id, name: member.teamMemberName, messageCount: member.messages.length }))
        .sort((a, b) => a.name.localeCompare(b.name))
    } finally { db.close() }
  }, { scope: identity.scope, leadId: identity.sessionId })
}

function reserveFlow(identity, key) {
  validateIdentity(identity)
  let attempts = flowAttempts.get(identity)
  if (!attempts) { attempts = new Set(); flowAttempts.set(identity, attempts) }
  if (attempts.has(key)) throw new Error(`${key} already attempted; outcome may be unknown.`)
  attempts.add(key)
}

// Per-identity, per-module-instance only. Completion records no message content.
const channelZeroVerified = new WeakSet()
export async function broadcastIsolatedTeamChannel(page, identity, stage, verifyZero) {
  if (stage !== 'zero-subscribers' && stage !== 'one-subscriber') throw new TypeError('Invalid channel stage.')
  reserveFlow(identity, `channel-${stage}`)
  if (stage === 'one-subscriber' && !channelZeroVerified.has(identity)) throw new Error('Zero-subscriber stage not verified.')
  if (stage === 'zero-subscribers' && typeof verifyZero !== 'function') throw new TypeError('Zero-subscriber verification is required.')
  await waitForIsolatedTeamPane(page, identity)
  const dialog = page.getByRole('dialog', { name: '团队管理', exact: true })
  await dialog.getByRole('button', { name: '广播给订阅成员', exact: true }).click({ timeout: TIMEOUT })
  if (stage === 'zero-subscribers') {
    if (await verifyZero() !== true) throw new Error('Zero-subscriber stage not verified.')
    channelZeroVerified.add(identity)
  }
}

async function sendOnce(page, identity, key, text) {
  reserveFlow(identity, key)
  const pane = await waitForIsolatedTeamPane(page, identity)
  const input = pane.locator('[data-testid="chat-composer-input"]')
  await input.fill(text)
  await pane.locator('[data-chat-send-btn]').click({ timeout: TIMEOUT })
}

async function waitForAssistant(page, identity, memberId, text, requireImage) {
  await page.waitForFunction(async ({ scope, leadId, memberId, text, requireImage }) => {
    const req = indexedDB.open('magicpot-chat', 2)
    const db = await new Promise((resolve, reject) => {
      req.onupgradeneeded = () => req.transaction.abort()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
      req.onblocked = () => reject(new Error('Session DB blocked'))
    })
    try {
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction('sessions-v2', 'readonly')
        const get = tx.objectStore('sessions-v2').get(`${scope}\u0000${memberId}`)
        let value
        get.onsuccess = () => { value = get.result }
        tx.oncomplete = () => resolve(value)
        tx.onabort = () => reject(tx.error || new Error('Session read aborted'))
        tx.onerror = () => reject(tx.error)
      })
      return row?.storageScope === scope && (memberId === leadId || row.teamLeadId === leadId) &&
        Array.isArray(row.messages) && row.messages.some(message => message.role === 'assistant' && message.content === text &&
          (!requireImage || message.attachments?.some(attachment => attachment.type === 'image')))
    } finally { db.close() }
  }, { scope: identity.scope, leadId: identity.sessionId, memberId, text, requireImage }, { timeout: TIMEOUT })
}

/** Send once, then independently observe the real stored result and canvas label. */
export async function sendIsolatedDesigner(page, identity) {
  const members = await verifyIsolatedTeamMembers(page, identity)
  const designer = members.find(member => member.name === '设计师')
  if (designer.messageCount !== 0) throw new Error('Designer session is not empty; cannot attribute result.')
  await sendOnce(page, identity, 'designer-send', '@设计师 设计海报')
  await waitForAssistant(page, identity, designer.id, '设计结果', true)
  await page.locator('[data-canvas-team-image-label]').filter({ hasText: '设计师·图1' }).waitFor({ state: 'visible', timeout: TIMEOUT })
  return { designerId: designer.id, assistantText: '设计结果', imageAttachmentObserved: true, canvasLabelVisible: true }
}

/** Read actual notes IPC for the verified writer; no write is performed. */
export async function readIsolatedWriterNotes(page, identity) {
  const members = await verifyIsolatedTeamMembers(page, identity)
  const writer = members.find(member => member.name === '文案')
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: identity.projectId, threadId: PANE }
  const notes = await page.evaluate(({ route, conversationId }) => window.api.svcLLMProxy.getAgentNotes({ route, conversationId }), { route, conversationId: writer.id })
  return { writerId: writer.id, notes }
}

function routeFor(identity) {
  return { channel: 'canvas', scopeType: 'thread', scopeId: identity.projectId, threadId: PANE }
}

function matchingApproval(item, route, writerId) {
  const p = item?.request?.request
  return p && ['channel', 'scopeType', 'scopeId', 'threadId'].every(key => p.route?.[key] === route[key]) &&
    p.sessionId === writerId && p.action === 'memory.note.write' &&
    p.target?.kind === 'tool' && p.target?.id === 'scratchpad' &&
    p.input?.conversationId === writerId && p.input?.action === 'set' &&
    p.input?.key === 'fixture' && p.input?.value === 'approved-value' && p.input?.expectedRevision === 0
}

/** Send once only after confirming a clean writer notes scope. */
export async function sendIsolatedWriter(page, identity) {
  const { writerId, notes } = await readIsolatedWriterNotes(page, identity)
  const members = await verifyIsolatedTeamMembers(page, identity)
  if (members.find(member => member.name === '文案').messageCount !== 0 ||
      notes?.revision !== 0 || !Array.isArray(notes.notes) || notes.notes.length !== 0) {
    throw new Error('Writer session or notes are not empty; refusing to attribute results.')
  }
  await sendOnce(page, identity, 'writer-send', '@文案 保存工作笔记')
  return { writerId, initialNotesRevision: 0 }
}

/** Read the real pending-approval IPC; no UI text is used to establish identity. */
export async function inspectIsolatedWriterApproval(page, identity) {
  validateIdentity(identity)
  const attempts = flowAttempts.get(identity)
  if (!attempts?.has('writer-send')) throw new Error('Writer send has not been attempted.')
  await waitForIsolatedTeamPane(page, identity)
  const members = await verifyIsolatedTeamMembers(page, identity)
  const writerId = members.find(member => member.name === '文案').id
  const route = routeFor(identity)
  const deadline = Date.now() + TIMEOUT
  let approvals
  do {
    ;({ approvals } = await page.evaluate(() => window.api.svcMagicAgentPlatform.listPendingApprovals({})))
    if (!Array.isArray(approvals)) throw new Error('Invalid pending approvals response.')
    if (approvals.length) break
    await new Promise(resolve => setTimeout(resolve, 200))
  } while (Date.now() < deadline)
  if (approvals.length !== 1 || !matchingApproval(approvals[0], route, writerId) ||
      typeof approvals[0].approvalId !== 'string' || !Number.isSafeInteger(approvals[0].revision)) {
    throw new Error('Expected one exactly matching writer scratchpad pending approval; refusing to act.')
  }
  const pending = { approvalId: approvals[0].approvalId, revision: approvals[0].revision, writerId }
  return pending
}

/** Verify IPC identity first, then click exactly one matching real card once. */
export async function approveIsolatedWriter(page, identity, expected) {
  const pending = { approvalId: expected?.approvalId, revision: expected?.revision, writerId: expected?.writerId }
  if (typeof pending.approvalId !== 'string' || !pending.approvalId ||
      !Number.isSafeInteger(pending.revision) || typeof pending.writerId !== 'string' || !pending.writerId) {
    throw new Error('Expected writer approval identity and revision are required.')
  }
  const samePending = item => item.approvalId === pending.approvalId && item.revision === pending.revision && item.writerId === pending.writerId
  if (!samePending(await inspectIsolatedWriterApproval(page, identity))) throw new Error('Pending approval differs from expected.')
  const pane = await waitForIsolatedTeamPane(page, identity)
  const cards = pane.locator('[data-testid="team-inline-approvals"]')
  await cards.waitFor({ state: 'visible', timeout: TIMEOUT })
  await page.waitForFunction(({ pane, approvalId, revision }) => {
    const host = document.querySelector(pane)?.querySelector('[data-testid="team-inline-approvals"]')
    return Array.from(host?.querySelectorAll('[data-approval-id][data-approval-revision]') ?? []).some(card =>
      card.getAttribute('data-approval-id') === approvalId && card.getAttribute('data-approval-revision') === String(revision) &&
      card.innerText.includes('文案 想保存一条笔记') && card.innerText.includes('approved-value'))
  }, { pane: selector(identity), approvalId: pending.approvalId, revision: pending.revision }, { timeout: TIMEOUT })
  // Bind the visible UI card to the MAIN-sourced identity and revision. The DOM
  // is only a selector, never an authorization source or input to the decision.
  const card = cards.locator(`[data-approval-id=${JSON.stringify(pending.approvalId)}][data-approval-revision=${JSON.stringify(String(pending.revision))}]`).filter({
    has: page.getByText('文案 想保存一条笔记', { exact: true })
  }).filter({ hasText: 'approved-value' })
  if (await card.count() !== 1 ||
      await card.getAttribute('data-approval-id') !== pending.approvalId ||
      await card.getAttribute('data-approval-revision') !== String(pending.revision)) {
    throw new Error('The visible writer card is not bound to the expected pending approval.')
  }
  const buttons = card.getByRole('button', { name: '批准', exact: true })
  if (await buttons.count() !== 1 || await card.getByRole('button', { name: '拒绝', exact: true }).count() !== 1) throw new Error('Expected exactly one matching inline approval card.')
  const again = await inspectIsolatedWriterApproval(page, identity)
  if (!samePending(again)) throw new Error('Pending approval changed before click.')
  if (await card.getAttribute('data-approval-id') !== pending.approvalId ||
      await card.getAttribute('data-approval-revision') !== String(pending.revision)) throw new Error('Visible approval card changed before click.')
  reserveFlow(identity, 'writer-approval')
  // Keep identity, revision and fixture details in the locator itself. If React
  // replaces it before Playwright clicks, a different card will not match.
  await card.getByRole('button', { name: '批准', exact: true }).click({ timeout: TIMEOUT })
  const route = routeFor(identity)
  await page.waitForFunction(async ({ route, writerId }) => {
    const result = await window.api.svcLLMProxy.getAgentNotes({ route, conversationId: writerId })
    return result?.revision === 1 && Array.isArray(result.notes) && result.notes.length === 1 &&
      result.notes[0].key === 'fixture' && result.notes[0].value === 'approved-value'
  }, { route, writerId: pending.writerId }, { timeout: TIMEOUT })
  await waitForAssistant(page, identity, pending.writerId, '文案结果', false)
  return { writerId: pending.writerId, approvalId: pending.approvalId, revision: pending.revision, notesRevision: 1, assistantText: '文案结果' }
}

// TODO: lead summary and channel actions remain unimplemented.
