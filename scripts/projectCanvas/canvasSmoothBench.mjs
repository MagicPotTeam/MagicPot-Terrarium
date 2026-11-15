// canvasSmoothBench.mjs - "as smooth and as memory-light as PureRef" measurement for the MagicPot project canvas.
//
// Self-contained: lives OUTSIDE the repository, drives the BUILT app the way scripts/projectCanvas/*Benchmark.mjs do
// (Playwright _electron, file input `project-canvas-import-input`, real-board benchmark runtime for local-media roots),
// and adds what those benchmarks do not record:
//   - presented-frame cadence from requestAnimationFrame timestamps (p50/p95/p99/max, frames over 25/33/50 ms) during
//     REAL input (CDP mouse wheel / middle-button drag), plus the app's own WebGL render rate;
//   - Long Animation Frames (PerformanceObserver 'long-animation-frame', with script attribution) and long tasks;
//   - WebGL call counters (draw calls, texture uploads + bytes, buffer uploads, live textures + estimated live bytes);
//   - React commits of the whole tree (a minimal __REACT_DEVTOOLS_GLOBAL_HOOK__ installed before React loads);
//   - per-process memory (Electron app.getAppMetrics: working set, Windows private bytes) at baseline / after import /
//     after deselect + GC, per image, optional Chromium memory-infra allocator totals (gpu, skia, cc, v8, ...);
//   - time to first item / first pixels / all items / complete board on import and on project reopen;
//   - an optional soak (N minutes of pan/zoom) with a least-squares memory slope (MB per minute) per process.
//
// Usage (repository checkout after `npm run build:pure`; PowerShell or bash):
//   node <this file>                         # defaults: MB_COUNTS=100 MB_SIZES=small, visible window
// Environment (all optional):
//   MP_REPO        repository root holding node_modules (playwright, electron). Default: current directory.
//   MB_APP_DIR     directory with package.json + out/ (the built app). Default: MP_REPO.
//   MB_OUT         output root. Default: <MP_REPO>/.magicpot-trash/canvas-smooth-bench/<run id>
//   MB_COUNTS      comma list of board sizes, e.g. 100,500,2000 (each size = fresh profile + fresh app launch)
//   MB_SIZES       comma list of synthetic image classes: small (MB_SMALL_PX, default 1024x768) and/or
//                  large (MB_LARGE_PX, default 4096x3072). Ignored when MB_IMAGE_DIR is set.
//   MB_IMAGE_DIR   real corpus directory (png/jpg/jpeg/webp); the first N files (sorted) are used, never repeated.
//   MB_GESTURE_MS  length of each measured gesture (default 4000)
//   MB_SETTLE_MS   measured settle window after each gesture (default 2500)
//   MB_SOAK_MIN    minutes of continuous pan/zoom after the gestures (default 0 = off); MB_SOAK_SAMPLE_S (default 30)
//   MB_REOPEN      1 = close, relaunch on the same profile, reopen the board and time it (default 1)
//   MB_WINDOW      visible (default; on the primary display, what the user sees) | offscreen | hidden | secondary-display
//   MB_WIDTH/MB_HEIGHT  window content size (default 1600 x 1000)
//   MB_DSF         force device scale factor (default: unset = the display's real DPR; this container uses 1)
//   MB_MEMORY_INFRA 1 = also take a Chromium memory-infra dump at each memory point (adds ~5 s per point)
//   MB_BATCH       files per setInputFiles batch (default 128, same as the official real-board profile)
//   MB_IMPORT_TIMEOUT_MS  (default 900000)
//   MB_EXTRA_ARGS  extra Electron switches, space separated
//   MB_BLOCK_NETWORK 1 = route the app's outbound HTTP(S) to a dead local proxy (isolated runs)
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'

