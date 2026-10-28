import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { createContext, Script } from 'node:vm'

const root = new URL('../packages/figplugin-hosts/', import.meta.url)
const read = (path) => readFileSync(new URL(path, root), 'utf8')
const figmaCode = read('figma/code.js')
const figmaHtml = read('figma/ui.html')
const photoshopCode = read('photoshop-uxp/main.js')
const photoshopHtml = read('photoshop-uxp/index.html')
const plain = (value) => JSON.parse(JSON.stringify(value))
const emptyContext = (host) => ({
  kind: 'selection-context',
  protocol: 1,
  host,
  nodes: [],
  truncated: false
})

// Fail even if plugin error handling catches an unexpected host read or write.
function guarded(target, label, violations, writable = []) {
  const forbidden = (key) => {
    const message = `${label}.${String(key)}`
    violations.push(message)
    throw new Error(`Unexpected fixture access: ${message}`)
  }
  return new Proxy(target, {
    get(object, key) {
      if (!Object.hasOwn(object, key)) return forbidden(key)
      return Reflect.get(object, key)
    },
    set(object, key, value) {
      if (!writable.includes(key)) return forbidden(`write:${String(key)}`)
      return Reflect.set(object, key, value)
    },
    defineProperty(_object, key) {
      return forbidden(`define:${String(key)}`)
    },
    deleteProperty(_object, key) {
      return forbidden(`delete:${String(key)}`)
    }
  })
}

function run(source, globals, violations, filename) {
  const blocked = (name) => () => {
    violations.push(name)
    throw new Error(`Forbidden runtime API: ${name}`)
  }
  const context = createContext(
    {
      fetch: blocked('fetch'),
      XMLHttpRequest: blocked('XMLHttpRequest'),
      WebSocket: blocked('WebSocket'),
      setInterval: blocked('setInterval'),
      setTimeout: blocked('setTimeout'),
      require: blocked('require'),
      ...globals
    },
    { codeGeneration: { strings: false, wasm: false } }
  )
  new Script(source, { filename }).runInContext(context, { timeout: 1000 })
}

function domFixture(html, violations) {
  const listeners = new Map()
  const elements = new Map()
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(
      id,
      guarded(
        {
          textContent: '',
          addEventListener(type, handler) {
            assert.equal(type, 'click')
            assert.equal(typeof handler, 'function')
            assert.equal(listeners.has(id), false)
            listeners.set(id, handler)
          }
        },
        `element:${id}`,
        violations,
        ['textContent']
      )
    )
  }
  return {
    document: guarded(
      {
        getElementById(id) {
          assert.ok(elements.has(id), `Referenced element exists: ${id}`)
          return elements.get(id)
        }
      },
      'document',
      violations
    ),
    click(id) {
      assert.ok(listeners.has(id), `Click handler exists: ${id}`)
      listeners.get(id)()
    },
    get text() {
      return elements.get('selection').textContent
    },
    listeners
  }
}

function figmaNode(violations, overrides = {}) {
  return guarded(
    {
      id: '1:2',
      type: 'RECTANGLE',
      name: 'Selected node',
      locked: false,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      rotation: 0,
      ...overrides
    },
    'node',
    violations
  )
}

function photoshopLayer(violations, overrides = {}) {
  return guarded(
    { id: 7, kind: 'pixel', name: 'Selected layer', allLocked: false, ...overrides },
    'layer',
    violations
  )
}

function boundedSelection(count, makeNode, violations) {
  const selection = Array.from({ length: count }, (_, index) => {
    if (index < 100) return makeNode(index)
    return guarded({}, 'unvisited-selection', violations)
  })
  return guarded(selection, 'selection', violations)
}

