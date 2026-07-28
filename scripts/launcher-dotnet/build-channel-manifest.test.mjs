import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installSafeDeleteTestDelegate, resetSafeDeleteTestHooks } from './test-safe-delete.mjs'
installSafeDeleteTestDelegate()
test.afterEach(resetSafeDeleteTestHooks)
const { BUILD_BUDGETS, __setArchiveLimitsForTest, __setArchiveSnapshotHookForTest, run } = await import('./build-channel-manifest.ts')

const table = new Uint32Array(256)
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
function crc32(bytes) { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const sha = (data) => createHash('sha256').update(Buffer.from(data)).digest('hex')
function zip(entries) {
  const locals = [], centrals = []; let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name), source = Buffer.from(entry.data ?? ''), data = entry.deflate ? deflateRawSync(source) : source, crc = entry.crc ?? crc32(source), compressedSize = entry.compressedSize ?? data.length, uncompressedSize = entry.uncompressedSize ?? source.length, method = entry.deflate ? 8 : 0, local = Buffer.alloc(30), central = Buffer.alloc(46)
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags ?? 0, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressedSize, 18); local.writeUInt32LE(uncompressedSize, 22); local.writeUInt16LE(name.length, 26)
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags ?? 0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressedSize, 20); central.writeUInt32LE(uncompressedSize, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(entry.attrs ?? 0x81a40000, 38); central.writeUInt32LE(offset, 42)
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length
  }
  const centralBytes = Buffer.concat(centrals), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBytes, end])
}
const commit = 'abcdef0123456789abcdef0123456789abcdef01'
function archive(kind, overrides = {}) {
  const payload = overrides.payload ?? (kind === 'app' ? [{ name: 'MagicPot.exe', data: 'app' }] : [{ name: 'python/python.exe', data: 'py' }, { name: 'ComfyUI/main.py', data: 'main' }])
  const files = overrides.files ?? payload.filter((x) => !x.name.endsWith('/')).map((x) => ({ path: x.name, size: Buffer.byteLength(x.data ?? ''), sha256: sha(x.data ?? '') }))
  const base = kind === 'app'
    ? { schema: 1, kind: 'magicpot-app', version: '1.2.3', buildId: '20250102-030405-abcdef0', commitSha: commit, platform: 'win32', arch: 'x64', runtimeId: overrides.runtimeId ?? 'runtime-1', entrypoint: 'MagicPot.exe', createdAt: '2025-01-02T03:04:05Z', files }
    : { schema: 1, kind: 'magicpot-runtime', runtimeId: overrides.runtimeId ?? 'runtime-1', platform: 'win32', arch: 'x64', createdAt: '2025-01-02T03:04:05Z', entrypoints: { python: 'python/python.exe', comfyui: 'ComfyUI/main.py' }, files }
  Object.assign(base, overrides.manifest)
  const forcedUnpackedSize = overrides.manifest && Object.hasOwn(overrides.manifest, 'unpackedSize')
  let text = ''
  for (let i = 0; i < 10; i++) { if (!forcedUnpackedSize) base.unpackedSize = Buffer.byteLength(text) + payload.reduce((n, x) => n + Buffer.byteLength(x.data ?? ''), 0); const next = JSON.stringify(base); if (next === text) break; text = next }
  if (!forcedUnpackedSize) base.unpackedSize = Buffer.byteLength(text) + payload.reduce((n, x) => n + Buffer.byteLength(x.data ?? ''), 0); text = JSON.stringify(base)
  return zip([{ name: 'manifest.json', data: text, ...(overrides.manifestEntry ?? {}) }, ...payload])
}
function fixture(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-builder-')), appZip = join(dir, 'app.zip'), runtimeZip = join(dir, 'runtime.zip'), descriptor = join(dir, 'descriptor.json'), sources = join(dir, 'sources.json'), output = join(dir, 'channel.json')
  writeFileSync(appZip, overrides.appBytes ?? archive('app', overrides.app ?? {})); writeFileSync(runtimeZip, overrides.runtimeBytes ?? archive('runtime', overrides.runtime ?? {}))
  writeFileSync(sources, JSON.stringify({ schema: 1, trustedSources: [{ origin: 'https://github.com', repoPathPrefix: '/owner/repo' }] }))
  writeFileSync(descriptor, overrides.descriptorText ?? JSON.stringify({ schema: 1, releaseNotesUrl: overrides.notes ?? 'https://github.com/owner/repo/releases/tag/v1.2.3', minimumLauncherVersion: '1.0.0', publishedAt: overrides.publishedAt ?? '2025-01-03T00:00:00Z', app: { archive: appZip, url: 'https://github.com/owner/repo/releases/download/v1.2.3/app.zip' }, runtime: { archive: runtimeZip, url: 'https://github.com/owner/repo/releases/download/v1.2.3/runtime.zip' } }))
  return { dir, appZip, runtimeZip, descriptor, sources, output }
}
async function build(f, extra = []) { return run(['--descriptor', f.descriptor, ...extra, '--output', f.output, '--channel', 'stable', '--generated-at', '2025-01-04T00:00:00Z', '--release-source-config', f.sources]) }

