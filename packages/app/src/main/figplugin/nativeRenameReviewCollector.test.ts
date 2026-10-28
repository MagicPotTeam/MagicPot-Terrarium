import path from 'node:path'
import { createContext, Script } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { createNativeRenameReview } from './nativeRenameReview'

type Capture = { ok: true; snapshot: unknown } | { ok: false; error: { code: string } }
type Readers = {
  createFigmaReader(input: unknown): { capture(): Capture }
  createPhotoshopReader(input: unknown): { capture(): Capture }
}
// New collector-to-review composition only; native API-shaped objects below are
// owned fixtures. This is NOT a native Figma/Photoshop process or UI test.
const helperPath = path.resolve('packages/figplugin-hosts/shared/selection-snapshot.js')
// The project setup mocks fs for other suites. Read this one named source via
// the real API; no user document or broader directory is read.
const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
const helper = fs.readFileSync(helperPath, 'utf8')
const setup = (host: 'figma' | 'photoshop') => {
  const prohibited: string[] = []
  const protect = <T extends object>(object: T): T =>
    new Proxy(object, {
      get: (target, key) => {
        if (!Object.hasOwn(target, key)) {
          prohibited.push(String(key))
          throw new Error('Non-metadata read')
        }
        return Reflect.get(target, key)
      },
      set: () => {
        prohibited.push('write')
        throw new Error('Unexpected write')
      }
    })
  const document = protect({ id: 10, activeLayers: [] as object[] })
  const root = protect({ id: '0:0', type: 'DOCUMENT' })
  const page = protect({
    id: '0:1',
    type: 'PAGE',
    name: 'Owned page',
    parent: root,
    selection: [] as object[]
  })
  const raw = {
    id: host === 'figma' ? '2:1' : 21,
    name: '原始 e\u0301 😀',
    type: 'FRAME',
    kind: 'pixel',
    visible: true,
    locked: false,
    allLocked: false,
    pixelsLocked: false,
    positionLocked: false,
    transparentPixelsLocked: false,
    isBackgroundLayer: false,
    parent: host === 'figma' ? page : null,
    document
  }
  const node = protect(raw)
  page.selection.push(node)
  document.activeLayers.push(node)
  const global = Object.create(null)
  for (const key of ['fetch', 'require', 'localStorage', 'WebSocket']) {
    Object.defineProperty(global, key, {
      get: () => {
        prohibited.push(key)
        throw new Error('Forbidden global')
      }
    })
  }
  const context = createContext(global, { codeGeneration: { strings: false, wasm: false } })
  new Script(helper, { filename: helperPath }).runInContext(context, { timeout: 1000 })
  const api = context.MagicPotSelectionSnapshotV1 as Readers
  const instanceEpoch = 'f'.repeat(32)
  const reader =
    host === 'figma'
      ? api.createFigmaReader({ figma: protect({ root, currentPage: page }), instanceEpoch })
      : api.createPhotoshopReader({
          app: protect({ activeDocument: document, documents: [document] }),
          instanceEpoch
        })
  const proposal = {
    domain: 'figplugin-native-rename',
    version: 1,
    purpose: 'native-rename-proposal',
    host,
    plan: {
      schemaVersion: 1,
      mode: 'plan-only',
      selectionRevision: 'owned-local-observation',
      steps: [{ command: 'node.rename', targetId: String(raw.id), name: 'Reviewed only' }]
    }
  }
  const review = () => {
    const capture = reader.capture()
    expect(capture.ok).toBe(true)
    if (!capture.ok) throw new Error(capture.error.code)
    return createNativeRenameReview(
      proposal,
      JSON.stringify(capture.snapshot),
      'owned-local-observation'
    )
  }
  return { review, raw, prohibited }
}

describe('actual shared collector source to native rename review, owned VM fixtures only', () => {
  for (const host of ['figma', 'photoshop'] as const) {
    it(`${host}: preserves exact names and detects fresh lock without writing or networking`, () => {
      const f = setup(host)
      const before = f.raw.name
      const result = f.review()
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.code)
      expect(result.review.rows[0]).toMatchObject({ oldName: before, newName: 'Reviewed only' })
      expect(result.review.writeAvailable).toBe(false)
      if (host === 'figma') f.raw.locked = true
      else f.raw.positionLocked = true
      expect(f.review()).toEqual({ ok: false, code: 'LOCKED_TARGET' })
      expect(f.raw.name).toBe(before)
      expect(f.prohibited).toEqual([])
    })

    it(`${host}: re-capture hashes a changed name; old review remains detached and non-authoritative`, () => {
      const f = setup(host),
        first = f.review()
      f.raw.name = 'User edit after capture'
      const second = f.review()
      if (!first.ok || !second.ok) throw new Error('fixture')
      expect(first.review.rows[0].oldName).toBe('原始 e\u0301 😀')
      expect(second.review.rows[0].oldName).toBe(f.raw.name)
      expect(first.review.snapshotSha256).not.toBe(second.review.snapshotSha256)
      expect(second.review.document.openEpochSource).toBe('plugin-observation')
      expect(second.review.evidence).toBe('unverified-host-metadata')
      expect(second.review.writeAvailable).toBe(false)
      expect(f.prohibited).toEqual([])
    })
  }
})
