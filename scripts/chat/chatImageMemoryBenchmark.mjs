import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import zlib from 'node:zlib'
import {
  assertNonIntrusiveWindowPlacement,
  buildNonIntrusiveTestWindowEnv,
  resolveProjectCanvasArtifactRoot,
  resolveProjectCanvasBenchmarkRunId
} from '../projectCanvas/benchmarkPolicy.mjs'

const DEFAULT_MESSAGE_COUNT = 500
const DEFAULT_ATTACHMENT_COUNT = 100
const DB_NAME = 'magicpot-chat'
const DB_VERSION = 2
const STORE_NAME = 'sessions-v2'
const PROJECT_ID = 'chat-image-memory-benchmark'
const PANE_ID = 'agent-1'
const SESSION_ID = 'chat-image-memory-session'
const SCOPE = `${PROJECT_ID}.${PANE_ID}`
const RUN_ID = resolveProjectCanvasBenchmarkRunId('chat-image-memory-benchmark')
const WINDOW_ENV = buildNonIntrusiveTestWindowEnv(RUN_ID)

const parseCount = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const MESSAGE_COUNT = parseCount('MAGICPOT_CHAT_MEMORY_MESSAGE_COUNT', DEFAULT_MESSAGE_COUNT)
const ATTACHMENT_COUNT = Math.min(
  MESSAGE_COUNT,
  parseCount('MAGICPOT_CHAT_MEMORY_ATTACHMENT_COUNT', DEFAULT_ATTACHMENT_COUNT)
)

let crcTable
function crc32(buffer) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1))
      return value >>> 0
    })
  }
  let crc = 0xffffffff
  for (const byte of buffer) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff]
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, checksum])
}

export function createDeterministicPng(index, width = 512, height = 512) {
  const rows = []
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4)
    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4
      row[offset] = (x * 3 + index * 17) & 0xff
      row[offset + 1] = (y * 5 + index * 29) & 0xff
      row[offset + 2] = ((x ^ y) + index * 43) & 0xff
      row[offset + 3] = 255
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

export function buildFixtureSession(attachmentPaths, messageCount = MESSAGE_COUNT) {
  const attachmentSlots = new Set(
    Array.from({ length: attachmentPaths.length }, (_, index) =>
      Math.floor((index * messageCount) / attachmentPaths.length)
    )
  )
  let attachmentIndex = 0
  const messages = Array.from({ length: messageCount }, (_, index) => {
    const role = index % 2 === 0 ? 'user' : 'assistant'
    const message = {
      role,
      content: `Deterministic benchmark message ${String(index + 1).padStart(3, '0')} ${'memory fixture '.repeat(8)}`
    }
    if (attachmentSlots.has(index) && attachmentIndex < attachmentPaths.length) {
      const filePath = attachmentPaths[attachmentIndex]
      message.attachments = [
        {
          type: 'image',
          url: filePath,
          mimeType: 'image/png',
          fileName: path.basename(filePath),
          sourceWidth: 512,
          sourceHeight: 512
        }
      ]
      attachmentIndex += 1
    }
    return message
  })
  return {
    id: SESSION_ID,
    storageKey: `${SCOPE}\u0000${SESSION_ID}`,
    storageScope: SCOPE,
    title: `${messageCount} messages / ${attachmentPaths.length} local images`,
    profileId: 'default',
    createdAt: 1700000000000,
    messages
  }
}

async function createFixture(root) {
  const userDataDir = path.join(root, 'user-data')
  const attachmentDir = path.join(userDataDir, '.chat_media', 'benchmark')
  await fs.mkdir(attachmentDir, { recursive: true })
  await fs.writeFile(
    path.join(userDataDir, 'config.json'),
    JSON.stringify(
      {
        use_remote_comfyui: true,
        use_remote_llm: true,
        local_llm_server_config: { enable_server: false },
        chat_config: { enable: false },
        mcp_config: { client: { servers: [] }, server: { enabled: false } }
      },
      null,
      2
    )
  )
  const attachmentPaths = []
  for (let index = 0; index < ATTACHMENT_COUNT; index += 1) {
    const filePath = path.join(attachmentDir, `fixture-${String(index).padStart(3, '0')}.png`)
    await fs.writeFile(filePath, createDeterministicPng(index))
    attachmentPaths.push(filePath)
  }
  const session = buildFixtureSession(attachmentPaths)
  await fs.writeFile(path.join(root, 'fixture-session.json'), JSON.stringify(session, null, 2))
  return { userDataDir, attachmentDir, session }
}

async function seedRendererStorage(page, session) {
  await page.evaluate(
    async ({ dbName, dbVersion, storeName, fixture, projectId, paneId, scope, sessionId }) => {
      localStorage.setItem(`agent.workspace.${projectId}`, JSON.stringify([{ id: paneId, enabled: true }]))
      localStorage.setItem(`agent.workspace.active.${projectId}`, paneId)
      localStorage.setItem(`chat.currentSessionId.${scope}`, sessionId)
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion)
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: 'storageKey' })
        }
        request.onerror = () => reject(request.error)
        request.onsuccess = () => {
          const db = request.result
          const transaction = db.transaction(storeName, 'readwrite')
          transaction.objectStore(storeName).put(fixture)
          transaction.oncomplete = () => {
            db.close()
            resolve(undefined)
          }
          transaction.onerror = () => reject(transaction.error)
        }
      })
    },
    {
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      storeName: STORE_NAME,
      fixture: session,
      projectId: PROJECT_ID,
      paneId: PANE_ID,
      scope: SCOPE,
      sessionId: SESSION_ID
    }
  )
}