function figmaFixture(selection, violations) {
  const state = { pageReads: 0, selectionReads: 0, closed: 0, shown: [], posts: [] }
  const page = guarded(
    {
      get selection() {
        state.selectionReads += 1
        return selection
      }
    },
    'page',
    violations
  )
  const ui = guarded(
    {
      onmessage: null,
      postMessage(message) {
        state.posts.push(plain(message))
      }
    },
    'figma.ui',
    violations,
    ['onmessage']
  )
  const figma = guarded(
    {
      ui,
      get currentPage() {
        state.pageReads += 1
        return page
      },
      showUI(html, options) {
        state.shown.push({ html, options: plain(options) })
      },
      closePlugin() {
        state.closed += 1
      }
    },
    'figma',
    violations
  )
  run(figmaCode, { figma, __html__: figmaHtml }, violations, 'figma/code.js')
  return { state, receive: (message) => ui.onmessage(message) }
}

function figmaUiFixture(violations, receive = () => {}) {
  const dom = domFixture(figmaHtml, violations)
  const posts = []
  const handlers = new Map()
  const parent = guarded(
    {
      postMessage(message, origin) {
        assert.equal(origin, '*')
        posts.push(plain(message))
        receive(message.pluginMessage)
      }
    },
    'parent',
    violations
  )
  const window = guarded(
    {
      addEventListener(type, handler) {
        assert.equal(type, 'message')
        assert.equal(handlers.has(type), false)
        handlers.set(type, handler)
      }
    },
    'window',
    violations
  )
  const scripts = [...figmaHtml.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)]
  assert.equal(scripts.length, 1)
  run(scripts[0][1], { document: dom.document, parent, window }, violations, 'figma/ui.html')
  return {
    dom,
    posts,
    deliver(message, source = parent) {
      handlers.get('message')({ source, data: { pluginMessage: message } })
    }
  }
}

function photoshopFixture(selection, violations, documentState = 'open') {
  const dom = domFixture(photoshopHtml, violations)
  const state = { documentReads: 0, selectionReads: 0, modules: [] }
  const activeDocument = guarded(
    {
      get activeLayers() {
        state.selectionReads += 1
        return selection
      }
    },
    'activeDocument',
    violations
  )
  const app = guarded(
    {
      get activeDocument() {
        state.documentReads += 1
        if (documentState === 'throw') throw new Error('Private host error details')
        return documentState === 'open' ? activeDocument : null
      }
    },
    'photoshop.app',
    violations
  )
  run(
    photoshopCode,
    {
      document: dom.document,
      require(name) {
        state.modules.push(name)
        assert.equal(name, 'photoshop')
        return guarded({ app }, 'photoshop', violations)
      }
    },
    violations,
    'photoshop-uxp/main.js'
  )
  return { dom, state }
}

test('templates retain user-supplied identity placeholders and only the allowed permissions', () => {
  const figma = JSON.parse(read('figma/manifest.template.json'))
  assert.deepEqual(figma, {
    name: 'MagicPot',
    id: '__FIGMA_ASSIGNED_PLUGIN_ID__',
    api: '1.0.0',
    editorType: ['figma'],
    documentAccess: 'dynamic-page',
    main: 'code.js',
    ui: 'ui.html',
    networkAccess: { allowedDomains: ['none'] }
  })
  assert.equal(read(`figma/${figma.main}`), figmaCode)
  assert.equal(read(`figma/${figma.ui}`), figmaHtml)
  assert.doesNotMatch(figmaHtml, /<script\b[^>]*\bsrc=/i)

  const photoshop = JSON.parse(read('photoshop-uxp/manifest.template.json'))
  assert.deepEqual(photoshop, {
    manifestVersion: 5,
    id: '__PHOTOSHOP_PLUGIN_ID__',
    name: 'MagicPot',
    version: '1.0.0',
    main: 'index.html',
    host: { app: 'PS', minVersion: '23.3.0' },
    entrypoints: [{ type: 'panel', id: 'magicpot', label: { default: 'MagicPot' } }],
    requiredPermissions: { localFileSystem: 'plugin' }
  })
  assert.equal(read(`photoshop-uxp/${photoshop.main}`), photoshopHtml)
  // Parse the artifact rather than approximate external-script tags with a
  // filter regexp. jsdom does not execute or fetch scripts by default.
  const dom = new JSDOM(photoshopHtml)
  try {
    const scripts = [...dom.window.document.querySelectorAll('script')]
    assert.equal(scripts.length, 1)
    assert.equal(scripts[0].getAttribute('src'), 'main.js')
    assert.equal(scripts[0].textContent.trim(), '')
    assert.equal(read('photoshop-uxp/main.js'), photoshopCode)
  } finally {
    dom.window.close()
  }
})

