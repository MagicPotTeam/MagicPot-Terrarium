import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getAgentSessionKey } from '@shared/agent'
import type { LLMChatReq } from '@shared/api/svcLLMProxy'
import { createThreadImageReviewLoader } from './agentThreadImageReview'
import * as store from '../llmProxy/managedMediaStore'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')
const dirs = vi.hoisted(() => ({ root: '' }))
vi.mock('../llmProxy/chatMediaDir', () => ({
  getChatMediaDir: () => dirs.root,
  resolveChatMediaNamespaceDir: (namespace: string, scope: string) =>
    path.join(dirs.root, namespace, scope)
}))
const route = {
  channel: 'canvas',
  scopeType: 'thread',
  scopeId: 'test-project',
  threadId: 'review'
} as const
const conversationId = 'test-chat'
const loader = (threadImageHistory: LLMChatReq['threadImageHistory'], assertLive = () => {}) =>
  createThreadImageReviewLoader({ route, conversationId, threadImageHistory, assertLive })
const tuple = (bytes: Buffer) => ({
  sha256: createHash('sha256').update(bytes).digest('hex'),
  mimeType: 'image/png',
  sizeBytes: bytes.length
})
const pixel = () =>
  sharp({
    create: { width: 12, height: 5, channels: 4, background: { r: 123, g: 0, b: 2, alpha: 0.4 } }
  })
async function publish(bytes: Buffer, id = conversationId, threadId = route.threadId as string) {
  const key = getAgentSessionKey({ ...route, threadId })
  const scope = createHash('sha256')
    .update(JSON.stringify([key, id]))
    .digest('hex')
  return store.importManagedMedia(
    path.join(dirs.root, 'user-output', scope),
    {
      bytes,
      mimeType: 'image/png',
      originalFileName: 'generated-1.png',
      provenance: { source: 'agent-thread-image-gen', conversationId: id }
    },
    { authorizedRoot: dirs.root }
  )
}
let temp: string
beforeEach(async () => {
  temp = await createNodeTestArtifactDir('thread-image-review')
  dirs.root = path.join(await fs.realpath(temp), '.chat_media')
  await fs.mkdir(dirs.root)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(temp, { recursive: true, force: true })
})

it('snapshots only the latest tuple and freshly encodes small alpha pixels without source metadata or enlargement', async () => {
  const bytes = await pixel()
    .withExif({ IFD0: { Artist: 'SECRET_ARTIST' } })
    .png()
    .toBuffer()
  expect((await sharp(bytes).metadata()).exif).toBeDefined()
  await publish(bytes)
  const entry = tuple(bytes),
    history = [entry, entry]
  Object.defineProperty(history, 1, {
    get: () => {
      throw new Error('Older candidate was inspected')
    }
  })
  const read = vi.spyOn(store, 'readManagedMediaBytes')
  const load = loader(history)
  expect(read).not.toHaveBeenCalled()
  entry.sha256 = '0'.repeat(64)
  const result = await load()
  const png = Buffer.from(result.url.slice('data:image/png;base64,'.length), 'base64')
  expect(result).toEqual({
    type: 'image',
    mimeType: 'image/png',
    url: `data:image/png;base64,${png.toString('base64')}`,
    sizeBytes: png.length
  })
  expect(read).toHaveBeenCalledOnce()
  expect(await sharp(png).metadata()).toMatchObject({
    format: 'png',
    width: 12,
    height: 5,
    hasAlpha: true
  })
  expect((await sharp(png).metadata()).exif).toBeUndefined()
  expect(await sharp(png).raw().toBuffer()).toEqual(await sharp(bytes).raw().toBuffer())
})

it('downsamples a >3.6 MiB synthetic RGBA PNG and fits a high-entropy preview under the byte ceiling', async () => {
  const raw = randomBytes(1280 * 1280 * 4)
  const bytes = await sharp(raw, { raw: { width: 1280, height: 1280, channels: 4 } })
    .png()
    .toBuffer()
  expect(bytes.length).toBeGreaterThan(3.6 * 1024 * 1024)
  await publish(bytes)
  const result = await loader([tuple(bytes)])()
  const png = Buffer.from(result.url.split(',')[1], 'base64')
  expect(result.sizeBytes).toBe(png.length)
  expect(png.length).toBeLessThanOrEqual(1536 * 1024)
  expect(await sharp(png).metadata()).toMatchObject({
    format: 'png',
    width: 512,
    height: 512,
    hasAlpha: true
  })
})

it.each([
  'null',
  'path',
  'oversize list',
  'missing',
  'foreign conversation',
  'foreign thread',
  'changed original',
  'bad MIME',
  'bad size'
] as const)('rejects %s without reading an older valid image', async (mode) => {
  const older = await pixel().png().toBuffer()
  await publish(older)
  const bytes = await pixel().negate().png().toBuffer()
  const ref = tuple(bytes)
  if (mode === 'foreign conversation') await publish(bytes, 'other')
  if (mode === 'foreign thread') await publish(bytes, conversationId, 'other')
  if (mode === 'changed original') {
    const original = await publish(bytes)
    await fs.writeFile(original.absolutePath, Buffer.alloc(bytes.length))
  }
  const first =
    mode === 'null'
      ? null
      : mode === 'path'
        ? { ...tuple(older), relativePath: 'other.png' }
        : mode === 'bad MIME'
          ? { ...tuple(older), mimeType: 'image/jpeg' }
          : mode === 'bad size'
            ? { ...tuple(older), sizeBytes: older.length + 1 }
            : ref
  const history = mode === 'oversize list' ? Array(6).fill(tuple(older)) : [first, tuple(older)]
  const resolve = vi.spyOn(store, 'resolveManagedMediaReference')
  await expect(loader(history)()).rejects.toThrow(/reattach/)
  expect(resolve.mock.calls.map(([, ref]) => ref)).not.toContainEqual(
    expect.objectContaining(tuple(older))
  )
})

it('treats accessor fields as unavailable without invoking them or inspecting older slots', async () => {
  const get = vi.fn(() => {
    throw new Error('Do not run getters')
  })
  const ref = Object.defineProperty(tuple(Buffer.alloc(1)), 'sha256', { get })
  await expect(loader([ref, null])()).rejects.toThrow(/reattach/)
  expect(get).not.toHaveBeenCalled()
})

it('refuses non-default EXIF orientation even when exact scoped bytes pass integrity', async () => {
  const bytes = await pixel().withMetadata({ orientation: 6 }).png().toBuffer()
  await publish(bytes)
  await expect(loader([tuple(bytes)])()).rejects.toThrow(/reattach/)
})

it.each(['cancel before read', 'revoke after read'] as const)(
  'honors %s without releasing a preview',
  async (mode) => {
    const bytes = await pixel().png().toBuffer()
    await publish(bytes)
    const abort = new AbortController(),
      reason = new Error('review revoked')
    let active = true
    const originalRead = store.readManagedMediaBytes
    const read = vi.spyOn(store, 'readManagedMediaBytes').mockImplementation(async (...args) => {
      const bytes = await originalRead(...args)
      active = false
      return bytes
    })
    const load = loader([tuple(bytes)], () => {
      if (!active) throw reason
    })
    if (mode === 'cancel before read') abort.abort(reason)
    await expect(load(abort.signal)).rejects.toBe(reason)
    expect(read).toHaveBeenCalledTimes(mode === 'cancel before read' ? 0 : 1)
  }
)