const env = process.env
const REPO = path.resolve(env.MP_REPO || process.cwd())
const require = createRequire(path.join(REPO, 'package.json'))
const { _electron: electron } = require('playwright')
const ELECTRON_BIN = require('electron')
const APP_DIR = path.resolve(env.MB_APP_DIR || REPO)
const RUN_ID = `csb-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
const OUT = path.resolve(
  env.MB_OUT || path.join(REPO, '.magicpot-trash', 'canvas-smooth-bench', RUN_ID)
)
const CWD = path.resolve(env.MB_CWD || REPO)
const COUNTS = `${env.MB_COUNTS || '100'}`
  .split(',')
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => n > 0)
const SIZES = env.MB_IMAGE_DIR
  ? ['corpus']
  : `${env.MB_SIZES || 'small'}`
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
const PX = { small: `${env.MB_SMALL_PX || '1024x768'}`, large: `${env.MB_LARGE_PX || '4096x3072'}` }
const GESTURE_MS = Number(env.MB_GESTURE_MS || 4000)
const SETTLE_MS = Number(env.MB_SETTLE_MS || 2500)
const SOAK_MIN = Number(env.MB_SOAK_MIN || 0)
const SOAK_SAMPLE_S = Number(env.MB_SOAK_SAMPLE_S || 30)
const REOPEN = !/^(0|false|no)$/i.test(`${env.MB_REOPEN ?? '1'}`)
const WINDOW_MODE = `${env.MB_WINDOW || 'visible'}`
const WIDTH = Number(env.MB_WIDTH || 1600)
const HEIGHT = Number(env.MB_HEIGHT || 1000)
const MEMORY_INFRA = /^(1|true|yes)$/i.test(`${env.MB_MEMORY_INFRA || ''}`)
const BATCH = Number(env.MB_BATCH || 128)
const IDLE_READ_MS = Number(env.MB_IDLE_READ_MS || 320)
const IMPORT_TIMEOUT_MS = Number(env.MB_IMPORT_TIMEOUT_MS || 900_000)
const MB = 1024 * 1024
const STAGE = '[data-testid="project-canvas-stage-root"]'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)
const t0 = Date.now()
const log = (...a) =>
  console.log(`MB ${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(7)}s`, ...a)

// ------------------------------------------------------------------------------------------------ corpus
function crcTable() {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}
const CRC = crcTable()
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Unique RGB PNG per seed: gradient + seeded 32 px colour blocks + a seeded sparse speckle, PNG "Up" filter.
 *  Decoded size is what matters for the canvas (w*h*4 in RGBA); files stay small. */
function syntheticPng(w, h, seed) {
  const stride = w * 3 + 1
  const raw = Buffer.alloc(stride * h)
  const prev = Buffer.alloc(w * 3),
    row = Buffer.alloc(w * 3)
  let s = (seed * 2654435761) >>> 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const bx = x >> 5,
        by = y >> 5
      const block =
        (Math.imul(bx + 1, 73856093) ^
          Math.imul(by + 1, 19349663) ^
          Math.imul(seed + 1, 83492791)) >>>
        0
      s = (s ^ (s << 13)) >>> 0
      s = (s ^ (s >>> 17)) >>> 0
      s = (s ^ (s << 5)) >>> 0
      const speck = (s & 63) === 0 ? 96 : 0
      const p = x * 3
      row[p] = ((block & 0xff) + (x * 255) / w + speck) & 0xff
      row[p + 1] = (((block >>> 8) & 0xff) + (y * 255) / h) & 0xff
      row[p + 2] = (((block >>> 16) & 0xff) ^ speck) & 0xff
    }
    const o = y * stride
    raw[o] = 2 // PNG "Up" filter
    for (let i = 0; i < row.length; i++) raw[o + 1 + i] = (row[i] - prev[i]) & 0xff
    row.copy(prev)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}
async function corpusFiles(sizeClass, count) {
  if (sizeClass === 'corpus') {
    const dir = path.resolve(env.MB_IMAGE_DIR)
    const names = (await fs.readdir(dir)).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort()
    if (names.length < count)
      throw new Error(
        `MB_IMAGE_DIR has ${names.length} images, ${count} requested (no repeats: identical content may be deduplicated)`
      )
    // stage under the output root: the real-board benchmark runtime serves local-media only below MAGICPOT_TEST_ARTIFACT_ROOT
    const stage = path.join(OUT, 'corpus', 'real')
    await fs.mkdir(stage, { recursive: true })
    const out = []
    for (const n of names.slice(0, count)) {
      const t = path.join(stage, n)
      if (!fsSync.existsSync(t)) await fs.copyFile(path.join(dir, n), t)
      out.push(t)
    }
    return out
  }
  const [w, h] = PX[sizeClass].split('x').map(Number)
  const dir = path.join(OUT, 'corpus', `${sizeClass}-${w}x${h}`)
  await fs.mkdir(dir, { recursive: true })
  const out = []
  const started = Date.now()
  for (let i = 1; i <= count; i++) {
    const f = path.join(dir, `img-${String(i).padStart(5, '0')}.png`)
    if (!fsSync.existsSync(f)) await fs.writeFile(f, syntheticPng(w, h, i))
    out.push(f)
  }
  log(`corpus ${sizeClass} ${w}x${h} x${count} ready in ${Date.now() - started} ms`)
  return out
}

// ------------------------------------------------------------------------------------------------ in-page probe
// Installed with addInitScript and a reload, so the React hook and the WebGL patches exist before the app's code runs.
const PROBE = String.raw`(() => {
  if (window.__mb) return
  const mb = window.__mb = { commits: 0, rafTs: [], recording: false, loaf: [], longtasks: [], marks: {},
    gl: { draws: 0, texUploads: 0, texUploadBytes: 0, bufUploads: 0, bufUploadBytes: 0, texCreated: 0, texDeleted: 0, mipmaps: 0, liveTexBytes: 0, contexts: 0 } }
  if (!window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
    let id = 0
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { supportsFiber: true, renderers: new Map(), isDisabled: false,
      inject(r) { id += 1; this.renderers.set(id, r); return id }, checkDCE() {}, onScheduleFiberRoot() {},
      onCommitFiberRoot() { mb.commits += 1 }, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, setStrictMode() {} }
  }
  const g = mb.gl
  const live = new WeakMap()
  const state = new WeakMap()
  const st = (ctx) => { let s = state.get(ctx); if (!s) { s = { unit: 0, bound: new Map() }; state.set(ctx, s); g.contexts += 1 } return s }
  const setLive = (tex, bytes) => { if (!tex) return; const prev = live.get(tex) || 0; live.set(tex, bytes); g.liveTexBytes += bytes - prev }
  const srcSize = (src) => src ? [src.width || src.videoWidth || src.displayWidth || src.naturalWidth || 0, src.height || src.videoHeight || src.displayHeight || src.naturalHeight || 0] : [0, 0]
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue
    const P = C.prototype
    const wrap = (name, fn) => { const orig = P[name]; if (typeof orig !== 'function') return; P[name] = function (...a) { try { fn.call(this, a) } catch {} return orig.apply(this, a) } }
    for (const d of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) wrap(d, () => { g.draws += 1 })
    wrap('activeTexture', function (a) { st(this).unit = a[0] })
    wrap('bindTexture', function (a) { if (a[0] === 0x0de1) st(this).bound.set(st(this).unit, a[1]) })
    wrap('createTexture', () => { g.texCreated += 1 })
    wrap('deleteTexture', (a) => { g.texDeleted += 1; setLive(a[0], 0) })
    wrap('texImage2D', function (a) {
      const [w, h] = typeof a[3] === 'number' && a.length >= 8 ? [a[3], a[4]] : srcSize(a[5])
      const bytes = w * h * 4
      g.texUploads += 1; g.texUploadBytes += bytes
      if (a[0] === 0x0de1) { const tex = st(this).bound.get(st(this).unit); if (a[1] === 0) setLive(tex, bytes); else setLive(tex, (live.get(tex) || 0) + bytes) }
    })
    wrap('texSubImage2D', (a) => { const [w, h] = typeof a[4] === 'number' && a.length >= 8 ? [a[4], a[5]] : srcSize(a[6]); g.texUploads += 1; g.texUploadBytes += w * h * 4 })
    wrap('texStorage2D', function (a) { const tex = st(this).bound.get(st(this).unit); setLive(tex, a[3] * a[4] * 4 * (a[1] > 1 ? 4 / 3 : 1)) })
    wrap('generateMipmap', function (a) { g.mipmaps += 1; if (a[0] === 0x0de1) { const tex = st(this).bound.get(st(this).unit); setLive(tex, Math.round((live.get(tex) || 0) * 4 / 3)) } })
    wrap('bufferData', (a) => { g.bufUploads += 1; g.bufUploadBytes += typeof a[1] === 'number' ? a[1] : (a[1]?.byteLength || 0) })
    wrap('bufferSubData', (a) => { g.bufUploads += 1; g.bufUploadBytes += a[2]?.byteLength || 0 })
  }
  try {
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) {
        mb.loaf.push({ t: e.startTime, d: e.duration, block: e.blockingDuration, render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
          scripts: (e.scripts || []).sort((x, y) => y.duration - x.duration).slice(0, 3).map((s) => ({ d: Math.round(s.duration), fn: s.sourceFunctionName || '', src: (s.sourceURL || '').split('/').pop().slice(0, 60), inv: (s.invoker || '').slice(0, 60) })) })
        if (mb.loaf.length > 5000) mb.loaf.splice(0, 1000) } }).observe({ type: 'long-animation-frame', buffered: false })
      mb.loafSupported = true
    }
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) { mb.longtasks.push({ t: e.startTime, d: e.duration }); if (mb.longtasks.length > 5000) mb.longtasks.splice(0, 1000) } }).observe({ type: 'longtask', buffered: false })
    }
  } catch {}
  const tick = (ts) => { if (!mb.recording) { mb.looping = false; return } const l = mb.rafTs.length; if (!l || mb.rafTs[l - 1] !== ts) mb.rafTs.push(ts); requestAnimationFrame(tick) }
  const root = () => document.querySelector('[data-testid="project-canvas-stage-root"]')
  mb.ds = () => {
    const r = root(); if (!r) return null; const d = r.dataset; const n = (k) => Number(d[k] || 0)
    return { scale: Number(d.stageScale || 0), total: n('projectCanvasTotalImageItemCount'), visible: n('projectCanvasVisibleImageItemCount'),
      loaded: n('projectCanvasWebglLoadedImageCount'), pending: n('projectCanvasWebglPendingImageCount'), placeholder: n('projectCanvasWebglPlaceholderImageCount'),
      missing: n('projectCanvasWebglMissingImageCount'), failed: n('projectCanvasWebglFailedImageCount'), sprites: n('projectCanvasWebglSpriteCount'),
      resident: n('projectCanvasWebglResidentImageCount'), residentTexBytes: n('projectCanvasWebglResidentTextureBytes'),
      source: n('projectCanvasWebglUsingSourceImageCount'), preview: n('projectCanvasWebglUsingPreviewImageCount'),
      upgradePending: n('projectCanvasWebglSourceUpgradePendingImageCount'), renders: n('projectCanvasWebglRenderCount'),
      stageRenders: n('projectCanvasReactCommitCount'), fallback2d: n('projectCanvasCanvas2dFallbackImageCount'),
      c2dResolved: n('projectCanvasCanvas2dResolvedImageCount'), c2dFailed: n('projectCanvasCanvas2dFailedImageCount'), webglInit: d.projectCanvasWebglInitialized === 'true',
      webglUnavailable: n('projectCanvasWebglUnavailableFallbackImageCount'), highResDom: n('projectCanvasHighResDomImageCount'),
      snapshotChars: (d.projectCanvasMetricsSnapshot || '').length, stageAttrCount: r.attributes.length }
  }
  mb.counters = () => ({ t: performance.now(), commits: mb.commits, gl: { ...mb.gl }, ds: mb.ds(), dom: document.getElementsByTagName('*').length,
    heap: performance.memory ? performance.memory.usedJSHeapSize : null, visibility: document.visibilityState })
  mb.begin = (label) => { mb.cur = { label, start: mb.counters() }; mb.rafTs = []; mb.recording = true; if (!mb.looping) { mb.looping = true; requestAnimationFrame(tick) } }
  mb.end = () => {
    mb.recording = false
    const end = mb.counters(); const start = mb.cur.start
    const loaf = mb.loaf.filter((e) => e.t >= start.t && e.t <= end.t)
    const lt = mb.longtasks.filter((e) => e.t >= start.t && e.t <= end.t)
    return { label: mb.cur.label, start, end, rafTs: mb.rafTs.slice(), loaf, longtasks: lt }
  }
  // milestone poller for import / reopen timing (50 ms resolution, in-page clock)
  mb.watch = (expected) => {
    clearInterval(mb.watchTimer)
    const m = mb.milestones = { t0: performance.now(), expected, stableSince: null, samples: [] }
    mb.watchTimer = setInterval(() => {
      const d = mb.ds(); const now = performance.now() - m.t0
      if (!d) return
      if (m.samples.length < 4000 && (m.samples.length === 0 || now - m.samples[m.samples.length - 1].t >= 250)) m.samples.push({ t: Math.round(now), total: d.total, visible: d.visible, sprites: d.sprites, pending: d.pending, placeholder: d.placeholder, source: d.source, preview: d.preview })
      if (m.firstItem == null && d.total >= 1) m.firstItem = now
      // WebGL path: sprites drawn; Canvas2D fallback path (WebGL unavailable, e.g. software GL): images resolved by the 2D layer
      const painted = d.webglInit ? d.sprites >= 1 && d.loaded >= 1 : d.c2dResolved >= 1
      if (m.firstPixels == null && d.total >= 1 && painted) m.firstPixels = now
      if (m.allItems == null && d.total >= expected) m.allItems = now
      const drawn = d.webglInit ? d.sprites >= Math.min(d.visible, d.resident || d.visible) : d.c2dResolved + d.c2dFailed >= d.fallback2d && d.fallback2d > 0
      m.renderPath = d.webglInit ? 'webgl' : (d.fallback2d > 0 ? 'canvas2d-fallback' : 'unknown')
      const done = d.total >= expected && d.pending === 0 && d.placeholder === 0 && d.missing === 0 && drawn
      if (done) { if (m.stableSince == null) m.stableSince = now; if (m.complete == null && now - m.stableSince >= 500) m.complete = m.stableSince } else m.stableSince = null
      if (m.complete != null && m.sourceSettled == null && d.upgradePending === 0) m.sourceSettled = now
    }, 50)
  }
})()`

// ------------------------------------------------------------------------------------------------ stats
function pct(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]
}
function frameStats(ts) {
  const iv = []
  for (let i = 1; i < ts.length; i++) iv.push(ts[i] - ts[i - 1])
  const s = [...iv].sort((a, b) => a - b)
  const span = ts.length > 1 ? ts[ts.length - 1] - ts[0] : 0
  return {
    frames: ts.length,
    fps: span > 0 ? r1(((ts.length - 1) * 1000) / span) : null,
    p50: r1(pct(s, 50)),
    p95: r1(pct(s, 95)),
    p99: r1(pct(s, 99)),
    max: r1(s[s.length - 1] ?? null),
    over25: iv.filter((v) => v > 25).length,
    over33: iv.filter((v) => v > 33.4).length,
    over50: iv.filter((v) => v > 50).length,
    over100: iv.filter((v) => v > 100).length
  }
}
function windowSummary(w) {
  const ms = w.end.t - w.start.t
  const dg = Object.fromEntries(Object.keys(w.end.gl).map((k) => [k, w.end.gl[k] - w.start.gl[k]]))
  const frames = frameStats(w.rafTs)
  const loafTop = new Map()
  for (const e of w.loaf)
    for (const s of e.scripts) {
      const k = `${s.fn || '(anon)'} @ ${s.src} [${s.inv}]`
      loafTop.set(k, (loafTop.get(k) || 0) + s.d)
    }
  const ds0 = w.start.ds || {},
    ds1 = w.end.ds || {}
  return {
    ms: Math.round(ms),
    frames,
    appWebglRendersPerS: r1(((ds1.renders - ds0.renders) * 1000) / ms),
    reactCommits: w.end.commits - w.start.commits,
    stageSceneRenders: (ds1.stageRenders ?? 0) - (ds0.stageRenders ?? 0),
    loaf: {
      count: w.loaf.length,
      totalMs: Math.round(w.loaf.reduce((a, e) => a + e.d, 0)),
      blockingMs: Math.round(w.loaf.reduce((a, e) => a + (e.block || 0), 0)),
      maxMs: Math.round(Math.max(0, ...w.loaf.map((e) => e.d))),
      top: [...loafTop.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([k, v]) => `${v}ms ${k}`)
    },
    longTasks: {
      count: w.longtasks.length,
      totalMs: Math.round(w.longtasks.reduce((a, e) => a + e.d, 0)),
      maxMs: Math.round(Math.max(0, ...w.longtasks.map((e) => e.d)))
    },
    gl: {
      drawsPerFrame: frames.frames > 1 ? r1(dg.draws / (frames.frames - 1)) : null,
      draws: dg.draws,
      texUploads: dg.texUploads,
      texUploadMB: r1(dg.texUploadBytes / MB),
      bufUploads: dg.bufUploads,
      bufUploadKB: Math.round(dg.bufUploadBytes / 1024),
      texCreated: dg.texCreated,
      texDeleted: dg.texDeleted,
      mipmaps: dg.mipmaps,
      liveTexMBEnd: r1(w.end.gl.liveTexBytes / MB)
    },
    domNodesDelta: w.end.dom - w.start.dom,
    jsHeapDeltaMB: w.end.heap != null ? r1((w.end.heap - w.start.heap) / MB) : null,
    viewport: {
      scaleStart: r2(ds0.scale),
      scaleEnd: r2(ds1.scale),
      visibleEnd: ds1.visible,
      spritesEnd: ds1.sprites,
      sourceEnd: ds1.source,
      residentTexMBEnd: r1(ds1.residentTexBytes / MB),
      metricsSnapshotChars: ds1.snapshotChars,
      stageAttrCount: ds1.stageAttrCount
    },
    visibility: w.end.visibility
  }
}
function slope(points) {
  // least squares y = a + b x ; returns b and r2
  const n = points.length
  if (n < 3) return { perMin: null, r2: null }
  const mx = points.reduce((a, p) => a + p[0], 0) / n,
    my = points.reduce((a, p) => a + p[1], 0) / n
  let sxy = 0,
    sxx = 0,
    syy = 0
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my)
    sxx += (x - mx) ** 2
    syy += (y - my) ** 2
  }
  const b = sxx ? sxy / sxx : 0
  return { perMin: r2(b), r2: sxx && syy ? r2((sxy * sxy) / (sxx * syy)) : null }
}

// ------------------------------------------------------------------------------------------------ app control
function appEnv(runRoot, userData) {
  const e = {
    ...env,
    MAGICPOT_USER_DATA_DIR: userData,
    MAGICPOT_PROJECT_CANVAS_REAL_BOARD_BENCHMARK: '1',
    MAGICPOT_TEST_ARTIFACT_ROOT: OUT
  }
  delete e.NODE_OPTIONS
  delete e.ELECTRON_RUN_AS_NODE
  if (/^(1|true|yes)$/i.test(`${env.MB_BLOCK_NETWORK || ''}`))
    Object.assign(e, {
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      http_proxy: 'http://127.0.0.1:9',
      https_proxy: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
      NODE_USE_ENV_PROXY: '1'
    })
  for (const k of [
    'MAGICPOT_TEST_UI_MODE',
    'MAGICPOT_TEST_WINDOW_MODE',
    'MAGICPOT_TEST_NO_FOCUS',
    'MAGICPOT_TEST_AUTOMATED_RUN'
  ])
    delete e[k]
  if (WINDOW_MODE !== 'visible')
    Object.assign(e, {
      MAGICPOT_TEST_WINDOW_MODE: WINDOW_MODE,
      MAGICPOT_TEST_NO_FOCUS: '1',
      MAGICPOT_TEST_AUTOMATED_RUN: '1',
      MAGICPOT_TEST_RUN_ID: path.basename(runRoot)
    })
  return e
}
async function writeSmokeConfig(userData) {
  await fs.mkdir(userData, { recursive: true })
  const f = path.join(userData, 'config.json')
  if (fsSync.existsSync(f)) return
  await fs.writeFile(
    f,
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
}
async function launch(runRoot, userData) {
  await writeSmokeConfig(userData)
  const args = [
    APP_DIR,
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows'
  ]
  if (process.platform === 'linux') args.push('--no-sandbox')
  if (env.MB_DSF) args.push(`--force-device-scale-factor=${env.MB_DSF}`)
  if (/^(1|true|yes)$/i.test(`${env.MB_BLOCK_NETWORK || ''}`))
    args.push('--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>')
  if (env.MB_EXTRA_ARGS) args.push(...env.MB_EXTRA_ARGS.split(' ').filter(Boolean))
  const launchedAt = Date.now()
  const app = await electron.launch({
    executablePath: ELECTRON_BIN,
    args,
    cwd: CWD,
    env: appEnv(runRoot, userData),
    timeout: 120_000
  })
  const logStream = fsSync.createWriteStream(path.join(runRoot, `main-output-${Date.now()}.log`))
  app.process().stdout?.on('data', (c) => logStream.write(c))
  app.process().stderr?.on('data', (c) => logStream.write(c))
  const page = await app.firstWindow({ timeout: 120_000 })
  page.setDefaultTimeout(60_000)
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && errors.length < 200) errors.push(m.text().slice(0, 300))
  })
  await page.waitForFunction(
    () => Boolean(document.getElementById('root')?.childElementCount),
    undefined,
    { timeout: 120_000 }
  )
  const firstUiMs = Date.now() - launchedAt
  await app.context().addInitScript(PROBE)
  await page.reload()
  await page.waitForFunction(
    () => Boolean(window.__mb && document.getElementById('root')?.childElementCount),
    undefined,
    { timeout: 120_000 }
  )
  if (WINDOW_MODE === 'visible') {
    await app.evaluate(
      ({ BrowserWindow }, s) => {
        const w = BrowserWindow.getAllWindows()[0]
        if (w.isMaximized()) w.unmaximize()
        w.setPosition(0, 0)
        w.setContentSize(s.w, s.h)
        w.show()
      },
      { w: WIDTH, h: HEIGHT }
    )
  } else {
    await app.evaluate(
      ({ BrowserWindow }, s) => {
        BrowserWindow.getAllWindows()[0].setContentSize(s.w, s.h)
      },
      { w: WIDTH, h: HEIGHT }
    )
  }
  await page.waitForTimeout(800)
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable').catch(() => {})
  return { app, page, cdp, errors, firstUiMs, logStream }
}
async function openCanvas(page, canvasId) {
  await page.evaluate((h) => {
    window.location.hash = h
  }, `#/canvas?id=${canvasId}`)
  await page.waitForSelector(STAGE, { timeout: 120_000 })
  await page.waitForTimeout(600)
}
async function procMetrics(app) {
  return app.evaluate(({ app: a, BrowserWindow }) => {
    const rendererPid = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId()
    return a.getAppMetrics().map((m) => ({
      type: m.pid === rendererPid ? 'Renderer(canvas)' : m.type,
      pid: m.pid,
      name: m.name || m.serviceName || '',
      wsMB: Math.round(((m.memory?.workingSetSize || 0) / 1024) * 10) / 10,
      peakWsMB: Math.round(((m.memory?.peakWorkingSetSize || 0) / 1024) * 10) / 10,
      privateMB:
        m.memory?.privateBytes != null
          ? Math.round((m.memory.privateBytes / 1024) * 10) / 10
          : null,
      cpuPct: Math.round((m.cpu?.percentCPUUsage || 0) * 10) / 10
    }))
  })
}
function procTotals(list) {
  const pick = (t) => list.filter((p) => p.type === t)
  const sum = (arr, k) => r1(arr.reduce((a, p) => a + (p[k] ?? 0), 0))
  const rnd = pick('Renderer(canvas)'),
    gpu = pick('GPU'),
    all = list
  const k = list.some((p) => p.privateMB != null) ? 'privateMB' : 'wsMB'
  return {
    metric: k,
    renderer: sum(rnd, k),
    gpu: sum(gpu, k),
    browser: sum(pick('Browser'), k),
    utility: sum(pick('Utility'), k),
    all: sum(all, k),
    rendererWs: sum(rnd, 'wsMB'),
    gpuWs: sum(gpu, 'wsMB')
  }
}
async function memoryInfra(app, runRoot, name) {
  const file = path.join(runRoot, `${name}.memory-infra.json`)
  await app.evaluate(async ({ contentTracing }, f) => {
    await contentTracing.startRecording({
      included_categories: ['disabled-by-default-memory-infra'],
      excluded_categories: ['*'],
      memory_dump_config: { triggers: [{ mode: 'detailed', periodic_interval_ms: 1500 }] }
    })
    await new Promise((r) => setTimeout(r, 4000))
    await contentTracing.stopRecording(f)
  }, file)
  const trace = JSON.parse(await fs.readFile(file, 'utf8'))
  await fs.rm(file, { force: true })
  const events = (trace.traceEvents || trace).filter(
    (e) => e.ph === 'v' && e.args?.dumps?.allocators
  )
  const last = new Map()
  for (const e of events) last.set(e.pid, e)
  const out = {}
  for (const [pid, e] of last) {
    const top = {}
    for (const [n, v] of Object.entries(e.args.dumps.allocators)) {
      if (n.includes('/')) continue
      const s = v.attrs?.size?.value
      if (s !== undefined) top[n] = r1(parseInt(s, 16) / MB)
    }
    out[pid] = Object.fromEntries(
      Object.entries(top)
        .filter(([, v]) => v >= 1)
        .sort((a, b) => b[1] - a[1])
    )
  }
  return out
}
async function memoryPoint(h, runRoot, name, { gc = true } = {}) {
  if (gc) {
    await h.cdp.send('HeapProfiler.collectGarbage').catch(() => {})
    await h.page.waitForTimeout(1500)
  }
  const procs = await procMetrics(h.app)
  const perf = await h.cdp
    .send('Performance.getMetrics')
    .then((r) => Object.fromEntries(r.metrics.map((m) => [m.name, m.value])))
    .catch(() => ({}))
  const page = await h.page.evaluate(() => ({ ...window.__mb.counters(), objUrls: null }))
  const point = {
    name,
    t: Date.now(),
    totals: procTotals(procs),
    procs,
    jsHeapMB: r1((perf.JSHeapUsedSize || 0) / MB),
    domNodes: perf.Nodes,
    documents: perf.Documents,
    liveTexMB: r1(page.gl.liveTexBytes / MB),
    texCreated: page.gl.texCreated,
    texDeleted: page.gl.texDeleted,
    canvas: page.ds
  }
  if (MEMORY_INFRA)
    point.memoryInfra = await memoryInfra(h.app, runRoot, name).catch((e) => ({
      error: String(e.message)
    }))
  log(
    `mem ${name}: ${point.totals.metric} renderer ${point.totals.renderer} gpu ${point.totals.gpu} all ${point.totals.all} MB | jsHeap ${point.jsHeapMB} | liveTex ${point.liveTexMB} MB (${page.gl.texCreated - page.gl.texDeleted} tex) | app residentTex ${r1((page.ds?.residentTexBytes || 0) / MB)} MB, sprites ${page.ds?.sprites}, source ${page.ds?.source}`
  )
  return point
}

