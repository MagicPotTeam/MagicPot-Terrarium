import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareCargoImageWorkerSource } from './cargo-image-worker-source.mjs'
import { publishImageWorkerBinary } from './build-image-worker.mjs'

vi.unmock('node:fs')

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magicpot-cargo-link-'))
  try {
    const release = path.join(root, 'release')
    fs.mkdirSync(path.join(release, 'deps'), { recursive: true })
    const source = path.join(release, 'canvas-thumbnail-sidecar.exe')
    const alias = path.join(release, 'deps', 'canvas_thumbnail_sidecar.exe')
    fs.writeFileSync(source, 'synthetic cargo executable bytes')
    run({ root, release, source, alias })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

describe('Cargo image worker publication source', () => {
  it('keeps the strict publisher rejection of hardlinked sources', () =>
    fixture(({ root, source, alias }) => {
      fs.linkSync(source, alias)
      expect(() => publishImageWorkerBinary(source, path.join(root, 'out.exe'), root)).toThrow(
        'single-link'
      )
    }))
  it('snapshots the exact Cargo two-link layout into one independent file then publishes unchanged bytes', () =>
    fixture(({ root, release, source, alias }) => {
      fs.linkSync(source, alias)
      const before = fs.readFileSync(source)
      const prepared = prepareCargoImageWorkerSource(source)
      try {
        expect(prepared.sourcePath).not.toBe(source)
        expect(fs.statSync(prepared.sourcePath).nlink).toBe(1)
        expect(fs.readFileSync(prepared.sourcePath)).toEqual(before)
        const output = path.join(root, 'published', 'worker.exe')
        publishImageWorkerBinary(prepared.sourcePath, output, path.dirname(output))
        expect(fs.statSync(output).nlink).toBe(1)
        expect(fs.readFileSync(output)).toEqual(before)
        fs.writeFileSync(output, 'changed independent output')
        expect(fs.readFileSync(source)).toEqual(before)
        expect(fs.readFileSync(alias)).toEqual(before)
      } finally {
        prepared.cleanup()
      }
      expect(fs.readdirSync(release).sort()).toEqual(['canvas-thumbnail-sidecar.exe', 'deps'])
    }))
  it('accepts an existing regular single-link artifact without mutating it', () =>
    fixture(({ source }) => {
      const prepared = prepareCargoImageWorkerSource(source)
      expect(prepared.sourcePath).toBe(source)
      prepared.cleanup()
      expect(fs.readFileSync(source, 'utf8')).toContain('synthetic cargo')
    }))
  it('refuses missing or unrelated aliases, extra links, and non-file sources', () =>
    fixture(({ root, source, alias }) => {
      const unknown = path.join(root, 'unknown.exe')
      fs.linkSync(source, unknown)
      expect(() => prepareCargoImageWorkerSource(source)).toThrow()
      fs.writeFileSync(alias, 'unrelated')
      expect(() => prepareCargoImageWorkerSource(source)).toThrow('identity mismatch')
      fs.unlinkSync(alias)
      fs.linkSync(source, alias)
      expect(() => prepareCargoImageWorkerSource(source)).toThrow('hard-link layout')
      fs.unlinkSync(unknown)
      fs.unlinkSync(source)
      fs.mkdirSync(source)
      expect(() => prepareCargoImageWorkerSource(source)).toThrow('regular file')
    }))
})
