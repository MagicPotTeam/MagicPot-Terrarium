// Real UI driver for an already launched, fresh isolated Electron profile.
// It seeds only its own short text session; all goal operations use the actual
// Goals form/buttons and their normal IPC. No model request or API substitute.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const DB_NAME = 'magicpot-chat'
const DB_VERSION = 2
const STORE_NAME = 'sessions-v2'
const PANE_ID = 'agent-1'
const TIMEOUT_MS = 60_000
const PANEL = 'section[aria-labelledby]'
const NOTICE = 'Manual records only. Activating a goal does not run a model or grant permissions.'
const fixtures = new Map()
const seededPages = new WeakSet()

function fixtureFor(identity) {
  const fixture = fixtures.get(identity?.sessionId)
  const fields = ['scope', 'sessionId', 'projectId', 'profileId', 'goalTitle', 'goalObjective']
  if (!fixture || fields.some(key => identity[key] !== fixture.identity[key])) {
    throw new Error('Use the identity returned by this isolated goals fixture.')
  }
  return fixture
}

function paneSelector(identity) {
  fixtureFor(identity)
  return `[data-agent-workspace-pane="${PANE_ID}"][data-agent-workspace-scope="${identity.scope}"]`
}

async function readyPane(page, identity) {
  const selector = paneSelector(identity)
  await page.waitForFunction(({ selector, identity }) => {
    const pane = document.querySelector(selector)
    return pane?.getAttribute('aria-hidden') === 'false' &&
      localStorage.getItem(`chat.currentSessionId.${identity.scope}`) === identity.sessionId &&
      localStorage.getItem(`chat.selectedProfileId.${identity.scope}`) === identity.profileId &&
      [...pane.querySelectorAll('button')].some(button => ['Goals', 'Close goals'].includes(button.textContent.trim()))
  }, { selector, identity }, { timeout: TIMEOUT_MS })
  return page.locator(selector)
}

async function waitForPanelState(page, identity, expectedStatus) {
  if (expectedStatus !== undefined && !['empty', 'draft', 'active', 'paused'].includes(expectedStatus)) {
    throw new TypeError('Expected empty, draft, active or paused.')
  }
  await page.waitForFunction(({ selector, identity, expectedStatus, notice }) => {
    const pane = document.querySelector(selector)
    if (!pane || pane.getAttribute('aria-hidden') !== 'false' ||
        localStorage.getItem(`chat.currentSessionId.${identity.scope}`) !== identity.sessionId) return false
    const panel = pane.querySelector('section[aria-labelledby]')
    if (!panel) return false
    const error = panel.querySelector('[role="alert"]')
    if (error) throw new Error('Goal panel error: ' + error.textContent.trim())
    if ([...pane.querySelectorAll('button')].some(button => button.textContent.trim() === 'I reviewed the goals')) {
      throw new Error('Goal mutation outcome is unknown; the fixture will not acknowledge or replay it.')
    }
    if (!panel.textContent.includes(notice)) throw new Error('The expected manual-records surface is absent.')
    const labelledInput = name => {
      const label = [...panel.querySelectorAll('label')].find(element => element.textContent.trim() === name)
      return label?.htmlFor ? document.getElementById(label.htmlFor) : null
    }
    const title = labelledInput('Goal title')
    const objective = labelledInput('Objective')
    if (!title || !objective || title.disabled || objective.disabled) return false
    const rows = [...panel.children].filter(row =>
      [...row.children].some(child => /^Status: (draft|active|waiting|blocked|paused|cancelled|completed|failed)$/.test(child.textContent.trim())))
    if (expectedStatus === undefined) return true
    if (expectedStatus === 'empty') return rows.length === 0 && panel.textContent.includes('No goals yet.')
    if (rows.length !== 1) return false
    const row = rows[0]
    const children = [...row.children]
    const status = children.find(child => child.textContent.trim() === 'Status: ' + expectedStatus)
    const action = expectedStatus === 'active' ? 'Pause ' : 'Activate '
    const button = [...row.querySelectorAll('button')].find(element => element.textContent.trim() === action + identity.goalTitle)
    return children[0]?.textContent.trim() === identity.goalTitle &&
      children[1]?.textContent.trim() === identity.goalObjective &&
      Boolean(status && button && !button.disabled)
  }, { selector: paneSelector(identity), identity, expectedStatus, notice: NOTICE }, { timeout: TIMEOUT_MS })
}

/**
 * Creates a new text-only ChatPage session and canvas pane in the caller's fresh
 * profile. Keep identity in the parent runner across an Electron restart; do not
 * seed again. A new Page may use the same identity after the app restarts.
 */
