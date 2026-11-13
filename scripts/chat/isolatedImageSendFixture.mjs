// Operates only on an already launched, caller-owned isolated Electron page.
// Reads only the eleven explicitly supplied synthetic PNG files. It never launches
// an app, reads configuration, invokes a fake request, or writes a filesystem file.
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DB_NAME = 'magicpot-chat'
const DB_VERSION = 2
const STORE_NAME = 'sessions-v2'
const PANE_ID = 'agent-1'
const READY_TIMEOUT_MS = 90_000
const owners = new WeakMap()
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function ownerFor(page, identity) {
  const owner = owners.get(page)
  if (!owner || !identity || ['scope', 'sessionId', 'projectId'].some(key => identity[key] !== owner.identity[key])) {
    throw new Error('The identity does not belong to this page fixture.')
  }
  return owner
}

function paneSelector(scope) {
  return `[data-agent-workspace-pane="${PANE_ID}"][data-agent-workspace-scope="${scope}"]`
}

async function readSyntheticPng(filePath, kind, index) {
  const bytes = await readFile(filePath)
  if (bytes.length < 33 || bytes.length > 20 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(pngSignature) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('The fixture accepts only bounded synthetic PNG files.')
  }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (kind === 'large' ? width !== 4096 || height !== 4096 :
    width < 1 || height < 1 || width > 2000 || height > 2000 || bytes.length > 512_000) {
    throw new Error('Expected eight 4096-square PNGs and three small history PNGs.')
  }
  const url = 'data:image/png;base64,' + bytes.toString('base64')
  return {
    attachment: {
      type: 'image', mimeType: 'image/png', url,
      fileName: `isolated-${kind}-${index + 1}.png`,
      sourceWidth: width, sourceHeight: height
    },
    summary: {
      kind, index, sourceBytes: bytes.length, sourceSha256: sha256(bytes),
      urlCharacters: url.length, urlSha256: sha256(url)
    }
  }
}

/**
 * Seed a new session in the real ChatPage schema, then reload the actual app.
 * The caller must supply a fresh isolated profile and its configured Responses
 * profileId. These sources are inline fixture data, so no local-media permission
 * is claimed or bypassed and no filesystem path is sent to the renderer/provider.
 */
