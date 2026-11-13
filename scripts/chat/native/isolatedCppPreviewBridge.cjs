'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Private Electron/preload entry points are synchronous CJS. */

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const { createHash } = require('node:crypto')
const { crc32 } = require('node:zlib')
const { performance } = require('node:perf_hooks')

const CHANNEL = 'magicpot-isolated-cpp-preview-v1'
const STATS_KEY = '__MAGICPOT_CPP_PREVIEW_STATS__'
const PREFIX = 'data:image/png;base64,'
const MAX_INPUT = 20 * 1024 * 1024
const MAX_OUTPUT = 2 * 1024 * 1024
const MAX_STDERR = 8 * 1024
const MAX_PIXELS = 40_000_000
const MAX_EDGE = 512
const TIMEOUT_MS = 15_000
const MAX_RECORDS = 64
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function failure(code) {
  return Object.assign(new Error('Isolated C++ preview rejected: ' + code + '.'), {
    code: 'ISOLATED_CPP_PREVIEW_' + code,
    previewCode: code
  })
}
function check(value, code) {
  if (!value) throw failure(code)
}
function normalized(value) {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
function samePath(a, b) {
  return normalized(a) === normalized(b)
}
function inside(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith('..' + path.sep) &&
    !path.isAbsolute(relative)
  )
}
function privatePath(root, target, directory = false) {
  check(
    typeof target === 'string' && path.isAbsolute(target) && inside(root, target),
    'PRIVATE_PATH'
  )
  let current = root
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    check(!stat.isSymbolicLink(), 'PRIVATE_PATH')
    if (!samePath(current, target)) check(stat.isDirectory(), 'PRIVATE_PATH')
  }
  const stat = fs.lstatSync(target, { bigint: true })
  check(directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1n, 'PRIVATE_PATH')
  check(inside(root, fs.realpathSync.native(target)), 'PRIVATE_PATH')
  return stat
}
function sameFile(a, b) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((key) => a[key] === b[key])
}

// Container and CRC validation only; no full-size image is decoded in MAIN.
function inspectPng(bytes, maxEdge, maxPixels) {
  check(
    Buffer.isBuffer(bytes) && bytes.length >= 45 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
    'PNG'
  )
  let width = 0,
    height = 0,
    color = -1,
    sawData = false,
    sawPalette = false,
    sawEnd = false
  for (let offset = 8, chunks = 0; offset < bytes.length;) {
    check(++chunks <= 4096 && bytes.length - offset >= 12, 'PNG')
    const length = bytes.readUInt32BE(offset)
    check(length <= bytes.length - offset - 12, 'PNG')
    const kind = bytes.toString('ascii', offset + 4, offset + 8)
    const end = offset + 8 + length
    check(
      /^[A-Za-z]{4}$/.test(kind) &&
        crc32(bytes.subarray(offset + 4, end)) === bytes.readUInt32BE(end),
      'PNG'
    )
    if (offset === 8) {
      check(kind === 'IHDR' && length === 13, 'PNG')
      width = bytes.readUInt32BE(offset + 8)
      height = bytes.readUInt32BE(offset + 12)
      color = bytes[offset + 17]
      const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      check(
        depths[color]?.includes(bytes[offset + 16]) &&
          bytes[offset + 18] === 0 &&
          bytes[offset + 19] === 0 &&
          bytes[offset + 20] <= 1,
        'PNG'
      )
      check(
        width > 0 &&
          height > 0 &&
          width <= maxEdge &&
          height <= maxEdge &&
          width * height <= maxPixels,
        'DIMENSIONS'
      )
    } else check(kind !== 'IHDR', 'PNG')
    check(!['acTL', 'fcTL', 'fdAT'].includes(kind), 'ANIMATED_PNG')
    if (kind === 'PLTE') {
      check(!sawPalette && !sawData && length > 0 && length <= 768 && length % 3 === 0, 'PNG')
      sawPalette = true
    }
    if (kind === 'IDAT') sawData = true
    offset = end + 4
    if (kind === 'IEND') {
      check(
        length === 0 && offset === bytes.length && sawData && (color !== 3 || sawPalette),
        'PNG'
      )
      sawEnd = true
      break
    }
  }
  check(sawEnd, 'PNG')
  return { width, height }
}
function decodeInput(args) {
  check(
    args &&
      typeof args === 'object' &&
      !Array.isArray(args) &&
      Reflect.ownKeys(args).length === 1 &&
      Object.hasOwn(args, 'dataUrl') &&
      typeof args.dataUrl === 'string',
    'INPUT'
  )
  const value = args.dataUrl
  check(
    value.startsWith(PREFIX) && value.length <= PREFIX.length + Math.ceil(MAX_INPUT / 3) * 4,
    'INPUT'
  )
  const encoded = value.slice(PREFIX.length)
  check(
    encoded.length > 0 && encoded.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(encoded),
    'BASE64'
  )
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const firstPadding = encoded.indexOf('=')
  check(firstPadding === -1 || firstPadding === encoded.length - padding, 'BASE64')
  if (padding === 2) check((BASE64.indexOf(encoded[encoded.length - 3]) & 15) === 0, 'BASE64')
  if (padding === 1) check((BASE64.indexOf(encoded[encoded.length - 2]) & 3) === 0, 'BASE64')
  const size = (encoded.length / 4) * 3 - padding
  check(size > 0 && size <= MAX_INPUT, 'INPUT_LIMIT')
  const bytes = Buffer.from(encoded, 'base64')
  check(bytes.length === size, 'BASE64')
  return { bytes, inputBytes: size, ...inspectPng(bytes, MAX_PIXELS, MAX_PIXELS) }
}
function readDiagnostic(bytes, input) {
  const text = bytes.toString('utf8').trim()
  check(text.length > 0 && !/[\r\n]/.test(text), 'WORKER_DIAGNOSTIC')
  const value = JSON.parse(text)
  check(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.ok === 'boolean' &&
      value.max_edge === MAX_EDGE &&
      value.memory_unit === 'bytes' &&
      typeof value.memory_available === 'boolean',
    'WORKER_DIAGNOSTIC'
  )
  for (const key of [
    'input_bytes',
    'input_width',
    'input_height',
    'output_bytes',
    'output_width',
    'output_height',
    'peak_working_set_bytes',
    'peak_commit_bytes',
    'end_private_bytes'
  ]) {
    check(Number.isSafeInteger(value[key]) && value[key] >= 0, 'WORKER_DIAGNOSTIC')
  }
  check(
    Number.isFinite(value.elapsed_ms) &&
      value.elapsed_ms >= 0 &&
      value.input_bytes === input.inputBytes &&
      value.input_width === input.width &&
      value.input_height === input.height,
    'WORKER_DIAGNOSTIC'
  )
  return value
}