test('runtime sources have no network, storage, document-write, or arbitrary-execution APIs', () => {
  for (const source of [figmaCode, figmaHtml, photoshopCode, photoshopHtml]) {
    assert.doesNotMatch(
      source,
      /\b(?:fetch|XMLHttpRequest|WebSocket|eval|Function|executeAsModal|batchPlay|innerHTML|outerHTML|insertAdjacentHTML|clientStorage|localStorage|sessionStorage|getPluginData|setPluginData|getSharedPluginData|setSharedPluginData|loadAllPagesAsync|localFileSystem|writeFile|readFile|shell|process)\b/
    )
    assert.doesNotMatch(source, /https?:\/\/|\bimport\s|document\.write\s*\(/)
  }
  assert.deepEqual(
    [...photoshopCode.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]),
    ['photoshop']
  )
  for (const html of [figmaHtml, photoshopHtml]) {
    assert.match(html, /Desktop not paired\./)
    assert.match(html, /Capabilities disabled:/)
    assert.match(html, />Read selection<\/button>/)
    assert.doesNotMatch(html, /<(?:iframe|img|form|textarea|input)\b/i)
  }
})

test('Figma opens without reading; an actual UI click reads and Close only closes', () => {
  const violations = []
  const main = figmaFixture([figmaNode(violations)], violations)
  const ui = figmaUiFixture(violations, main.receive)
  assert.equal(main.state.shown.length, 1)
  assert.equal(main.state.shown[0].html, figmaHtml)
  assert.deepEqual(main.state.shown[0].options, { width: 380, height: 520 })
  assert.equal(main.state.pageReads, 0)
  assert.equal(main.state.selectionReads, 0)
  assert.deepEqual(main.state.posts, [])
  assert.deepEqual(ui.posts, [])
  assert.equal(ui.dom.text, '')
  assert.deepEqual([...ui.dom.listeners.keys()], ['read-selection', 'close'])

  ui.dom.click('read-selection')
  assert.deepEqual(ui.posts, [{ pluginMessage: { type: 'read-selection' } }])
  assert.equal(main.state.pageReads, 1)
  assert.equal(main.state.selectionReads, 1)
  ui.deliver(main.state.posts[0])
  assert.deepEqual(JSON.parse(ui.dom.text), main.state.posts[0])
  ui.dom.click('close')
  assert.equal(main.state.closed, 1)
  assert.equal(main.state.selectionReads, 1)
  assert.deepEqual(violations, [])
})

test('Figma ignores unknown, inherited, oversized, extra-field and malformed commands', () => {
  const violations = []
  const main = figmaFixture([], violations)
  const circular = { type: 'read-selection' }
  circular.payload = circular
  for (const input of [
    null,
    undefined,
    [],
    'read-selection',
    42,
    { type: 'write-document' },
    { type: 'READ-SELECTION' },
    { type: 'close', extra: true },
    { type: 'read-selection', payload: 'x'.repeat(300000) },
    { type: 'read-selection'.repeat(30000) },
    { type: { toString: () => 'read-selection' } },
    Object.create({ type: 'read-selection' }),
    circular
  ])
    main.receive(input)
  assert.equal(main.state.pageReads, 0)
  assert.equal(main.state.closed, 0)
  assert.deepEqual(main.state.posts, [])
  main.receive({ type: 'read-selection' })
  assert.deepEqual(main.state.posts, [emptyContext('figma')])
  assert.deepEqual(violations, [])
})