export async function seedIsolatedImageSession(page, { largePaths, historyPaths, profileId }) {
  if (owners.has(page)) throw new Error('This page already owns an image-send fixture.')
  if (!Array.isArray(largePaths) || largePaths.length !== 8 ||
      !Array.isArray(historyPaths) || historyPaths.length !== 3 ||
      typeof profileId !== 'string' || !profileId.trim() || profileId !== profileId.trim()) {
    throw new TypeError('Provide eight largePaths, three historyPaths and an exact profileId.')
  }
  const paths = [...historyPaths, ...largePaths]
  if (paths.some(value => typeof value !== 'string' || !path.isAbsolute(value) || path.extname(value).toLowerCase() !== '.png') ||
      new Set(paths.map(value => path.resolve(value))).size !== 11) {
    throw new TypeError('All eleven fixture PNG paths must be distinct absolute paths.')
  }
  const history = []
  const large = []
  let sourceBytes = 0
  for (const [kind, inputPaths, target] of [['history', historyPaths, history], ['large', largePaths, large]]) {
    for (const [index, filePath] of inputPaths.entries()) {
      const image = await readSyntheticPng(filePath, kind, index)
      sourceBytes += image.summary.sourceBytes
      if (sourceBytes >= 32 * 1024 * 1024) throw new Error('Fixture source images must total less than 32 MiB.')
      target.push(image)
    }
  }
  const suffix = randomUUID()
  const projectId = `tab-project-isolated-images-${suffix}`
  const sessionId = `isolated-images-${suffix}`
  const scope = `${projectId}.${PANE_ID}`
  const identity = Object.freeze({ scope, sessionId, projectId })
  const readyText = `Isolated image fixture ready: ${sessionId}`
  const routePath = `/canvas?id=${encodeURIComponent(projectId)}`
  const createdAt = Date.now()
  const session = {
    id: sessionId, storageKey: `${scope}\u0000${sessionId}`, storageScope: scope,
    title: 'Isolated 8 + 3 image send', profileId, createdAt,
    messages: [
      { role: 'user', content: 'Three earlier synthetic reference images.', attachments: history.map(image => image.attachment) },
      { role: 'assistant', content: 'Synthetic reference images acknowledged.' }
    ],
    draft: {
      inputValue: readyText, pendingAttachments: large.map(image => image.attachment),
      pendingHiddenContext: '', updatedAt: createdAt
    }
  }

  await page.waitForFunction(() => Boolean(window.api && document.querySelector('#root')?.childElementCount), undefined, { timeout: READY_TIMEOUT_MS })
  await page.evaluate(async ({ dbName, dbVersion, storeName, fixture, paneId, route }) => {
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
          reject(new Error('Unexpected chat session store key.'))
          return
        }
        // add, not put: never replace even an accidentally colliding session.
        store.add(fixture)
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error || new Error('Fixture session write aborted.'))
        transaction.onerror = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
    const project = fixture.storageScope.slice(0, -(paneId.length + 1))
    // AgentWorkspace reads an array of panes (not a versioned wrapper object).
    localStorage.setItem(`agent.workspace.${project}`, JSON.stringify([{ id: paneId, enabled: true }]))
    localStorage.setItem(`agent.workspace.active.${project}`, paneId)
    localStorage.setItem(`chat.currentSessionId.${fixture.storageScope}`, fixture.id)
    localStorage.setItem(`chat.selectedProfileId.${fixture.storageScope}`, fixture.profileId)
    // Large draft bytes live only in IndexedDB, never the small localStorage backup.
    localStorage.setItem('app.hasLaunched', '1')
    localStorage.setItem('layout.state', JSON.stringify({
      activeSidePanel: 'explorer', sidePanelWidth: 320, rightPanelVisible: true,
      bottomPanelVisible: false, bottomPanelActiveTab: 'terminal',
      openTabs: [{ id: project, label: fixture.title, routePath: route, closable: true }],
      activeTabId: project, lastActiveProjectId: project, lastRoutePath: route
    }))
    // Replace the hash without racing the old mounted layout's navigation handlers;
    // reload below lets the real app hydrate the new layout and session together.
    window.history.replaceState(null, '', '#' + route)
  }, { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, fixture: session, paneId: PANE_ID, route: routePath })
  owners.set(page, {
    identity, readyText, profileId, sendAttempted: false,
    seedSources: [...history, ...large].map(image => image.summary)
  })
  await page.reload({ waitUntil: 'domcontentloaded', timeout: READY_TIMEOUT_MS })
  return identity
}

/** Clicks once through the real composer; completion/provider receipt is caller-owned. */
export async function sendIsolatedImageSession(page, identity) {
  const owner = ownerFor(page, identity)
  if (owner.sendAttempted) throw new Error('This fixture has already attempted its one UI send.')
  const selector = paneSelector(identity.scope)
  await page.waitForFunction(({ pane, scope, sessionId, readyText, profileId }) => {
    const target = document.querySelector(pane)
    const input = target?.querySelector('[data-testid="chat-composer-input"]')
    const tray = target?.querySelector('[data-testid="chat-composer-attachments"]')
    const button = target?.querySelector('button[data-chat-send-btn]')
    return target?.getAttribute('aria-hidden') === 'false' &&
      localStorage.getItem(`chat.currentSessionId.${scope}`) === sessionId &&
      localStorage.getItem(`chat.selectedProfileId.${scope}`) === profileId &&
      input?.value === readyText && !input.disabled &&
      tray?.children.length === 8 && Boolean(button && !button.disabled)
  }, { pane: selector, ...identity, readyText: owner.readyText, profileId: owner.profileId }, { timeout: READY_TIMEOUT_MS })
  const pane = page.locator(selector)
  const input = pane.locator('[data-testid="chat-composer-input"]')
  const prompt = `Compare the eight new synthetic images with the three earlier references. Reply briefly. Fixture ${identity.sessionId}.`
  await input.fill(prompt)
  owner.sendAttempted = true
  await pane.locator('button[data-chat-send-btn]').click({ timeout: READY_TIMEOUT_MS })
  return { ...identity, clickedAt: Date.now(), prompt }
}