// ------------------------------------------------------------------------------------------------ gestures (real input via CDP)
async function stageBox(page) {
  const b = await page.locator(STAGE).first().boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }
}
async function paced(ms, fn) {
  const start = Date.now()
  let i = 0
  while (Date.now() - start < ms) {
    await fn(i)
    i++
    const next = start + i * 16
    const d = next - Date.now()
    if (d > 0) await sleep(d)
  }
  return i
}
async function measure(page, label, fn) {
  await page.evaluate((l) => window.__mb.begin(l), label)
  const started = Date.now()
  const inputs = await fn()
  const gestureMs = Date.now() - started
  const during = windowSummary(await page.evaluate(() => window.__mb.end()))
  await page.evaluate((l) => window.__mb.begin(l), label + ':settle')
  await page.waitForTimeout(SETTLE_MS)
  const settle = windowSummary(await page.evaluate(() => window.__mb.end()))
  const f = during.frames
  log(
    `gesture ${label.padEnd(16)} inputs ${inputs} | rAF ${f.fps} fps p50 ${f.p50} p95 ${f.p95} p99 ${f.p99} max ${f.max} ms >33ms ${f.over33} | webgl ${during.appWebglRendersPerS}/s draws/frame ${during.gl.drawsPerFrame} texUp ${during.gl.texUploads} (${during.gl.texUploadMB} MB) | commits ${during.reactCommits} (stage ${during.stageSceneRenders}) | LoAF ${during.loaf.count} ${during.loaf.totalMs} ms | settle: commits ${settle.reactCommits} texUp ${settle.gl.texUploads} LoAF ${settle.loaf.totalMs} ms | scale ${during.viewport.scaleStart}->${during.viewport.scaleEnd} visible ${during.viewport.visibleEnd}`
  )
  return { label, inputs, gestureMs, during, settle }
}
const wheel = (page, c, dy, ms) =>
  paced(ms, async () => {
    await page.mouse.wheel(0, dy)
  })