async function collectMemory(app, page) {
  const processMetrics = await app.evaluate(({ app }) =>
    app.getAppMetrics().map((metric) => ({
      pid: metric.pid,
      type: metric.type,
      memory: metric.memory
    }))
  )
  const rendererProcesses = processMetrics.filter((metric) => metric.type === 'Tab')
  const pageMetrics = await page.evaluate(() => {
    const images = [...document.images]
    const viewportImages = images.filter((image) => {
      const rect = image.getBoundingClientRect()
      return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
    })
    const blobRuntime = window.__magicpotChatImageMemoryBlobCounters
    const memory = performance.memory
    return {
      dom: {
        imageCount: images.length,
        completeImageCount: images.filter((image) => image.complete).length,
        decodedImageCount: images.filter((image) => image.complete && image.naturalWidth > 0).length,
        viewportImageCount: viewportImages.length,
        localMediaImageCount: images.filter((image) => image.currentSrc.startsWith('local-media://')).length,
        blobImageCount: images.filter((image) => image.currentSrc.startsWith('blob:')).length,
        dataImageCount: images.filter((image) => image.currentSrc.startsWith('data:')).length
      },
      blobUrls: blobRuntime || null,
      javascriptHeap: memory
        ? {
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            jsHeapSizeLimit: memory.jsHeapSizeLimit
          }
        : null
    }
  })
  return { rendererProcesses, allProcesses: processMetrics, page: pageMetrics }
}

async function readWindowPlacement(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const primary = screen.getPrimaryDisplay()
    return {
      bounds: window.getBounds(),
      displays: screen.getAllDisplays().map((display) => ({ id: display.id, workArea: display.workArea })),
      focusable: window.isFocusable(),
      focused: window.isFocused(),
      visible: window.isVisible(),
      skipTaskbar: window.isSkipTaskbar?.() ?? window[Symbol.for('magicpot.testWindowRuntime.skipTaskbar')] ?? null,
      primaryDisplayId: primary.id,
      primaryWorkArea: primary.workArea
    }
  })
}

function printHelp() {
  console.log(`Chat image renderer-memory benchmark\n\nUsage:\n  node scripts/chat/chatImageMemoryBenchmark.mjs [--help|--dry-run]\n\nEnvironment:\n  MAGICPOT_CHAT_MEMORY_MESSAGE_COUNT       default ${DEFAULT_MESSAGE_COUNT}\n  MAGICPOT_CHAT_MEMORY_ATTACHMENT_COUNT    default ${DEFAULT_ATTACHMENT_COUNT}\n  MAGICPOT_CHAT_MEMORY_SETTLE_MS            default 5000\n  MAGICPOT_TEST_RUN_ID                      stable artifact run id\n\nRequires a built Electron app (npm run build:pure).`)
}

async function main() {
  if (process.argv.includes('--help')) return printHelp()
  const artifactRoot = resolveProjectCanvasArtifactRoot(RUN_ID)
  await fs.mkdir(artifactRoot, { recursive: true })
  const fixtureRoot = path.join(artifactRoot, 'fixture')
  const fixture = await createFixture(fixtureRoot)
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ artifactRoot, fixtureRoot, messageCount: MESSAGE_COUNT, attachmentCount: ATTACHMENT_COUNT }, null, 2))
    return
  }

  let appHandle
  try {
    const { _electron: electron } = await import('playwright')
    appHandle = await electron.launch({
      args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
      cwd: process.cwd(),
      env: { ...process.env, MAGICPOT_USER_DATA_DIR: fixture.userDataDir, ...WINDOW_ENV },
      timeout: 90000
    })
    await appHandle.context().addInitScript(() => {
      const active = new Set()
      let created = 0
      let revoked = 0
      const originalCreate = URL.createObjectURL.bind(URL)
      const originalRevoke = URL.revokeObjectURL.bind(URL)
      URL.createObjectURL = (object) => {
        const url = originalCreate(object)
        created += 1
        active.add(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        revoked += 1
        active.delete(String(url))
        return originalRevoke(url)
      }
      Object.defineProperty(window, '__magicpotChatImageMemoryBlobCounters', {
        get: () => ({ created, revoked, active: active.size }),
        configurable: false
      })
    })
    const page = await appHandle.firstWindow({ timeout: 90000 })
    await page.waitForSelector('#root', { timeout: 120000 })
    await seedRendererStorage(page, fixture.session)
    await page.evaluate((hash) => { window.location.hash = hash }, `#/canvas?id=${PROJECT_ID}`)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-chat-scroll-container="true"]', { timeout: 120000 })
    await page.waitForFunction(
      (expected) => document.querySelectorAll('img').length >= expected,
      ATTACHMENT_COUNT,
      { timeout: 120000 }
    )
    await page.waitForTimeout(parseCount('MAGICPOT_CHAT_MEMORY_SETTLE_MS', 5000))
    const placement = await readWindowPlacement(appHandle)
    assertNonIntrusiveWindowPlacement(placement, 'Chat image memory benchmark window')
    const metrics = await collectMemory(appHandle, page)
    const report = {
      benchmark: 'phase-1-chat-image-memory',
      runId: RUN_ID,
      capturedAt: new Date().toISOString(),
      fixture: {
        userDataDir: fixture.userDataDir,
        attachmentDir: fixture.attachmentDir,
        messageCount: MESSAGE_COUNT,
        attachmentCount: ATTACHMENT_COUNT,
        imageDimensions: { width: 512, height: 512 },
        deterministic: true
      },
      placement,
      metrics
    }
    const reportPath = path.join(artifactRoot, 'chat-image-memory-report.json')
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    console.log(`Report: ${reportPath}`)
  } finally {
    await appHandle?.close().catch(() => undefined)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
