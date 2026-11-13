'use strict'

/* eslint-disable @typescript-eslint/no-require-imports -- Tests exercise the synchronous CJS bootstrap without loading Electron. */

const assert = require('node:assert/strict')
const test = require('node:test')
const {
  __test: {
    validateMockOrigin,
    createPolicy,
    httpRequestUrl,
    installNodeNetworkGuards,
    installSessionGuard
  }
} = require('./isolatedImageDesktopBootstrap.cjs')

const MOCK = 'http://127.0.0.1:43127'
function fixture() {
  const state = { blockedRequestCount: 0, blockedRequests: [] }
  return { state, policy: createPolicy(MOCK, state) }
}
function isBlocked(error) {
  return error?.code === 'ISOLATED_DESKTOP_OUTBOUND_BLOCKED'
}
function fakeSession() {
  const session = {
    registrations: [],
    webRequest: {
      onBeforeRequest(filter, listener) {
        session.registrations.push({ filter, listener })
      }
    }
  }
  session.check = (url) => {
    const answers = []
    session.registrations.at(-1).listener({ url }, (answer) => answers.push(answer))
    assert.equal(answers.length, 1)
    return answers[0]
  }
  return session
}

test('importing the bootstrap does not start a desktop or install a global state', () => {
  assert.equal(globalThis.__MAGICPOT_IMAGE_DESKTOP__, undefined)
})

test('mock origin requires explicit literal IPv4 HTTP loopback and an unprivileged port', () => {
  assert.equal(validateMockOrigin(MOCK), MOCK)
  assert.equal(validateMockOrigin(MOCK + '/'), MOCK)
  for (const value of [
    'http://localhost:43127',
    'http://127.1:43127',
    'http://2130706433:43127',
    'http://[::1]:43127',
    'https://127.0.0.1:43127',
    'http://127.0.0.1',
    'http://127.0.0.1:80',
    'http://127.0.0.1:1023',
    'http://127.0.0.1:65536',
    'http://user:secret@127.0.0.1:43127',
    MOCK + '/responses',
    MOCK + '?secret=value',
    MOCK + '#fragment'
  ])
    assert.throws(() => validateMockOrigin(value))
})

test('URL policy permits only the mock origin and explicitly allowed local schemes', () => {
  const { policy, state } = fixture()
  assert.equal(policy.allows(MOCK + '/v1/responses', false), true)
  for (const value of [
    'file:///synthetic/test.png',
    'data:image/png;base64,synthetic',
    'blob:' + MOCK + '/synthetic-blob',
    'local-media://image/synthetic.png'
  ]) {
    assert.equal(policy.allows(value, true), true)
    assert.equal(policy.allows(value, false), false)
  }
  for (const value of [
    'http://127.0.0.1:43128/v1/responses',
    'http://localhost:43127/v1/responses',
    'https://example.invalid/secret?token=private',
    'ws://127.0.0.1:43127/socket',
    'http://user:secret@127.0.0.1:43127/credentials',
    'not a URL'
  ])
    assert.throws(() => policy.assertUrl(value, 'test'), isBlocked)
  assert.equal(state.blockedRequestCount, 6)
  const serialized = JSON.stringify(state)
  assert.equal(serialized.includes('private'), false)
  assert.equal(serialized.includes('secret'), false)
  assert.equal(serialized.includes('credentials'), false)
  assert.equal(serialized.includes('/v1/'), false)
})

test('blocked diagnostics stay bounded while retaining the total counter', () => {
  const { state, policy } = fixture()
  for (let index = 0; index < 70; index++) policy.record('test', 'https://example.invalid/' + index)
  assert.equal(state.blockedRequestCount, 70)
  assert.equal(state.blockedRequests.length, 64)
  assert.deepEqual(state.blockedRequests[0], {
    transport: 'test',
    origin: 'https://example.invalid'
  })
})

test('HTTP options are checked using their final protocol, hostname, and port', () => {
  assert.equal(httpRequestUrl([MOCK + '/v1/responses'], 'http:'), MOCK + '/')
  assert.equal(
    httpRequestUrl([{ hostname: '127.0.0.1', port: 43127, path: '/v1/responses' }], 'http:'),
    MOCK + '/'
  )
  assert.equal(
    httpRequestUrl(
      [MOCK, { hostname: 'elsewhere.invalid', port: 443, protocol: 'https:' }],
      'http:'
    ),
    'https://elsewhere.invalid:443/'
  )
  assert.equal(
    httpRequestUrl(['http://elsewhere.invalid:43127', { host: '127.0.0.1' }], 'http:'),
    'http://elsewhere.invalid:43127/'
  )
  assert.throws(
    () => httpRequestUrl([{ socketPath: 'private-pipe', path: '/' }], 'http:'),
    isBlocked
  )
  assert.throws(
    () => httpRequestUrl([{ hostname: '127.0.0.1', port: 43127, auth: 'user:secret' }], 'http:'),
    isBlocked
  )
})