for (const count of [0, 1, 100, 101]) {
  test(`Figma selection of ${count} visits only the bounded selected nodes`, () => {
    const violations = []
    const selection = boundedSelection(
      count,
      (index) => figmaNode(violations, { id: `1:${index}` }),
      violations
    )
    const main = figmaFixture(selection, violations)
    main.receive({ type: 'read-selection' })
    const context = main.state.posts[0]
    assert.equal(context.nodes.length, Math.min(count, 100))
    assert.equal(context.truncated, count > 100)
    assert.equal(main.state.selectionReads, 1)
    assert.deepEqual(
      context.nodes.map((node) => node.id),
      Array.from({ length: Math.min(count, 100) }, (_, index) => `1:${index}`)
    )
    assert.deepEqual(violations, [])
  })
}

test('Figma filters host data and control characters, retaining only finite geometry', () => {
  const violations = []
  const name = '<img src=x onerror=alert(1)>\u0000\n\u202e' + 'n'.repeat(200)
  const main = figmaFixture(
    [
      figmaNode(violations, {
        id: 'i'.repeat(200),
        type: 'TEXT',
        name,
        locked: true,
        x: -5,
        y: NaN,
        width: 12.5,
        height: Infinity,
        rotation: '90'
      })
    ],
    violations
  )
  main.receive({ type: 'read-selection' })
  assert.deepEqual(main.state.posts[0], {
    ...emptyContext('figma'),
    nodes: [
      {
        id: 'i'.repeat(120),
        type: 'TEXT',
        name: name.slice(0, 120).replace(/[\u0000\n\u202e]/g, ''),
        locked: true,
        geometry: { x: -5, width: 12.5 }
      }
    ]
  })
  const ui = figmaUiFixture(violations)
  ui.deliver(main.state.posts[0])
  assert.match(ui.dom.text, /<img src=x onerror=alert\(1\)>/)
  assert.deepEqual(JSON.parse(ui.dom.text), main.state.posts[0])
  assert.deepEqual(violations, [])
})

test('Figma UI ignores foreign, unknown, malformed, and oversized replies', () => {
  const violations = []
  const ui = figmaUiFixture(violations)
  const valid = emptyContext('figma')
  ui.deliver(valid, {})
  const circular = { ...valid }
  circular.nodes = [circular]
  for (const message of [
    null,
    {},
    { ...valid, kind: 'execute' },
    { ...valid, protocol: 2 },
    { ...valid, host: 'photoshop' },
    { ...valid, nodes: {} },
    { ...valid, nodes: Array(101).fill({}) },
    { ...valid, truncated: 'false' },
    { ...valid, nodes: [{ name: 'x'.repeat(300000) }] },
    circular
  ])
    ui.deliver(message)
  assert.equal(ui.dom.text, '')
  assert.deepEqual(ui.posts, [])
  ui.deliver(valid)
  assert.deepEqual(JSON.parse(ui.dom.text), valid)
  assert.deepEqual(violations, [])
})

test('Photoshop opens without reading and registers only the explicit read button', () => {
  const violations = []
  const panel = photoshopFixture([photoshopLayer(violations)], violations)
  assert.deepEqual(panel.state.modules, ['photoshop'])
  assert.equal(panel.state.documentReads, 0)
  assert.equal(panel.state.selectionReads, 0)
  assert.equal(panel.dom.text, '')
  assert.deepEqual([...panel.dom.listeners.keys()], ['read-selection'])
  panel.dom.click('read-selection')
  assert.equal(panel.state.documentReads, 1)
  assert.equal(panel.state.selectionReads, 1)
  assert.deepEqual(JSON.parse(panel.dom.text), {
    ...emptyContext('photoshop'),
    nodes: [{ id: 7, kind: 'pixel', name: 'Selected layer', locked: false }]
  })
  assert.deepEqual(violations, [])
})