test('production build budgets have reviewed boundaries', () => { assert.deepEqual(BUILD_BUDGETS, { maxArchive: 8 * 1024 ** 3, maxSingleFile: 16 * 1024 ** 3, maxUnpacked: 64 * 1024 ** 3, maxRatio: 200, maxEntries: 100_000, deadlineMs: 30 * 60 * 1000 }) })
test('internal limits cannot exceed production budgets', () => { assert.throws(() => __setArchiveLimitsForTest({ maxEntries: BUILD_BUDGETS.maxEntries + 1 }), /tighten/); assert.throws(() => __setArchiveLimitsForTest({ deadlineMs: BUILD_BUDGETS.deadlineMs + 1 }), /tighten/); __setArchiveLimitsForTest() })
test('deadline expiring immediately before publish rejects without creating output', async () => { const f = fixture(); let clock = 0; __setArchiveLimitsForTest({ deadlineMs: 1, now: () => clock, beforePublishForTest: () => { clock = 1 } }); try { await assert.rejects(build(f), /deadline exceeded/); assert.equal(existsSync(f.output), false) } finally { __setArchiveLimitsForTest() } })
test('deadline crossed during atomic publish verification still completes successfully', async () => { const f = fixture(); let clock = 0, verificationCalls = 0; __setArchiveLimitsForTest({ deadlineMs: 1, now: () => clock, onPublishVerifyForTest: () => { verificationCalls++; clock = 1 } }); try { await build(f); assert.ok(verificationCalls >= 1); assert.equal(existsSync(f.output), true); const output = JSON.parse(readFileSync(f.output, 'utf8')); assert.equal(output.schema, 1); assert.equal(output.channel, 'stable'); assert.equal(output.releases.length, 1) } finally { __setArchiveLimitsForTest() } })
test('publish verification callback failure removes its own output', async () => { const f = fixture(); let calls = 0; __setArchiveLimitsForTest({ onPublishVerifyForTest: () => { if (++calls === 2) throw new Error('injected verify callback failure') } }); try { await assert.rejects(build(f), /injected verify callback failure/); assert.equal(existsSync(f.output), false) } finally { __setArchiveLimitsForTest() } })
test('deadline clock hook allows a normal build', async () => { const f = fixture(); __setArchiveLimitsForTest({ deadlineMs: 1, now: () => 0 }); try { await build(f); assert.equal(existsSync(f.output), true) } finally { __setArchiveLimitsForTest() } })
test('valid exact archive builds and reports full uncompressed sum', async () => { const f = fixture(); await build(f); const out = JSON.parse(readFileSync(f.output)); assert.equal(out.releases[0].artifacts.app.size, readFileSync(f.appZip).length); assert.match(out.releases[0].artifacts.app.sha256, /^[0-9a-f]{64}$/); assert.ok(out.releases[0].artifacts.app.unpackedSize > 3) })
test('is deterministic', async () => { const a = fixture(), b = fixture(); await build(a); await build(b); assert.equal(readFileSync(a.output, 'utf8'), readFileSync(b.output, 'utf8')) })
test('rejects same-size in-place archive modification after snapshot', async () => { const f = fixture(); __setArchiveSnapshotHookForTest((path) => { if (path === f.appZip) { const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes) } }); try { await assert.rejects(build(f), /changed/) } finally { __setArchiveSnapshotHookForTest() } })
test('rejects payload hash mismatch', async () => { const f = fixture({ app: { files: [{ path: 'MagicPot.exe', size: 3, sha256: '0'.repeat(64) }] } }); await assert.rejects(build(f), /hash or size/) })
test('rejects payload size mismatch', async () => { const f = fixture({ app: { files: [{ path: 'MagicPot.exe', size: 99, sha256: sha('app') }] } }); await assert.rejects(build(f), /schema|hash or size|safe ZIP/) })
test('rejects extra and missing payload entries', async (t) => { for (const [name, app] of [['extra', { payload: [{ name: 'MagicPot.exe', data: 'app' }, { name: 'extra.bin', data: 'x' }], files: [{ path: 'MagicPot.exe', size: 3, sha256: sha('app') }] }], ['missing', { payload: [{ name: 'MagicPot.exe', data: 'app' }], files: [{ path: 'MagicPot.exe', size: 3, sha256: sha('app') }, { path: 'missing.bin', size: 1, sha256: sha('x') }] }]]) await t.test(name, async () => { await assert.rejects(build(fixture({ app })), /exactly match|safe ZIP/) }) })
test('rejects manifest unpackedSize mismatch', async () => { const bytes = archive('app', { manifest: { unpackedSize: 1 } }); const f = fixture({ appBytes: bytes }); await assert.rejects(build(f), /unpackedSize/) })
for (const [label, name] of [['device', 'CON.txt'], ['ADS', 'x:y'], ['trailing', 'x.'], ['case collision', 'magicpot.EXE'], ['NFC collision', 'e\u0301.txt']]) test(`rejects ${label} path`, async () => { const payload = label.includes('collision') ? [{ name: 'MagicPot.exe', data: 'app' }, { name, data: 'x' }, ...(label === 'NFC collision' ? [{ name: 'é.txt', data: 'y' }] : [])] : [{ name, data: 'x' }]; await assert.rejects(build(fixture({ app: { payload } })), /unsafe path|duplicate|schema|safe ZIP/) })
test('rejects file-directory prefix conflict', async () => { const payload = [{ name: 'MagicPot.exe', data: 'app' }, { name: 'node', data: 'x' }, { name: 'node/child', data: 'y' }]; await assert.rejects(build(fixture({ app: { payload } })), /prefix conflict/) })
test('rejects CRC corruption', async () => { const f = fixture({ app: { manifestEntry: { crc: 1 } } }); await assert.rejects(build(f), /CRC|safe ZIP/) })
test('rejects symlink and encrypted entries', async (t) => { await t.test('symlink', async () => assert.rejects(build(fixture({ app: { manifestEntry: { attrs: 0xa1ff0000 } } })), /symlink or special/)); await t.test('encrypted', async () => assert.rejects(build(fixture({ app: { manifestEntry: { flags: 1 } } })), /encrypted|safe ZIP/)) })
test('rejects duplicate descriptor keys and unknown fields', async (t) => { await t.test('duplicate', async () => assert.rejects(build(fixture({ descriptorText: '{"schema":1,"schema":1}' })), /duplicate key|missing/)); await t.test('unknown', async () => { const f = fixture(); const d = JSON.parse(readFileSync(f.descriptor)); d.privateKey = 'no'; writeFileSync(f.descriptor, JSON.stringify(d)); await assert.rejects(build(f), /unknown fields/) }) })
test('rejects untrusted URL, existing output, and invalid zip', async (t) => { await t.test('URL', async () => assert.rejects(build(fixture({ notes: 'https://evil.example/x' })), /trusted/)); await t.test('output', async () => { const f = fixture(); writeFileSync(f.output, 'sentinel'); await assert.rejects(build(f), /already exists/); assert.equal(readFileSync(f.output, 'utf8'), 'sentinel') }); await t.test('zip', async () => { const f = fixture(); writeFileSync(f.appZip, 'not zip'); await assert.rejects(build(f), /safe ZIP/); assert.equal(existsSync(f.output), false) }) })
test('rejects entry count above the internal test limit', async () => { const payload = [{ name: 'MagicPot.exe', data: 'app' }, ...Array.from({ length: 10 }, (_, index) => ({ name: `x${index}`, data: 'x' }))]; const f = fixture({ app: { payload } }); __setArchiveLimitsForTest({ maxEntries: 10 }); try { await assert.rejects(build(f), /too many entries/) } finally { __setArchiveLimitsForTest() } })
test('rejects excessive central-directory compression ratio before inflate', async () => { const bomb = Buffer.alloc(2 * 1024 * 1024, 0); const payload = [{ name: 'MagicPot.exe', data: bomb, deflate: true }]; await assert.rejects(build(fixture({ app: { payload } })), /compression ratio/) })
test('payload metrics do not retain a buffer', async () => { const seen = []; const f = fixture({ app: { payload: [{ name: 'MagicPot.exe', data: Buffer.alloc(1024 * 1024, 7) }] } }); __setArchiveLimitsForTest({ onEntryMetrics: (label, metrics) => { if (label.includes('payload')) seen.push(metrics) } }); try { await build(f); assert.ok(seen.length >= 3); assert.ok(seen.every((metrics) => !Object.hasOwn(metrics, 'buffer'))) } finally { __setArchiveLimitsForTest() } })
test('rejects manifest larger than 2 MiB', async () => { const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x20); const f = fixture({ appBytes: zip([{ name: 'manifest.json', data: oversized }, { name: 'MagicPot.exe', data: 'app' }]) }); await assert.rejects(build(f), /manifest path or size/) })