test('Node wrappers reject before calling transports and preserve allowed call arguments', async () => {
  const { policy, state } = fixture()
  const calls = []
  const transport = (name) => ({
    request(...args) {
      calls.push({ name: name + ':request', args })
      return 'request-result'
    },
    get(...args) {
      calls.push({ name: name + ':get', args })
      return 'get-result'
    }
  })
  class FakeSocket {
    connect(...args) {
      calls.push({ name: 'socket', args })
      return this
    }
  }
  const globals = {
    async fetch(...args) {
      calls.push({ name: 'fetch', args })
      return 'fetch-result'
    }
  }
  const http = transport('http')
  const https = transport('https')
  const tls = {
    connect() {
      calls.push({ name: 'tls' })
    }
  }
  installNodeNetworkGuards(policy, { globals, http, https, net: { Socket: FakeSocket }, tls })
  const options = { method: 'POST' }
  const callback = () => {}
  assert.equal(http.request(MOCK + '/v1/responses', options, callback), 'request-result')
  assert.deepEqual(calls[0].args, [MOCK + '/v1/responses', options, callback])
  assert.equal(http.get({ hostname: '127.0.0.1', port: 43127, path: '/fixture' }), 'get-result')
  assert.equal(await globals.fetch({ url: MOCK + '/v1/responses' }, options), 'fetch-result')
  assert.equal(await globals.fetch('data:text/plain,synthetic'), 'fetch-result')
  const socket = new FakeSocket()
  assert.equal(socket.connect(43127, '127.0.0.1', callback), socket)
  assert.equal(socket.connect([{ host: '127.0.0.1', port: 43127 }, callback]), socket)
  const acceptedCalls = calls.length
  assert.throws(() => http.request('http://example.invalid/secret?credential=value'), isBlocked)
  assert.throws(() => http.get(MOCK, { hostname: 'example.invalid' }), isBlocked)
  assert.throws(() => https.request('https://127.0.0.1:43127/'), isBlocked)
  assert.throws(() => socket.connect(43128, '127.0.0.1'), isBlocked)
  assert.throws(() => socket.connect(43127, 'localhost'), isBlocked)
  assert.throws(() => socket.connect({ path: 'private-pipe' }), isBlocked)
  assert.throws(() => tls.connect({ host: '127.0.0.1', port: 43127 }), isBlocked)
  await assert.rejects(globals.fetch('https://example.invalid/secret?credential=value'), isBlocked)
  assert.equal(calls.length, acceptedCalls)
  assert.equal(state.blockedRequestCount, 8)
  assert.equal(JSON.stringify(state).includes('credential'), false)
})

test('a later product listener cannot replace or unsubscribe the session network guard', () => {
  const { policy, state } = fixture()
  const session = fakeSession()
  installSessionGuard(session, policy)
  assert.deepEqual(session.check(MOCK + '/v1/responses'), { cancel: false })
  let productCalls = 0
  session.webRequest.onBeforeRequest(
    { urls: ['*://*.xgoi.cc/*', '*://xgoi.cc/*'] },
    (_details, done) => {
      productCalls++
      done({ cancel: true })
    }
  )
  assert.deepEqual(session.check(MOCK + '/v1/responses'), { cancel: false })
  assert.deepEqual(session.check('https://example.invalid/private?secret=value'), { cancel: true })
  assert.equal(productCalls, 0)
  session.webRequest.onBeforeRequest(null)
  assert.deepEqual(session.check('https://example.invalid/'), { cancel: true })
  assert.deepEqual(session.check('file:///synthetic/index.html'), { cancel: false })
  assert.equal(state.blockedRequestCount, 2)
  assert.deepEqual(session.registrations.at(-1).filter, { urls: ['<all_urls>'] })
  const registrations = session.registrations.length
  installSessionGuard(session, policy)
  assert.equal(session.registrations.length, registrations)
})

test('matching product decisions remain effective but external redirects are cancelled', () => {
  const { policy, state } = fixture()
  const session = fakeSession()
  installSessionGuard(session, policy)
  session.webRequest.onBeforeRequest({ urls: [MOCK + '/cancel/*'] }, (_details, done) =>
    done({ cancel: true })
  )
  assert.deepEqual(session.check(MOCK + '/cancel/fixture'), { cancel: true })
  assert.deepEqual(session.check(MOCK + '/other'), { cancel: false })
  session.webRequest.onBeforeRequest((_details, done) => {
    done({ redirectURL: 'https://example.invalid/private?secret=value' })
    done({ cancel: false })
  })
  assert.deepEqual(session.check(MOCK + '/redirect'), { cancel: true })
  assert.deepEqual(state.blockedRequests, [
    { transport: 'electron:redirect', origin: 'https://example.invalid' }
  ])
  session.webRequest.onBeforeRequest((_details, done) =>
    done({ redirectURL: MOCK + '/same-origin' })
  )
  assert.deepEqual(session.check(MOCK + '/redirect'), { redirectURL: MOCK + '/same-origin' })
})