async function drag(page, c, ms, amp) {
  await page.mouse.move(c.x, c.y)
  await page.mouse.down({ button: 'middle' })
  let x = c.x,
    dir = 1
  const n = await paced(ms, async (i) => {
    x += dir * 12
    if (Math.abs(x - c.x) > amp) dir = -dir
    await page.mouse.move(x, c.y + Math.sin(i / 9) * amp * 0.25)
  })
  await page.mouse.move(c.x, c.y, { steps: 4 }) // end where it started: no net pan, the board does not drift away over a soak
  await page.mouse.up({ button: 'middle' })
  return n
}
async function zoomOutToOverview(page, c, maxMs) {
  const start = Date.now()
  let n = 0
  while (Date.now() - start < maxMs) {
    for (let k = 0; k < 6; k++) {
      await page.mouse.wheel(0, 120)
      n++
      await sleep(16)
    }
    // the stage publishes scale / visible counts only after the gesture idles (VIEWPORT_INTERACTION_IDLE_MS = 240,
    // useCanvasStageInteraction.ts:36), so pause briefly before reading them
    await sleep(IDLE_READ_MS)
    const d = await page.evaluate(() => window.__mb.ds())
    if (d && d.visible >= d.total) break
  }
  return n
}
async function runGestures(page) {
  const c = await stageBox(page)
  const amp = Math.min(c.w, c.h) * 0.3
  await page.mouse.move(c.x, c.y)
  const g = []
  g.push(
    await measure(page, 'idle', async () => {
      await page.waitForTimeout(2000)
      return 0
    })
  )
  g.push(
    await measure(page, 'zoom-out-to-all', () =>
      zoomOutToOverview(page, c, Math.max(GESTURE_MS, 8000))
    )
  )
  g.push(await measure(page, 'pan-overview', () => drag(page, c, GESTURE_MS, amp)))
  g.push(
    await measure(page, 'zoom-wobble', () =>
      paced(GESTURE_MS, async (i) => {
        await page.mouse.wheel(0, Math.floor(i / 12) % 2 ? 120 : -120)
      })
    )
  )
  g.push(
    await measure(page, 'zoom-in-near', async () => {
      let n = 0
      const s = Date.now()
      while (Date.now() - s < GESTURE_MS) {
        await page.mouse.wheel(0, -120)
        n++
        await sleep(16)
        if (n % 6 === 0) {
          await sleep(IDLE_READ_MS)
          const d = await page.evaluate(() => window.__mb.ds())
          if (d.scale >= 1) break
        }
      }
      return n
    })
  )
  g.push(await measure(page, 'pan-near', () => drag(page, c, GESTURE_MS, amp)))
  g.push(
    await measure(page, 'zoom-back-out', () =>
      zoomOutToOverview(page, c, Math.max(GESTURE_MS, 8000))
    )
  )
  return g
}

