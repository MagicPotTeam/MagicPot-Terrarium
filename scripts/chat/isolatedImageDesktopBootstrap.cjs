'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Electron MAIN must be loaded synchronously before app ready. */

// Test-only entry wrapper. Importing this file does not load Electron or start the app.
const fs = require('node:fs')
const path = require('node:path')
const { syncBuiltinESMExports } = require('node:module')
const { urlToHttpOptions } = require('node:url')

const STATE_KEY = '__MAGICPOT_IMAGE_DESKTOP__'
const SESSION_GUARD = Symbol('isolated-image-desktop-session')

function invariant(ok, message) {
  if (!ok) throw new Error(message)
}
function samePath(a, b) {
  const normalize = (value) =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(a) === normalize(b)
}
function inside(root, value) {
  const relative = path.relative(path.resolve(root), path.resolve(value))
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  )
}
function validateMockOrigin(value) {
  invariant(
    typeof value === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]+\/?$/.test(value),
    'A literal IPv4 loopback HTTP mock is required.'
  )
  const parsed = new URL(value)
  invariant(
    parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1',
    'A literal IPv4 loopback HTTP mock is required.'
  )
  invariant(
    Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535,
    'An explicit unprivileged mock port is required.'
  )
  invariant(
    !parsed.username &&
      !parsed.password &&
      parsed.pathname === '/' &&
      !parsed.search &&
      !parsed.hash,
    'Only the mock origin may be configured.'
  )
  return parsed.origin
}
function blockedError() {
  return Object.assign(new Error('Isolated desktop outbound operation blocked.'), {
    code: 'ISOLATED_DESKTOP_OUTBOUND_BLOCKED'
  })
}
function createPolicy(mockOrigin, state) {
  const allowedOrigin = validateMockOrigin(mockOrigin)
  const mockPort = new URL(allowedOrigin).port
  function record(transport, value) {
    let origin = 'unparsed'
    try {
      const parsed = new URL(String(value))
      origin = parsed.origin !== 'null' ? parsed.origin : parsed.protocol
    } catch {
      // An unparseable target is deliberately never copied into diagnostics.
    }
    state.blockedRequestCount += 1
    if (state.blockedRequests.length < 64) {
      state.blockedRequests.push({ transport, origin: origin.slice(0, 160) })
    }
  }
  function allows(value, allowLocal) {
    try {
      const parsed = new URL(String(value))
      if (parsed.username || parsed.password) return false
      if (allowLocal && ['file:', 'data:', 'blob:', 'local-media:'].includes(parsed.protocol))
        return true
      return parsed.origin === allowedOrigin && parsed.protocol === 'http:'
    } catch {
      return false
    }
  }
  function assertUrl(value, transport, allowLocal = false) {
    if (allows(value, allowLocal)) return
    record(transport, value)
    throw blockedError()
  }
  function assertSocket(args) {
    // Node normalizes connect arguments into an array carrying a private symbol.
    const values = Array.isArray(args[0]) ? args[0] : args
    let options
    if (values[0] && typeof values[0] === 'object') options = values[0]
    else if (
      typeof values[0] === 'number' ||
      (typeof values[0] === 'string' && /^\d+$/.test(values[0]))
    ) {
      options = { port: values[0], host: typeof values[1] === 'string' ? values[1] : 'localhost' }
    } else options = { path: values[0] }
    const host = options.host ?? options.hostname ?? 'localhost'
    if (!options.path && host === '127.0.0.1' && String(options.port) === mockPort) return
    record('node:socket', 'tcp://' + String(host) + ':' + String(options.port ?? ''))
    throw blockedError()
  }
  return { allows, assertUrl, assertSocket, record }
}
function httpRequestUrl(args, defaultProtocol) {
  const first = args[0]
  let base
  let options = {}
  if (typeof first === 'string' || first instanceof URL) {
    base = new URL(first)
    options = {
      ...urlToHttpOptions(base),
      ...(args[1] && typeof args[1] === 'object' ? args[1] : {})
    }
  } else if (first && typeof first === 'object') {
    options = first
  } else throw blockedError()
  if (options.socketPath || options.auth || base?.username || base?.password) throw blockedError()
  const protocol = options.protocol ?? defaultProtocol
  const host = options.hostname || options.host || 'localhost'
  const port = options.port ?? ''
  // Only the exact mock host is admitted later, so ambiguous host/port options fail closed.
  if (
    typeof host !== 'string' ||
    ['/', '\\', '?', '#', '@'].some((character) => host.includes(character))
  )
    throw blockedError()
  return protocol + '//' + host + (port ? ':' + String(port) : '') + '/'
}
function requestValue(input) {
  if (typeof input === 'string' || input instanceof URL) return input
  return input?.url
}
function installNodeNetworkGuards(policy, dependencies) {
  const { globals, http, https, net, tls } = dependencies
  if (typeof globals.fetch === 'function') {
    const original = globals.fetch
    globals.fetch = async function (input, init) {
      policy.assertUrl(requestValue(input), 'node:fetch', true)
      return original.call(this, input, init)
    }
  }
  for (const [transport, module, protocol] of [
    ['node:http', http, 'http:'],
    ['node:https', https, 'https:']
  ]) {
    for (const method of ['request', 'get']) {
      const original = module[method]
      module[method] = function (...args) {
        let target
        try {
          target = httpRequestUrl(args, protocol)
        } catch {
          policy.record(transport, undefined)
          throw blockedError()
        }
        policy.assertUrl(target, transport)
        return original.apply(this, args)
      }
    }
  }
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (...args) {
    policy.assertSocket(args)
    return connect.apply(this, args)
  }
  tls.connect = function () {
    policy.record('node:tls', 'tls:')
    throw blockedError()
  }
}
function matchesFilter(filter, url) {
  if (!filter || !Array.isArray(filter.urls)) return true
  return filter.urls.some((pattern) => {
    if (pattern === '<all_urls>') return true
    if (typeof pattern !== 'string') return false
    const expression = pattern
      .split('*')
      .map((part) => part.replace(/[.+?^$(){}|[\]\\]/g, '\\$&'))
      .join('.*')
    return new RegExp('^' + expression + '$').test(url)
  })
}
function installSessionGuard(session, policy) {
  if (session[SESSION_GUARD]) return
  const webRequest = session.webRequest
  const nativeRegister = webRequest.onBeforeRequest.bind(webRequest)
  let productFilter
  let productListener
  const guardedListener = (details, callback) => {
    if (!policy.allows(details.url, true)) {
      policy.record('electron:session', details.url)
      callback({ cancel: true })
      return
    }
    if (typeof productListener !== 'function' || !matchesFilter(productFilter, details.url)) {
      callback({ cancel: false })
      return
    }
    let completed = false
    const finish = (decision) => {
      if (completed) return
      completed = true
      if (decision?.redirectURL && !policy.allows(decision.redirectURL, true)) {
        policy.record('electron:redirect', decision.redirectURL)
        callback({ cancel: true })
      } else callback(decision ?? { cancel: false })
    }
    try {
      productListener(details, finish)
    } catch {
      finish({ cancel: true })
    }
  }
  const register = (...args) => {
    productFilter = args.length > 1 ? args[0] : undefined
    productListener = args.length > 1 ? args[1] : args[0]
    invariant(
      productListener === null || typeof productListener === 'function',
      'Unexpected Electron request listener.'
    )
    nativeRegister({ urls: ['<all_urls>'] }, guardedListener)
  }
  Object.defineProperty(webRequest, 'onBeforeRequest', {
    value: register,
    writable: false,
    configurable: false
  })
  Object.defineProperty(session, SESSION_GUARD, { value: true })
  nativeRegister({ urls: ['<all_urls>'] }, guardedListener)
}
function installElectronNetworkGuards(electron, policy) {
  const originalFetch = electron.net.fetch
  const originalRequest = electron.net.request
  electron.net.fetch = async function (input, init) {
    policy.assertUrl(requestValue(input), 'electron:fetch', true)
    return originalFetch.call(this, input, init)
  }
  electron.net.request = function (input) {
    const target =
      typeof input === 'string' || input instanceof URL
        ? input
        : (input?.url ?? httpRequestUrl([input], 'http:'))
    policy.assertUrl(target, 'electron:request')
    return originalRequest.call(this, input)
  }
  electron.app.on('session-created', (session) => installSessionGuard(session, policy))
  // Registered before product MAIN. Its later default-session listener is composed above.
  electron.app.once('ready', () => installSessionGuard(electron.session.defaultSession, policy))
}
function validateRunFiles({ runRoot, mainEntry, workerPath }) {
  for (const value of [runRoot, mainEntry, workerPath])
    invariant(
      typeof value === 'string' && path.isAbsolute(value),
      'Absolute private runtime paths are required.'
    )
  invariant(fs.statSync(runRoot).isDirectory(), 'The private run root must already exist.')
  invariant(samePath(fs.realpathSync(runRoot), runRoot), 'The private run root must be canonical.')
  for (const file of [mainEntry, workerPath]) {
    invariant(
      inside(runRoot, file) && fs.statSync(file).isFile(),
      'Runtime files must be inside the private run root.'
    )
    invariant(
      inside(runRoot, fs.realpathSync(file)),
      'Runtime files must not resolve outside the private run root.'
    )
  }
  invariant(
    samePath(process.cwd(), path.join(runRoot, 'cwd')),
    'The private cwd must be selected before startup.'
  )
}
function configurePaths(app, runRoot) {
  const storageRoot = path.join(runRoot, 'storage')
  const data = path.join(storageRoot, 'Data')
  const paths = {
    home: path.join(runRoot, 'home'),
    appData: path.join(runRoot, 'home', 'AppData', 'Roaming'),
    userData: data,
    sessionData: path.join(data, 'sessionData'),
    logs: path.join(data, 'logs'),
    crashDumps: path.join(data, 'crashDumps'),
    temp: path.join(data, 'runtime', 'temp'),
    downloads: path.join(runRoot, 'downloads'),
    desktop: path.join(runRoot, 'desktop'),
    documents: path.join(runRoot, 'documents')
  }
  for (const [name, target] of Object.entries(paths)) {
    fs.mkdirSync(target, { recursive: true })
    invariant(
      inside(runRoot, fs.realpathSync(target)),
      'An Electron path escaped the private root.'
    )
    app.setPath(name, target)
    invariant(samePath(app.getPath(name), target), 'An Electron path override was not applied.')
  }
  process.env.TEMP = paths.temp
  process.env.TMP = paths.temp
  process.env.TMPDIR = paths.temp
  return {
    ...paths,
    storageRoot,
    projects: path.join(storageRoot, 'Projects'),
    autoSave: path.join(storageRoot, 'AutoSave')
  }
}
function validateEnvironment(runRoot) {
  const env = process.env
  invariant(
    ['offscreen', 'secondary-or-offscreen', 'hidden', 'secondary-display'].includes(
      env.MAGICPOT_TEST_UI_MODE
    ),
    'An explicit automated window mode is required.'
  )
  invariant(
    env.MAGICPOT_TEST_AUTOMATED_RUN === '1' && env.MAGICPOT_TEST_NO_FOCUS === '1',
    'Automated no-focus startup is required.'
  )
  invariant(
    typeof env.MAGICPOT_TEST_DESKTOP_PATH === 'string' &&
      path.isAbsolute(env.MAGICPOT_TEST_DESKTOP_PATH),
    'A private virtual desktop is required.'
  )
  invariant(
    /^[A-Za-z0-9_-]+$/.test(env.MAGICPOT_TEST_RUN_ID ?? ''),
    'A fixed synthetic run id is required.'
  )
  const expectedRoot = path.join(
    env.MAGICPOT_TEST_DESKTOP_PATH,
    '.magicpot-trash',
    'MagicPot',
    env.MAGICPOT_TEST_RUN_ID
  )
  invariant(
    samePath(expectedRoot, runRoot),
    'The runtime root must match the automation policy root.'
  )
  invariant(
    samePath(env.MAGICPOT_STORAGE_ROOT ?? '', path.join(runRoot, 'storage')),
    'The synthetic storage root must be explicit.'
  )
  invariant(!env.MAGICPOT_USER_DATA_DIR, 'The legacy user-data override must be absent.')
  invariant(
    !env.MAGICPOT_TEST_ARTIFACT_ROOT || samePath(env.MAGICPOT_TEST_ARTIFACT_ROOT, runRoot),
    'The artifact override must match this run.'
  )
  for (const name of [
    'ELECTRON_RENDERER_URL',
    'MAGICPOT_LAUNCHER_ROOT',
    'MAGICPOT_LAUNCH_TOKEN',
    'MAGICPOT_APPROVAL_SMOKE',
    'MAGICPOT_MCP_STDIO_SERVER',
    'NODE_OPTIONS'
  ]) {
    invariant(!env[name] || env[name] === '0', 'Unexpected inherited startup environment.')
  }
}
function validateSyntheticConfig(runRoot, mockOrigin) {
  const filename = path.join(runRoot, 'storage', 'Data', 'config.json')
  invariant(
    inside(runRoot, fs.realpathSync(filename)),
    'Synthetic configuration must stay inside the private root.'
  )
  invariant(fs.statSync(filename).size <= 1024 * 1024, 'Synthetic configuration is too large.')
  const config = JSON.parse(fs.readFileSync(filename, 'utf8'))
  invariant(config.use_remote_llm === false, 'Remote LLM routing must be disabled.')
  invariant(
    config.local_llm_server_config?.enable_server === false &&
      config.magic_agent_sdk_server_config?.enable_server === false,
    'Unneeded servers must be disabled.'
  )
  invariant(
    config.mcp_config?.server?.enabled === false &&
      Array.isArray(config.mcp_config?.client?.servers) &&
      config.mcp_config.client.servers.length === 0,
    'MCP transports must be disabled.'
  )
  invariant(
    config.figma_config?.auto_check_updates === false &&
      !config.figma_config?.personal_access_token,
    'Figma background updates must be disabled.'
  )
  invariant(
    Array.isArray(config.comfy_batch_profiles) && config.comfy_batch_profiles.length > 0,
    'A disabled valid Comfy profile is required.'
  )
  for (const profile of config.comfy_batch_profiles) {
    invariant(
      profile.enabled === false && profile.id && new URL(profile.baseUrl).origin === mockOrigin,
      'Comfy profiles must be disabled and synthetic.'
    )
  }
  invariant(
    config.use_remote_comfyui === true &&
      new URL(config.remote_comfyui_config?.comfyui_origin).origin === mockOrigin,
    'Any incidental Comfy URL must stay on the mock origin.'
  )
  const profiles = config.llm_config?.api_profiles
  invariant(
    Array.isArray(profiles) &&
      profiles.length === 1 &&
      profiles[0].provider === 'openai' &&
      profiles[0].api_mode === 'responses' &&
      new URL(profiles[0].base_url).origin === mockOrigin,
    'Only one synthetic Responses profile is permitted.'
  )
}
function startIsolatedImageDesktop(options) {
  invariant(!globalThis[STATE_KEY], 'This process already owns an isolated image desktop.')
  const { runRoot, mainEntry, workerPath } = options
  const mockOrigin = validateMockOrigin(options.mockOrigin)
  validateRunFiles(options)
  validateEnvironment(runRoot)
  validateSyntheticConfig(runRoot, mockOrigin)
  const electron = require('electron')
  invariant(
    electron.app && !electron.app.isReady() && !electron.app.isPackaged,
    'Start with an unpackaged Electron before app ready.'
  )
  const expectedData = path.join(runRoot, 'storage', 'Data')
  invariant(
    samePath(electron.app.commandLine.getSwitchValue('user-data-dir') || '', expectedData),
    'The pre-JS user-data-dir switch must point at synthetic Data.'
  )
  const state = {
    runRoot,
    mockOrigin,
    paths: {},
    blockedRequestCount: 0,
    blockedRequests: [],
    renderProcessGone: [],
    pathErrors: [],
    mainImported: false
  }
  Object.defineProperty(globalThis, STATE_KEY, {
    value: state,
    writable: false,
    configurable: false
  })
  state.paths = configurePaths(electron.app, runRoot)
  process.env.MAGICPOT_CANVAS_THUMBNAIL_SIDECAR_PATH = workerPath
  const policy = createPolicy(mockOrigin, state)
  installNodeNetworkGuards(policy, {
    globals: globalThis,
    http: require('node:http'),
    https: require('node:https'),
    net: require('node:net'),
    tls: require('node:tls')
  })
  installElectronNetworkGuards(electron, policy)
  syncBuiltinESMExports()
  electron.app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_event, details) => {
      if (state.renderProcessGone.length < 32)
        state.renderProcessGone.push({
          webContentsId: contents.id,
          reason: String(details.reason).slice(0, 60),
          exitCode: details.exitCode
        })
    })
  })
  const verifyPaths = () => {
    for (const name of [
      'home',
      'appData',
      'userData',
      'sessionData',
      'logs',
      'crashDumps',
      'temp',
      'downloads',
      'desktop',
      'documents'
    ]) {
      if (!samePath(electron.app.getPath(name), state.paths[name])) {
        state.pathErrors.push(name)
        throw new Error('An Electron path changed outside the isolated startup contract.')
      }
    }
  }
  electron.app.once('ready', verifyPaths)
  // Synchronous CJS load is intentional: scheme registration must precede Electron ready.
  require(mainEntry)
  state.mainImported = true
  verifyPaths()
  return state
}

module.exports = {
  startIsolatedImageDesktop,
  __test: {
    validateMockOrigin,
    createPolicy,
    httpRequestUrl,
    installNodeNetworkGuards,
    installSessionGuard
  }
}