for (const count of [0, 1, 100, 101]) {
  test(`Photoshop selection of ${count} visits only bounded active layers`, () => {
    const violations = []
    const selection = boundedSelection(
      count,
      (index) => photoshopLayer(violations, { id: index }),
      violations
    )
    const panel = photoshopFixture(selection, violations)
    panel.dom.click('read-selection')
    const context = JSON.parse(panel.dom.text)
    assert.equal(context.nodes.length, Math.min(count, 100))
    assert.equal(context.truncated, count > 100)
    assert.deepEqual(
      context.nodes.map((node) => node.id),
      Array.from({ length: Math.min(count, 100) }, (_, index) => index)
    )
    assert.equal(panel.state.selectionReads, 1)
    assert.deepEqual(violations, [])
  })
}

test('Photoshop reads only allowlisted layer data and renders names as plain text', () => {
  const violations = []
  const name = '<script>alert(1)</script>\u0000\r\u2066' + 'n'.repeat(200)
  const kind = 'group\u0001' + 'k'.repeat(200)
  const panel = photoshopFixture(
    [photoshopLayer(violations, { id: NaN, name, kind, allLocked: true })],
    violations
  )
  panel.dom.click('read-selection')
  assert.deepEqual(JSON.parse(panel.dom.text), {
    ...emptyContext('photoshop'),
    nodes: [
      {
        id: null,
        name: name.slice(0, 120).replace(/[\u0000\r\u2066]/g, ''),
        kind: kind.slice(0, 120).replace(/\u0001/g, ''),
        locked: true
      }
    ]
  })
  assert.match(panel.dom.text, /<script>alert\(1\)<\/script>/)
  assert.deepEqual(violations, [])
})

test('Photoshop without a document yields a fixed empty context, not private error details', () => {
  for (const state of ['none', 'throw']) {
    const violations = []
    const panel = photoshopFixture([], violations, state)
    assert.equal(panel.state.documentReads, 0)
    panel.dom.click('read-selection')
    assert.equal(panel.state.documentReads, 1)
    assert.equal(panel.state.selectionReads, 0)
    assert.deepEqual(JSON.parse(panel.dom.text), emptyContext('photoshop'))
    assert.doesNotMatch(panel.dom.text, /Private host error details/)
    assert.deepEqual(violations, [])
  }
})

test('development documentation leaves real host import and integration explicitly incomplete', () => {
  for (const host of ['figma']) {
    const readme = read(`${host}/README.md`)
    assert.match(readme, /local development artifact source/)
    assert.match(readme, /HostAdapter/)
    assert.match(readme, /pairing/)
    assert.match(readme, /dialogue/)
    assert.match(readme, /rembg/)
    assert.match(readme, /incomplete/)
    assert.match(readme, /manual validation/)
    assert.match(readme, /VM host\/DOM fixtures only/)
    assert.match(readme, /parent package builder\/installer/)
  }
  assert.match(read('figma/README.md'), /__FIGMA_ASSIGNED_PLUGIN_ID__/)
  assert.match(read('figma/README.md'), /must use your assigned ID/)
  assert.match(read('photoshop-uxp/README.md'), /__PHOTOSHOP_PLUGIN_ID__/)
  assert.match(read('photoshop-uxp/README.md'), /UXP Developer Tool/)
  const connected = read('photoshop-uxp/README.md')
  assert.match(connected, /Offline v1/)
  assert.match(connected, /Connected v2/)
  assert.match(connected, /no network, pairing or document writes/)
  assert.match(connected, /separate MagicPot desktop approval/)
  assert.match(connected, /not server authentication, Provider readiness/)
  assert.match(connected, /must never be reported as connected-plugin acceptance/)
  assert.match(connected, /No application-wide developer settings are written/)

  assert.match(read('photoshop-uxp/README.md'), /No `\.ccx` is provided/)
})