// ------------------------------------------------------------------------------------------------ import / reopen
async function waitMilestones(page, expected, timeoutMs, label) {
  const start = Date.now()
  let m = null
  while (Date.now() - start < timeoutMs) {
    m = await page.evaluate(() => {
      const x = window.__mb.milestones
      return x ? { ...x, samples: undefined } : null
    })
    if (m?.complete != null) break
    await page.waitForTimeout(500)
  }
  const full = await page.evaluate(() => window.__mb.milestones)
  const out = {
    firstItemMs: r1(full.firstItem),
    firstPixelsMs: r1(full.firstPixels),
    allItemsMs: r1(full.allItems),
    completeMs: r1(full.complete),
    sourceSettledMs: r1(full.sourceSettled),
    timedOut: full.complete == null,
    renderPath: full.renderPath || null,
    samples: full.samples
  }
  log(
    `${label}: first item ${out.firstItemMs} ms, first pixels ${out.firstPixelsMs} ms, all items ${out.allItemsMs} ms, complete ${out.completeMs} ms${out.timedOut ? ' (TIMED OUT)' : ''}`
  )
  return out
}
async function importFiles(page, files) {
  await page.evaluate((n) => window.__mb.watch(n), files.length)
  await page.evaluate(() => window.__mb.begin('import'))
  const started = Date.now()
  const input = page.locator('input[data-testid="project-canvas-import-input"]').first()
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH)
    await input.setInputFiles(batch, { timeout: 120_000 })
    await page.waitForFunction((n) => (window.__mb.ds()?.total || 0) >= n, i + batch.length, {
      timeout: IMPORT_TIMEOUT_MS,
      polling: 250
    })
    await input.setInputFiles([]).catch(() => {})
  }
  const inputMs = Date.now() - started
  const milestones = await waitMilestones(page, files.length, IMPORT_TIMEOUT_MS, 'import')
  const during = windowSummary(await page.evaluate(() => window.__mb.end()))
  log(
    `import responsiveness: rAF p95 ${during.frames.p95} max ${during.frames.max} ms, >100ms frames ${during.frames.over100}, LoAF ${during.loaf.count} (${during.loaf.blockingMs} ms blocking), longest ${during.loaf.maxMs} ms`
  )
  return { inputMs, ...milestones, responsiveness: during }
}