export async function seedIsolatedThreadGoalsSession(page, { profileId }) {
  if (seededPages.has(page)) throw new Error('This page already has a goals fixture.')
  if (typeof profileId !== 'string' || !profileId.trim() || profileId !== profileId.trim()) {
    throw new TypeError('Provide the exact profileId configured by the isolated runner.')
  }
  const suffix = randomUUID()
  const projectId = `tab-project-isolated-goals-${suffix}`
  const sessionId = `isolated-goals-${suffix}`
  const scope = `${projectId}.${PANE_ID}`
  const identity = Object.freeze({
    projectId, sessionId, scope, profileId,
    goalTitle: `Isolated goal ${suffix}`,
    goalObjective: `Keep this synthetic manual goal record across an isolated app restart. Fixture ${suffix}.`
  })
  const messages = [
    { role: 'user', content: `Synthetic manual goals fixture ${sessionId}.` },
    { role: 'assistant', content: 'Ready for manual record checks.' }
  ]
  const session = {
    id: sessionId, storageKey: `${scope}\u0000${sessionId}`, storageScope: scope,
    title: 'Isolated manual thread goals', profileId, createdAt: Date.now(), messages
  }
  await page.waitForFunction(() => Boolean(window.api && document.querySelector('#root')?.childElementCount), undefined, { timeout: TIMEOUT_MS })
  await page.evaluate(async ({ dbName, dbVersion, storeName, session, projectId, paneId }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, dbVersion)
      open.onupgradeneeded = () => {
        if (!open.result.objectStoreNames.contains(storeName)) {
          open.result.createObjectStore(storeName, { keyPath: 'storageKey' })
        }
      }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error('Fixture database upgrade is blocked.'))
      open.onsuccess = () => resolve(open.result)
    })
    try {
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readwrite')
        const store = transaction.objectStore(storeName)
        if (store.keyPath !== 'storageKey') {
          transaction.abort()
          reject(new Error('Unexpected chat store key.'))
          return
        }
        store.add(session)
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error || new Error('Fixture session write aborted.'))
        transaction.onerror = () => reject(transaction.error)
      })
    } finally { db.close() }
    const route = `/canvas?id=${encodeURIComponent(projectId)}`
    localStorage.setItem(`agent.workspace.${projectId}`, JSON.stringify([{ id: paneId, enabled: true }]))
    localStorage.setItem(`agent.workspace.active.${projectId}`, paneId)
    localStorage.setItem(`chat.currentSessionId.${session.storageScope}`, session.id)
    localStorage.setItem(`chat.selectedProfileId.${session.storageScope}`, session.profileId)
    localStorage.setItem('app.hasLaunched', '1')
    localStorage.setItem('layout.state', JSON.stringify({
      activeSidePanel: 'explorer', sidePanelWidth: 320, rightPanelVisible: true,
      bottomPanelVisible: false, bottomPanelActiveTab: 'terminal',
      openTabs: [{ id: projectId, label: session.title, routePath: route, closable: true }],
      activeTabId: projectId, lastActiveProjectId: projectId, lastRoutePath: route
    }))
    window.history.replaceState(null, '', '#' + route)
  }, { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, session, projectId, paneId: PANE_ID })
  fixtures.set(sessionId, { identity, messages, createAttempted: false })
  seededPages.add(page)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })
  await readyPane(page, identity)
  return identity
}

/** Opens the real entry and waits for its scope binding + list response. */
export async function openIsolatedThreadGoals(page, identity, { expectedStatus } = {}) {
  const pane = await readyPane(page, identity)
  const open = pane.getByRole('button', { name: 'Goals', exact: true })
  if (await open.count()) await open.click({ timeout: TIMEOUT_MS })
  await pane.locator(PANEL).waitFor({ state: 'visible', timeout: TIMEOUT_MS })
  await waitForPanelState(page, identity, expectedStatus)
  return inspectIsolatedThreadGoals(page, identity)
}

/** Creates exactly one draft using the two actual TextFields and submit button. */
export async function createIsolatedThreadGoal(page, identity) {
  const fixture = fixtureFor(identity)
  if (fixture.createAttempted) throw new Error('A create was already attempted; never replay an unknown outcome.')
  await openIsolatedThreadGoals(page, identity, { expectedStatus: 'empty' })
  const panel = page.locator(paneSelector(identity)).locator(PANEL)
  await panel.getByLabel('Goal title', { exact: true }).fill(identity.goalTitle)
  await panel.getByLabel('Objective', { exact: true }).fill(identity.goalObjective)
  fixture.createAttempted = true
  await panel.getByRole('button', { name: 'Create draft', exact: true }).click({ timeout: TIMEOUT_MS })
  await waitForPanelState(page, identity, 'draft')
  assert.equal(await panel.getByLabel('Goal title', { exact: true }).inputValue(), '', 'Applied create must reset title')
  assert.equal(await panel.getByLabel('Objective', { exact: true }).inputValue(), '', 'Applied create must reset objective')
  return inspectIsolatedThreadGoals(page, identity)
}