/**
 * Reads only this fixture's primary key and its scoped UI. Call after stopping
 * peak sampling: reading persisted data URLs and hashing them is diagnostic work.
 * Inline URLs are summarized, avoiding a second ~40 MiB CDP/report copy.
 */
export async function inspectIsolatedImageSession(page, identity, { evaluate = page.evaluate.bind(page) } = {}) {
  const owner = ownerFor(page, identity)
  // After a native renderer crash, the caller may inspect the recovered same
  // webContents directly; the fixture owner and read-only IDB contract stay fixed.
  const result = await evaluate(async ({ dbName, dbVersion, storeName, scope, sessionId, pane }) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(dbName, dbVersion)
      open.onupgradeneeded = () => {
        open.transaction.abort()
        reject(new Error('Fixture database is missing; inspection will not create it.'))
      }
      open.onerror = () => reject(open.error)
      open.onblocked = () => reject(new Error('Fixture database inspection is blocked.'))
      open.onsuccess = () => resolve(open.result)
    })
    let session
    try {
      session = await new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName, 'readonly')
        const get = transaction.objectStore(storeName).get(`${scope}\u0000${sessionId}`)
        get.onsuccess = () => resolve(get.result)
        get.onerror = () => reject(get.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      db.close()
    }
    if (!session || session.id !== sessionId || session.storageScope !== scope) {
      throw new Error('The seeded fixture session is missing.')
    }
    const summarizeAttachments = async (attachments = []) => {
      const result = []
      for (const attachment of attachments) {
        const url = String(attachment.url || '')
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
        result.push({
          type: attachment.type, fileName: attachment.fileName,
          scheme: url.split(':', 1)[0], urlCharacters: url.length,
          urlSha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
          ...(url.startsWith('data:') ? { prefix: url.slice(0, url.indexOf(',') + 1) } : { url })
        })
      }
      return result
    }
    const messages = []
    for (const message of session.messages || []) {
      messages.push({
        role: message.role, content: typeof message.content === 'string' ? message.content.slice(0, 2000) : '',
        attachments: await summarizeAttachments(message.attachments)
      })
    }
    const draftAttachments = await summarizeAttachments(session.draft?.pendingAttachments)
    const target = document.querySelector(pane)
    const input = target?.querySelector('[data-testid="chat-composer-input"]')
    return {
      sessionId, scope, profileId: session.profileId, messageCount: messages.length, messages,
      messageAttachmentCount: messages.reduce((count, message) => count + message.attachments.length, 0),
      draft: { inputValue: session.draft?.inputValue || '', attachmentCount: draftAttachments.length, attachments: draftAttachments },
      currentSessionId: localStorage.getItem(`chat.currentSessionId.${scope}`),
      ui: {
        panePresent: Boolean(target), inputValue: input?.value ?? null,
        pendingPreviewCount: target?.querySelector('[data-testid="chat-composer-attachments"]')?.children.length ?? 0,
        sendButtonPresent: Boolean(target?.querySelector('button[data-chat-send-btn]')),
        // useMessage uses notistack variant:error; library provides this class.
        errorTexts: [...document.querySelectorAll('.notistack-MuiContent-error[role="alert"]')]
          .map(element => element.textContent?.trim() || '').filter(Boolean)
      }
    }
  }, { dbName: DB_NAME, dbVersion: DB_VERSION, storeName: STORE_NAME, ...identity, pane: paneSelector(identity.scope) })
  return { ...result, sendAttempted: owner.sendAttempted, seedSources: owner.seedSources }
}