// ------------------------------------------------------------------------------------------------ one board
async function runBoard(sizeClass, count) {
  const label = `${sizeClass}-${count}`
  const runRoot = path.join(OUT, label)
  await fs.mkdir(runRoot, { recursive: true })
  const userData = path.join(runRoot, 'user-data')
  const canvasId = `csb-${label}`
  const result = {
    label,
    sizeClass,
    px: sizeClass === 'corpus' ? env.MB_IMAGE_DIR : PX[sizeClass],
    count,
    windowMode: WINDOW_MODE,
    platform: `${process.platform} ${os.release()}`,
    cpus: os.cpus().length,
    totalMemGB: r1(os.totalmem() / 1024 ** 3),
    startedAt: new Date().toISOString()
  }
  const files = await corpusFiles(sizeClass, count)
  result.corpusMB = r1(files.reduce((a, f) => a + fsSync.statSync(f).size, 0) / MB)
  let h = await launch(runRoot, userData)
  try {
    result.firstUiMs = h.firstUiMs
    result.display = await h.page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      inner: [innerWidth, innerHeight],
      screen: [screen.width, screen.height],
      visibility: document.visibilityState
    }))
    result.gpu = await h.app.evaluate(({ app }) => app.getGPUFeatureStatus()).catch(() => null)
    // probe a throw-away canvas; a null context (WebGL blocklisted, e.g. software GL) is itself a finding
    result.glRenderer = await h.page.evaluate(() => {
      try {
        const c = document.createElement('canvas')
        for (const kind of ['webgl2', 'webgl']) {
          const gl = c.getContext(kind)
          if (!gl) continue
          const e = gl.getExtension('WEBGL_debug_renderer_info')
          return `${kind}: ${e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`
        }
        return 'no WebGL context (probe canvas)'
      } catch (e) {
        return String(e)
      }
    })
    log(
      `board ${label}: corpus ${result.corpusMB} MB, window ${WINDOW_MODE} ${result.display.inner.join('x')} dpr ${result.display.dpr} visibility ${result.display.visibility}, GL ${result.glRenderer}`
    )
    await openCanvas(h.page, canvasId)
    await h.page.waitForTimeout(2000)
    result.memory = { baseline: await memoryPoint(h, runRoot, 'baseline') }
    result.import = await importFiles(h.page, files)
    result.memory.imported = await memoryPoint(h, runRoot, 'imported-selected', { gc: false })
    await h.page.keyboard.press('Escape') // imported images arrive selected; selected images get full-size source textures
    await h.page.waitForTimeout(5000)
    result.memory.settled = await memoryPoint(h, runRoot, 'settled-deselected')
    result.gestures = await runGestures(h.page)
    result.memory.afterGestures = await memoryPoint(h, runRoot, 'after-gestures')
    if (SOAK_MIN > 0) {
      const c = await stageBox(h.page)
      const amp = Math.min(c.w, c.h) * 0.3
      const points = []
      const soakStart = Date.now()
      let nextSample = 0
      let cycles = 0
      const frames = []
      while (Date.now() - soakStart < SOAK_MIN * 60_000) {
        if (Date.now() - soakStart >= nextSample) {
          const p = await memoryPoint(h, runRoot, `soak-${points.length}`)
          points.push({
            min: (Date.now() - soakStart) / 60_000,
            ...p.totals,
            jsHeapMB: p.jsHeapMB,
            liveTexMB: p.liveTexMB,
            domNodes: p.domNodes
          })
          nextSample += SOAK_SAMPLE_S * 1000
        }
        await h.page.evaluate(() => window.__mb.begin('soak'))
        await drag(h.page, c, 2500, amp)
        await wheel(h.page, c, -120, 700)
        await drag(h.page, c, 2500, amp)
        await wheel(h.page, c, 120, 700)
        frames.push(windowSummary(await h.page.evaluate(() => window.__mb.end())).frames)
        cycles++
      }
      const s = (k) => slope(points.map((p) => [p.min, p[k]]))
      result.soak = {
        minutes: SOAK_MIN,
        cycles,
        points,
        slopeMBPerMin: {
          renderer: s('renderer'),
          gpu: s('gpu'),
          all: s('all'),
          jsHeap: s('jsHeapMB'),
          liveTex: s('liveTexMB'),
          domNodes: s('domNodes')
        },
        frameP95: {
          first: frames[0]?.p95,
          last: frames[frames.length - 1]?.p95,
          worst: Math.max(...frames.map((f) => f.p95 || 0))
        }
      }
      log(
        `soak ${SOAK_MIN} min, ${cycles} cycles: slope MB/min renderer ${result.soak.slopeMBPerMin.renderer.perMin} gpu ${result.soak.slopeMBPerMin.gpu.perMin} jsHeap ${result.soak.slopeMBPerMin.jsHeap.perMin} liveTex ${result.soak.slopeMBPerMin.liveTex.perMin}`
      )
    }
    await h.page.screenshot({ path: path.join(runRoot, 'board.png') }).catch(() => {})
    if (REOPEN) {
      await h.page.waitForTimeout(Number(env.MB_SAVE_WAIT_MS || 10_000)) // let autosave finish
      await h.app.close()
      h.logStream.end()
      h = null
      h = await launch(runRoot, userData)
      await h.page.evaluate((n) => window.__mb.watch(n), count)
      const navAt = Date.now()
      await openCanvas(h.page, canvasId)
      const reopen = await waitMilestones(h.page, count, IMPORT_TIMEOUT_MS, 'reopen')
      result.reopen = { firstUiMs: h.firstUiMs, navToStageMs: Date.now() - navAt, ...reopen }
      await h.page.waitForTimeout(3000)
      result.memory.reopened = await memoryPoint(h, runRoot, 'reopened')
      await h.page.screenshot({ path: path.join(runRoot, 'reopened.png') }).catch(() => {})
    }
  } catch (error) {
    result.error = String(error?.stack || error).slice(0, 4000)
    log(`board ${label} FAILED: ${String(error?.message || error).slice(0, 400)}`)
    await h?.page.screenshot({ path: path.join(runRoot, 'error.png') }).catch(() => {})
  } finally {
    result.rendererErrors = h?.errors.slice(0, 50)
    await h?.app.close().catch(() => {})
    h?.logStream.end()
  }
  const m = result.memory || {}
  if (m.baseline && m.settled) {
    const per = (k) => r2((m.settled.totals[k] - m.baseline.totals[k]) / count)
    result.perImageMB = {
      metric: m.settled.totals.metric,
      renderer: per('renderer'),
      gpu: per('gpu'),
      all: per('all'),
      selectedAll: m.imported ? r2((m.imported.totals.all - m.baseline.totals.all) / count) : null,
      decodedRGBA_MB:
        sizeClass === 'corpus'
          ? null
          : r2((PX[sizeClass].split('x').reduce((a, b) => a * b) * 4) / MB)
    }
  }
  result.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(runRoot, 'result.json'), JSON.stringify(result, null, 1))
  log(`board ${label} done -> ${path.join(runRoot, 'result.json')}`)
  return result
}