/** Status controls are manual records; this driver never invokes a send command. */
export async function setIsolatedThreadGoalStatus(page, identity, status) {
  if (!['active', 'paused'].includes(status)) throw new TypeError('Only active and paused are UI controls.')
  const before = await openIsolatedThreadGoals(page, identity)
  assert.equal(before.ui.goals.length, 1, 'Expected the single fixture goal')
  const goal = before.ui.goals[0]
  assert.equal(goal.title, identity.goalTitle)
  assert.equal(goal.objective, identity.goalObjective)
  const allowed = status === 'active' ? ['draft', 'paused'] : ['active', 'waiting', 'blocked']
  assert(allowed.includes(goal.status), 'The requested control is not valid for the current displayed state')
  const label = (status === 'active' ? 'Activate ' : 'Pause ') + identity.goalTitle
  await page.locator(paneSelector(identity)).locator(PANEL).getByRole('button', { name: label, exact: true }).click({ timeout: TIMEOUT_MS })
  await waitForPanelState(page, identity, status)
  return inspectIsolatedThreadGoals(page, identity)
}

/** Unmounts the host through its actual Close goals button, releasing its binding. */
export async function closeIsolatedThreadGoals(page, identity) {
  const pane = await readyPane(page, identity)
  const close = pane.getByRole('button', { name: 'Close goals', exact: true })
  assert.equal(await close.count(), 1, 'Goals must be open before closing')
  await close.click({ timeout: TIMEOUT_MS })
  await pane.locator(PANEL).waitFor({ state: 'detached', timeout: TIMEOUT_MS })
  assert.equal(await pane.getByRole('button', { name: 'Goals', exact: true }).getAttribute('aria-expanded'), 'false')
  return inspectIsolatedThreadGoals(page, identity)
}

/**
 * Read-only evidence: exactly this session's IDB key and its pane's rendered
 * records/errors. Goal ids/revisions/cipher are intentionally left to the runner's
 * actual IPC/SQLite evidence; the UI does not render those fields.
 */
export async function inspectIsolatedThreadGoals(page, identity) {
  const fixture = fixtureFor(identity)
  const snapshot = await page.evaluate(async ({ dbName, dbVersion, storeName, identity, selector }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, dbVersion)
      open.onupgradeneeded = () => {
        open.transaction.abort()
        reject(new Error('Fixture database is absent; inspection will not create it.'))
      }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error('Fixture database inspection is blocked.'))
      open.onsuccess = () => resolve(open.result)
    })
    let session
    try {
      session = await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const get = transaction.objectStore(storeName).get(`${identity.scope}\u0000${identity.sessionId}`)
        get.onsuccess = () => resolve(get.result)
        get.onerror = () => reject(get.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally { db.close() }
    if (!session || session.id !== identity.sessionId || session.storageScope !== identity.scope) {
      throw new Error('The owned synthetic session is absent.')
    }
    const pane = document.querySelector(selector)
    const panel = pane?.querySelector('section[aria-labelledby]')
    const rows = panel ? [...panel.children].filter(row =>
      [...row.children].some(child => /^Status: (draft|active|waiting|blocked|paused|cancelled|completed|failed)$/.test(child.textContent.trim()))) : []
    const goals = rows.map(row => {
      const children = [...row.children]
      const status = children.find(child => /^Status: /.test(child.textContent.trim()))
      return {
        title: children[0]?.textContent.trim() || '',
        objective: children[1]?.textContent.trim() || '',
        status: status?.textContent.trim().slice('Status: '.length) || '',
        controls: [...row.querySelectorAll('button')].map(button => ({ text: button.textContent.trim(), disabled: button.disabled }))
      }
    })
    return {
      identity, currentSessionId: localStorage.getItem(`chat.currentSessionId.${identity.scope}`),
      profileId: session.profileId,
      messages: (session.messages || []).map(message => ({ role: message.role, content: message.content })),
      messageCount: session.messages?.length || 0,
      attachmentCount: (session.messages || []).reduce((total, message) => total + (message.attachments?.length || 0), 0),
      draftText: session.draft?.inputValue || '',
      draftAttachmentCount: session.draft?.pendingAttachments?.length || 0,
      ui: {
        panePresent: Boolean(pane), paneActive: pane?.getAttribute('aria-hidden') === 'false',
        panelOpen: Boolean(panel), goals,
        composerValue: pane?.querySelector('[data-testid="chat-composer-input"]')?.value ?? null,
        errors: panel ? [...panel.querySelectorAll('[role="alert"]')].map(element => element.textContent.trim()) : [],
        unknownAcknowledgement: pane ? [...pane.querySelectorAll('button')].some(button => button.textContent.trim() === 'I reviewed the goals') : false
      }
    }
  }, { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, identity, selector: paneSelector(identity) })
  assert.equal(snapshot.currentSessionId, identity.sessionId, 'The selected conversation changed')
  assert.equal(snapshot.profileId, identity.profileId, 'The fixture profile changed')
  assert.deepEqual(snapshot.messages, fixture.messages, 'Goal UI must not submit or alter chat messages')
  assert.equal(snapshot.attachmentCount, 0)
  assert.equal(snapshot.draftAttachmentCount, 0)
  assert.equal(snapshot.draftText, '')
  assert.equal(snapshot.ui.composerValue, '', 'Goal form input must not enter the chat composer')
  assert.deepEqual(snapshot.ui.errors, [], 'The real goal panel reported an error')
  assert.equal(snapshot.ui.unknownAcknowledgement, false, 'A goal mutation has an unknown outcome')
  return snapshot
}