/** Importing this module does not import Electron, register IPC, or spawn a worker. */
async function installIsolatedCppPreviewBridge({ runRoot, workerPath, workerSha256, enabled }) {
  check(typeof enabled === 'boolean' && !globalThis[STATS_KEY], 'INSTALL')
  check(
    typeof runRoot === 'string' &&
      path.isAbsolute(runRoot) &&
      fs.statSync(runRoot).isDirectory() &&
      samePath(fs.realpathSync.native(runRoot), runRoot),
    'RUN_ROOT'
  )
  check(
    globalThis.__MAGICPOT_IMAGE_DESKTOP__ &&
      samePath(globalThis.__MAGICPOT_IMAGE_DESKTOP__.runRoot, runRoot),
    'BOOTSTRAP'
  )
  check(typeof workerSha256 === 'string' && /^[a-f0-9]{64}$/i.test(workerSha256), 'WORKER_HASH')
  const workerIdentity = privatePath(runRoot, workerPath)
  check(workerIdentity.size > 0n && workerIdentity.size <= 64n * 1024n * 1024n, 'WORKER_SIZE')
  check(
    createHash('sha256').update(fs.readFileSync(workerPath)).digest('hex') ===
      workerSha256.toLowerCase(),
    'WORKER_HASH'
  )
  const rendererEntry = path.join(runRoot, 'app', 'out', 'renderer', 'index.html')
  privatePath(runRoot, rendererEntry)
  const cwd = path.join(runRoot, 'cwd')
  privatePath(runRoot, cwd, true)
  const { app, BrowserWindow, ipcMain } = require('electron')
  check(!app.isPackaged && samePath(app.getAppPath(), path.join(runRoot, 'app')), 'APP_PATH')
  const env = {}
  for (const key of ['SystemRoot', 'WINDIR']) {
    const existing = Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === key.toLowerCase()
    )
    if (existing) env[key] = existing[1]
  }
  for (const [key, name] of [
    ['USERPROFILE', 'home'],
    ['APPDATA', 'appData'],
    ['LOCALAPPDATA', 'appData'],
    ['TEMP', 'temp'],
    ['TMP', 'temp'],
    ['TMPDIR', 'temp']
  ]) {
    env[key] = app.getPath(name)
    privatePath(runRoot, env[key], true)
  }
  const { spawn } = require('node:child_process')
  const state = {
    enabled,
    requests: 0,
    completed: 0,
    rejected: 0,
    inFlight: 0,
    closed: false,
    workers: []
  }
  const snapshot = () => ({
    ...state,
    count: state.requests,
    errors: state.rejected,
    workers: state.workers.map((record) => ({ ...record }))
  })
  let active
  let registered = false
  function authorize(event) {
    const sender = event?.sender
    const frame = event?.senderFrame
    check(
      sender &&
        frame &&
        !sender.isDestroyed() &&
        !frame.isDestroyed() &&
        frame === sender.mainFrame &&
        frame.parent === null,
      'SENDER'
    )
    const window = BrowserWindow.fromWebContents(sender)
    check(window && !window.isDestroyed() && window.webContents === sender, 'SENDER')
    for (const value of [sender.getURL(), frame.url]) {
      const url = new URL(value)
      check(
        url.protocol === 'file:' &&
          !url.hostname &&
          !url.search &&
          samePath(fileURLToPath(url), rendererEntry),
        'SENDER'
      )
    }
  }
  function execute(event, input) {
    const identity = privatePath(runRoot, workerPath)
    check(sameFile(identity, workerIdentity), 'WORKER_CHANGED')
    const record = {
      sequence: state.requests,
      pid: null,
      status: 'starting',
      elapsedMs: 0,
      inputBytes: input.inputBytes,
      outputBytes: 0,
      inputWidth: input.width,
      inputHeight: input.height,
      outputWidth: 0,
      outputHeight: 0,
      workerElapsedMs: null,
      memoryAvailable: false,
      peakWorkingSetBytes: null,
      peakCommitBytes: null,
      endPrivateBytes: null,
      errorCode: null
    }
    if (state.workers.length === MAX_RECORDS) state.workers.shift()
    state.workers.push(record)
    state.inFlight = 1
    const started = performance.now()
    return new Promise((resolve, reject) => {
      let child,
        timer,
        rejected = false,
        closed = false,
        errorCode,
        killed = false
      let stdoutSize = 0,
        stderrSize = 0
      const stdout = [],
        stderr = []
      const rejectOnce = (code) => {
        if (rejected) return
        rejected = true
        reject(failure(code))
      }
      const abort = (code) => {
        if (closed) return
        errorCode ||= code
        record.errorCode = errorCode
        record.status = 'terminating'
        clearTimeout(timer)
        rejectOnce(errorCode)
        if (!killed && child) {
          killed = true
          try {
            child.kill('SIGKILL')
          } catch {
            /* The owned child may have exited already. */
          }
        }
      }
      const onNavigation = (details, _url, _inPlace, legacyIsMainFrame) => {
        if ((details?.isMainFrame ?? legacyIsMainFrame) !== false) abort('SENDER_CHANGED')
      }
      const onSenderGone = () => abort('SENDER_GONE')
      const onStdout = (chunk) => {
        if (closed || errorCode) return
        if (!Buffer.isBuffer(chunk) || chunk.length > MAX_OUTPUT - stdoutSize)
          return abort('STDOUT_LIMIT')
        stdoutSize += chunk.length
        stdout.push(chunk)
      }
      const onStderr = (chunk) => {
        if (closed || stderrSize > MAX_STDERR) return
        if (!Buffer.isBuffer(chunk) || chunk.length > MAX_STDERR - stderrSize) {
          stderrSize = MAX_STDERR + 1
          return abort('STDERR_LIMIT')
        }
        stderrSize += chunk.length
        stderr.push(chunk)
      }
      const onChildError = () => abort('CHILD_ERROR')
      const onStdinError = () => abort('STDIN_ERROR')
      const onClose = (exitCode, signal) => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        event.sender.removeListener('did-start-navigation', onNavigation)
        event.sender.removeListener('render-process-gone', onSenderGone)
        event.sender.removeListener('destroyed', onSenderGone)
        child.stdout?.removeListener('data', onStdout)
        child.stderr?.removeListener('data', onStderr)
        child.stdin?.removeListener('error', onStdinError)
        child.removeListener('error', onChildError)
        if (active?.child === child) active = undefined
        state.inFlight = 0
        input.bytes = undefined
        record.elapsedMs = Number((performance.now() - started).toFixed(3))
        record.outputBytes = stdoutSize
        let result
        try {
          const diagnostic = readDiagnostic(
            Buffer.concat(stderr, Math.min(stderrSize, MAX_STDERR)),
            input
          )
          record.workerElapsedMs = diagnostic.elapsed_ms
          record.memoryAvailable = diagnostic.memory_available
          if (diagnostic.memory_available) {
            record.peakWorkingSetBytes = diagnostic.peak_working_set_bytes
            record.peakCommitBytes = diagnostic.peak_commit_bytes
            record.endPrivateBytes = diagnostic.end_private_bytes
          }
          check(
            !errorCode && exitCode === 0 && !signal && diagnostic.ok,
            errorCode || 'WORKER_EXIT'
          )
          const bytes = Buffer.concat(stdout, stdoutSize)
          const dimensions = inspectPng(bytes, MAX_EDGE, MAX_EDGE * MAX_EDGE)
          check(
            diagnostic.output_bytes === bytes.length &&
              diagnostic.output_width === dimensions.width &&
              diagnostic.output_height === dimensions.height,
            'OUTPUT_DIAGNOSTIC'
          )
          authorize(event)
          record.outputWidth = dimensions.width
          record.outputHeight = dimensions.height
          result = { dataUrl: PREFIX + bytes.toString('base64'), ...dimensions }
        } catch (error) {
          errorCode ||= typeof error?.previewCode === 'string' ? error.previewCode : 'WORKER_RESULT'
        } finally {
          stdout.length = 0
          stderr.length = 0
        }
        if (errorCode) {
          record.status = 'failed'
          record.errorCode = errorCode
          rejectOnce(errorCode)
        } else {
          record.status = 'completed'
          resolve(result)
        }
      }
      try {
        child = spawn(workerPath, ['--max-edge', String(MAX_EDGE)], {
          cwd,
          env: { ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true
        })
        active = { child, abort }
        record.pid = Number.isSafeInteger(child.pid) && child.pid > 0 ? child.pid : null
        record.status = 'running'
        child.on('error', onChildError)
        child.once('close', onClose)
        child.stdout?.on('data', onStdout)
        child.stderr?.on('data', onStderr)
        child.stdin?.on('error', onStdinError)
        event.sender.on('did-start-navigation', onNavigation)
        event.sender.once('render-process-gone', onSenderGone)
        event.sender.once('destroyed', onSenderGone)
        timer = setTimeout(() => abort('TIMEOUT'), TIMEOUT_MS)
        if (!child.stdin || !child.stdout || !child.stderr) return abort('CHILD_STREAMS')
        child.stdin.end(input.bytes, (error) => {
          input.bytes = undefined
          if (error) abort('STDIN_ERROR')
        })
      } catch {
        input.bytes = undefined
        if (child) abort('SPAWN_IO')
        else {
          clearTimeout(timer)
          state.inFlight = 0
          record.status = 'failed'
          record.errorCode = 'SPAWN'
          record.elapsedMs = Number((performance.now() - started).toFixed(3))
          rejectOnce('SPAWN')
        }
      }
    })
  }
  const handler = async (event, args) => {
    state.requests++
    try {
      check(enabled && !state.closed, 'DISABLED')
      authorize(event)
      check(!active && state.inFlight === 0, 'BUSY')
      const input = decodeInput(args)
      args = undefined
      const result = await execute(event, input)
      state.completed++
      return result
    } catch (error) {
      state.rejected++
      throw failure(typeof error?.previewCode === 'string' ? error.previewCode : 'REQUEST')
    }
  }
  function dispose() {
    if (state.closed) return
    state.closed = true
    if (registered) {
      ipcMain.removeHandler(CHANNEL)
      registered = false
    }
    active?.abort('SHUTDOWN')
    app.removeListener('before-quit', dispose)
    process.removeListener('exit', dispose)
  }
  ipcMain.handle(CHANNEL, handler)
  registered = true
  Object.defineProperty(globalThis, STATS_KEY, {
    value: Object.freeze({
      get enabled() {
        return state.enabled
      },
      get count() {
        return state.requests
      },
      get errors() {
        return state.rejected
      },
      get inFlight() {
        return state.inFlight
      },
      snapshot
    }),
    configurable: false,
    writable: false
  })
  app.once('before-quit', dispose)
  process.once('exit', dispose)
  return { snapshot, dispose }
}

function createIsolatedCppPreviewPreloadSource({ enabled }) {
  check(typeof enabled === 'boolean', 'ENABLED')
  return (
    '\n;(() => {\n' +
    '  const { contextBridge, ipcRenderer } = require("electron");\n' +
    '  contextBridge.exposeInMainWorld("__MAGICPOT_CPP_PREVIEW__", Object.freeze({\n' +
    '    enabled: ' +
    String(enabled) +
    ',\n' +
    '    request: args => ipcRenderer.invoke("' +
    CHANNEL +
    '", args)\n' +
    '  }));\n' +
    '})();\n'
  )
}

module.exports = { installIsolatedCppPreviewBridge, createIsolatedCppPreviewPreloadSource }