function summaryRow(r) {
  const g = Object.fromEntries((r.gestures || []).map((x) => [x.label, x.during]))
  const f = (k) =>
    g[k] ? `${g[k].frames.p50}/${g[k].frames.p95}/${g[k].frames.p99}/${g[k].frames.max}` : '-'
  return `| ${r.label} | ${r.import?.firstPixelsMs ?? '-'} | ${r.import?.completeMs ?? '-'} | ${r.reopen?.firstPixelsMs ?? '-'} | ${r.reopen?.completeMs ?? '-'} | ${f('pan-overview')} | ${f('pan-near')} | ${f('zoom-wobble')} | ${r.perImageMB?.renderer ?? '-'} | ${r.perImageMB?.gpu ?? '-'} | ${r.perImageMB?.all ?? '-'} | ${r.soak ? `${r.soak.slopeMBPerMin.all.perMin}` : '-'} | ${r.error ? 'ERROR' : 'ok'} |`
}

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  log(
    `run ${RUN_ID} app ${APP_DIR} out ${OUT} counts ${COUNTS} sizes ${SIZES} window ${WINDOW_MODE}`
  )
  const results = []
  for (const sizeClass of SIZES)
    for (const count of COUNTS) results.push(await runBoard(sizeClass, count))
  const md = [
    '# canvasSmoothBench summary',
    '',
    `run ${RUN_ID}, ${new Date().toISOString()}, ${process.platform}, window ${WINDOW_MODE}; memory metric: ${results[0]?.perImageMB?.metric ?? 'n/a'}`,
    '',
    '| board | import first px ms | import complete ms | reopen first px ms | reopen complete ms | pan-overview rAF p50/p95/p99/max ms | pan-near | zoom-wobble | MB/img renderer | MB/img GPU | MB/img all | soak MB/min all | status |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map(summaryRow),
    ''
  ]
  await fs.writeFile(path.join(OUT, 'summary.md'), md.join('\n'))
  await fs.writeFile(
    path.join(OUT, 'summary.json'),
    JSON.stringify(
      results.map((r) => ({
        ...r,
        import: r.import && { ...r.import, samples: undefined },
        reopen: r.reopen && { ...r.reopen, samples: undefined }
      })),
      null,
      1
    )
  )
  console.log(md.join('\n'))
  if (results.some((r) => r.error)) process.exitCode = 1
}
await main()
