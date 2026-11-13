// Isolated real-ChatPage/IndexedDB acknowledgement fixture.
// This starts two real browser windows against the bundled ChatPage and records
// a bounded A→B→A storage/ack interleaving; it never uses a provider or network.
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const chat = path.join(root, 'packages/app/src/renderer/src/pages/ChatPage')
const storage = await realpath(path.join(chat, 'chatStorage.ts'))
const baseline = await realpath(path.join(chat, 'chatSaveBaseline.ts'))
const entry = await realpath(path.join(chat, 'ChatPage.tsx'))
const gateModule = await realpath(path.join(root, 'scripts/chat/chatPageAckGate.mjs'))
const readGateModule = await realpath(path.join(root, 'scripts/chat/chatPageReadGate.mjs'))
// Check required source inputs and the installed bundler before invoking it. No Chrome,
// profile, output directory, server, or repository write is needed for this stage.
await Promise.all([access(storage), access(baseline), access(entry), access(gateModule), access(readGateModule)])
const { build } = await import('esbuild')
if (typeof build !== 'function') throw Error('Installed esbuild does not expose build()')
const artifactRoot = await mkdtemp(path.join(tmpdir(), 'magicpot-ack-fixture-'))

const result = await build({
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: path.join(artifactRoot, 'ack-fixture.js'),
  metafile: true,
  write: true,
  jsx: 'automatic',
  logLevel: 'silent',
  alias: {
    '@renderer': path.join(root, 'packages/app/src/renderer/src'),
    '@shared': path.join(root, 'packages/app/src/shared')
  },
  plugins: [{
    name: 'ack-fixture-canonical-storage',
    setup(plugin) {
      plugin.onResolve({ filter: /^fixture-entry$/ }, () => ({ path: 'entry', namespace: 'ack-fixture' }))
      plugin.onLoad({ filter: /^entry$/, namespace: 'ack-fixture' }, () => ({
        loader: 'js', resolveDir: root,
        contents: `import ChatPage from ${JSON.stringify(entry)};
import * as storage from ${JSON.stringify(storage)};
import { __canonicalSaveIdentity, saveSessionToDB as acknowledgedSave } from 'fixture-storage-wrapper';
import { __canonicalReadIdentity, loadAllSessions as scopedRead } from 'fixture-page-storage-wrapper';
import { installGate } from 'fixture-ack-gate';
import { installReadGate } from 'fixture-read-gate';
import { createAcknowledgementGate } from ${JSON.stringify(gateModule)};
import { createScopedReadGate } from ${JSON.stringify(readGateModule)};
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { ConfigProvider } from '@renderer/hooks/useConfig';
import { MessageProvider } from '@renderer/hooks/useMessage';
import { DEFAULT_CONFIG } from '@shared/config/config';
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv';
import i18n from '@renderer/i18n';
// Keep a second reference to the storage module from ChatPage's importer graph. The
// future browser harness must assert equality at runtime; the source alone proves nothing.
const canonicalIdentityMatches = () => storage.saveSessionToDB === __canonicalSaveIdentity && storage.loadAllSessions === __canonicalReadIdentity;
Object.defineProperty(window, '__ackFixtureModules', {
  value: Object.freeze({ ChatPage, storage, acknowledgedSave, scopedRead, canonicalIdentityMatches }),
  writable: false, configurable: false
});
// Sticky audit survives application catches. Allowlisted properties must be explicitly
// defined, including optional capability probes; unknown reads fail closed.
const violations = [];
const violationCounts = Object.create(null);
const callCounts = Object.create(null);
const optionalProbeCounts = Object.create(null);
let violationOverflow = 0;
const services = Object.create(null);
const deny = path => {
  if (!Object.hasOwn(violationCounts, path)) {
    if (violations.length >= 256) { violationOverflow++; throw Error('Unknown host access: audit capacity exceeded'); }
    violations.push(path);
  }
  violationCounts[path] = (violationCounts[path] || 0) + 1;
  throw Error('Unknown host access: ' + path);
};
const host = new Proxy(services, {
  get(target, service) {
    if (typeof service !== 'string' || !Object.hasOwn(target, service)) return deny(String(service));
    return target[service];
  },
  has(target, service) {
    if (typeof service !== 'string' || !Object.hasOwn(target, service)) return deny(String(service));
    return true;
  },
  getOwnPropertyDescriptor(target, service) {
    if (typeof service !== 'string' || !Object.hasOwn(target, service)) return deny(String(service));
    return Reflect.getOwnPropertyDescriptor(target, service);
  },
  ownKeys() { return deny('enumerate:services'); },
  set(_target, service) { return deny('write:' + String(service)); },
  defineProperty(_target, service) { return deny('define:' + String(service)); },
  deleteProperty(_target, service) { return deny('delete:' + String(service)); },
  setPrototypeOf() { return deny('prototype:services'); },
  preventExtensions() { return deny('preventExtensions:services'); }
});
const defineService = (name, methods) => {
  if (Object.hasOwn(services, name)) throw Error('Duplicate host service: ' + name);
  const recorded = Object.fromEntries(Object.entries(methods).map(([method, value]) => [method,
    typeof value === 'function' ? (...args) => {
      const key = name + '.' + method;
      callCounts[key] = (callCounts[key] || 0) + 1;
      return value(...args);
    } : value
  ]));
  const allowed = Object.freeze(Object.assign(Object.create(null), recorded));
  services[name] = new Proxy(allowed, {
    get(target, method) {
      if (typeof method !== 'string' || !Object.hasOwn(target, method)) return deny(name + '.' + String(method));
      if (target[method] === undefined) {
        const key = name + '.' + method;
        optionalProbeCounts[key] = (optionalProbeCounts[key] || 0) + 1;
      }
      return target[method];
    },
    has(target, method) {
      if (typeof method !== 'string' || !Object.hasOwn(target, method)) return deny(name + '.' + String(method));
      return true;
    },
    getOwnPropertyDescriptor(target, method) {
      if (typeof method !== 'string' || !Object.hasOwn(target, method)) return deny(name + '.' + String(method));
      return Reflect.getOwnPropertyDescriptor(target, method);
    },
    ownKeys() { return deny('enumerate:' + name); },
    set(_target, method) { return deny('write:' + name + '.' + String(method)); },
    defineProperty(_target, method) { return deny('define:' + name + '.' + String(method)); },
    deleteProperty(_target, method) { return deny('delete:' + name + '.' + String(method)); },
    setPrototypeOf() { return deny('prototype:' + name); },
    preventExtensions() { return deny('preventExtensions:' + name); }
  });
};
// Known local fixture services only. These are not a comprehensive allowlist: an
// Unlisted reads/invocations and disabled capability calls remain sticky violations
// even if React catches the exception. Every enabled method below is deterministic,
// local-only and kept to the audited ChatPage startup contract.
// No method here accepts a path, accesses the filesystem or performs network I/O.
const fixtureConfig = structuredClone(DEFAULT_CONFIG);
fixtureConfig.use_remote_llm = false;
fixtureConfig.llm_config.api_profiles = [{ id: 'fixture', model_name: 'fixture', model_use: 'chat', api_mode: 'chat-completions', api_key: 'fixture-only', base_url: 'http://127.0.0.1:1/disabled' }];
const fixtureBuildEnv = structuredClone(DEFAULT_BUILD_ENV);
fixtureBuildEnv.pathMap.data = '';
defineService('svcState', {
  getConfig: async () => ({ config: structuredClone(fixtureConfig) }),
  getBuildEnv: async () => ({ buildEnv: structuredClone(fixtureBuildEnv) }),
  getMcpStatus: undefined,
  watchConfig: (_request, options) => new Promise(resolve => {
    if (options.abortReceiver.isAborted()) resolve();
    else options.abortReceiver.onAbort(resolve);
  })
});
defineService('svcManagedMedia', {
  importFile: undefined,
  importDataUrl: undefined,
  migrateLegacyDataUrl: undefined,
  reclaimLegacyMigration: undefined,
  updateReferenceSnapshot: undefined,
  ensureDerivative: undefined,
  materializeForRequest: undefined
});
defineService('svcLLMProxy', {
  listAgentJobs: async () => ({ jobs: [] }),
  listAgentProcesses: async () => ({ jobs: [] }),
  listAgentTeamMessages: async () => ({ intents: [] }),
  listAgentHtmlApps: async () => ({ apps: [] }),
  agentHtmlStorageStatus: async () => ({ enabled: false, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false }),
  listAgentArchiveQueries: undefined,
  listAgentInteractions: undefined,
  managedFirstRunPaneRevision: undefined,
  setAgentSkillScope: undefined,
  setAgentHtmlScope: async () => ({ documentToken: 'fixture-document-token' })
});
// Registration is closed before publishing any reference. No host-side code can add
// capabilities or clear violation history once the test page has access to the facade.
Object.freeze(services);
Object.defineProperty(window, '__ackFixtureHostAudit', {
  value: Object.freeze({ host, violations: () => violations.slice(), violationCounts: () => ({ ...violationCounts }), violationOverflow: () => violationOverflow, counts: () => ({ ...callCounts }), optionalProbeCounts: () => ({ ...optionalProbeCounts }) }),
  writable: false, configurable: false
});
// Exact-key fixture seeding, not a test of team-member creation validation. Both
// scopes deliberately share an id to expose cross-scope mistakes; values are inert.
// Seed uses the canonical production storage module; it does not pass through the
// acknowledgement wrapper, whose trace must therefore remain empty at this stage.
// The future harness must prove that this is a fresh context with no running page
// writers before invoking the seed. A read preflight does not by itself exclude a
// concurrent writer, and must not be claimed as an atomic creation contract.
window.__ackFixtureSeed = async (scopeA, scopeB, id) => {
  if (![scopeA, scopeB, id].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)) || scopeA === scopeB || scopeA === 'default' || scopeB === 'default') {
    return deny('seed:invalid-key');
  }
  const memberId = id + '-member';
  for (const scope of [scopeA, scopeB]) {
    if (localStorage.getItem('chat.currentSessionId.' + scope) !== null) return deny('seed:scope-occupied');
    if (await storage.loadSessionFromDB(id, scope) !== null || await storage.loadSessionFromDB(memberId, scope) !== null) return deny('seed:key-occupied');
  }
  for (const [scope, suffix] of [[scopeA, 'A'], [scopeB, 'B']]) {
    const lead = { id, title: 'Fixture lead ' + suffix, profileId: 'fixture', messages: [{ role: 'user', content: 'Fixture scope ' + suffix + ' ready' }], createdAt: 1, teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } };
    const member = { id: memberId, title: 'Fixture member ' + suffix, profileId: 'fixture', teamLeadId: id, teamMemberName: 'Fixture member ' + suffix, messages: [], createdAt: 2 };
    await storage.saveSessionToDB(lead, scope, { expectedSession: null, pendingSaveOwner: null });
    await storage.saveSessionToDB(member, scope, { expectedSession: null, pendingSaveOwner: null });
    localStorage.setItem('chat.currentSessionId.' + scope, id);
  }
};
window.__ackFixtureDefaults = () => ({ config: structuredClone(DEFAULT_CONFIG), buildEnv: structuredClone(DEFAULT_BUILD_ENV) });
// The same isolated control module is also exercised by offline node tests; those
// tests do not substitute for browser/IndexedDB behavior or prove module identity.
const ackGate = createAcknowledgementGate(deny);
installGate(ackGate);
Object.defineProperty(window, '__ackFixtureGateControl', {
  value: ackGate.control,
  writable: false, configurable: false
});
// This application-layer barrier holds the page's consumer only after the real
// storage read resolves; it does not hold an IndexedDB transaction or prove an
// uninstrumented user-reachable race. Harness must assert the held snapshot and
// event sequence and run a no-gate negative control.
const readGate = createScopedReadGate(deny);
installReadGate(readGate);
Object.defineProperty(window, '__ackFixtureReadGateControl', {
  value: readGate.control,
  writable: false, configurable: false
});
// Browser harness mount. The host is installed only after import evaluation, and
// the outer Playwright context blocks every request outside this local fixture server.
// The harness asserts global errors and sticky host violations after both mounts.
window.__ackFixtureMount = async (element, scope, route) => {
  await i18n.changeLanguage('zh-CN');
  // No path operation has yet been justified for this focused fixture. Make each
  // attempted operation sticky rather than providing a fake filesystem/path API.
  const purePath = new Proxy(Object.freeze(Object.create(null)), {
    get(_target, method) { return deny('path.' + String(method)); },
    has(_target, method) { return deny('path.has:' + String(method)); },
    getOwnPropertyDescriptor(_target, method) { return deny('path.descriptor:' + String(method)); },
    ownKeys() { return deny('path.enumerate'); },
    set(_target, method) { return deny('path.write:' + String(method)); },
    defineProperty(_target, method) { return deny('path.define:' + String(method)); },
    deleteProperty(_target, method) { return deny('path.delete:' + String(method)); },
    setPrototypeOf() { return deny('path.prototype'); },
    preventExtensions() { return deny('path.preventExtensions'); }
  });
  Object.defineProperty(window, 'api', { value: host, configurable: false });
  Object.defineProperty(window, 'path', { value: purePath, configurable: false });
  const root = createRoot(element);
  let currentRoute = route;
  // Keep all wrapper props stable except scope/route so React reconciliation keeps one
  // ChatPage instance. Tests must still prove the mounted behavior, not assume it.
  const theme = createTheme();
  const render = (nextScope, nextRoute = currentRoute) => {
    currentRoute = nextRoute;
    root.render(React.createElement(MemoryRouter, null,
      React.createElement(ThemeProvider, { theme },
        React.createElement(ConfigProvider, null,
          React.createElement(MessageProvider, null,
            React.createElement(ChatPage, { compact: true, active: true, storageScope: nextScope, route: currentRoute }))))));
  };
  render(scope, route);
  return Object.freeze({ rerender: render, unmount: () => root.unmount() });
};`
      }))
      plugin.onResolve({ filter: /^fixture-ack-gate$/ }, () => ({ path: 'gate', namespace: 'ack-fixture' }))
      plugin.onLoad({ filter: /^gate$/, namespace: 'ack-fixture' }, () => ({
        loader: 'js', contents: `let gate;
export const installGate = implementation => {
  if (gate || !implementation || typeof implementation.capture !== 'function' ||
      typeof implementation.cancel !== 'function' || typeof implementation.hold !== 'function') {
    throw Error('Invalid fixture gate installation');
  }
  gate = Object.freeze({ ...implementation });
};
export const getGate = () => {
  if (!gate) throw Error('Fixture acknowledgement gate not installed');
  return gate;
};`
      }))
      plugin.onResolve({ filter: /^fixture-read-gate$/ }, () => ({ path: 'read-gate', namespace: 'ack-fixture' }))
      plugin.onLoad({ filter: /^read-gate$/, namespace: 'ack-fixture' }, () => ({
        loader: 'js', contents: `let gate;
export const installReadGate = implementation => {
  if (gate || !implementation || typeof implementation.capture !== 'function' ||
      typeof implementation.cancel !== 'function' || typeof implementation.hold !== 'function') {
    throw Error('Invalid fixture read gate installation');
  }
  gate = Object.freeze({ ...implementation });
};
export const getReadGate = () => {
  if (!gate) throw Error('Fixture read gate not installed');
  return gate;
};`
      }))
      plugin.onResolve({ filter: /^fixture-storage-wrapper$/ }, () => ({ path: 'wrapper', namespace: 'ack-fixture' }))
      plugin.onResolve({ filter: /^fixture-page-storage-wrapper$/ }, () => ({ path: 'page-wrapper', namespace: 'ack-fixture' }))
      plugin.onResolve({ filter: /(?:^|\/)chatStorage(?:\.ts)?$/ }, async args => {
        if (args.namespace !== 'file' || !args.resolveDir) return
        let resolved
        try { resolved = await realpath(path.resolve(args.resolveDir, args.path.endsWith('.ts') ? args.path : args.path + '.ts')) } catch { return }
        if (resolved !== storage) return
        if (await realpath(args.importer) === baseline) return { path: 'wrapper', namespace: 'ack-fixture' }
        if (await realpath(args.importer) === entry) return { path: 'page-wrapper', namespace: 'ack-fixture' }
        return { path: storage, namespace: 'file' }
      })
      plugin.onLoad({ filter: /^wrapper$/, namespace: 'ack-fixture' }, () => ({
        loader: 'js', resolveDir: root,
        contents: `import * as real from ${JSON.stringify(storage)};
import { getGate } from 'fixture-ack-gate';
import { wrapAcknowledgedSave } from ${JSON.stringify(gateModule)};
export * from ${JSON.stringify(storage)};
export const __canonicalSaveIdentity = real.saveSessionToDB;
export const saveSessionToDB = (...args) => wrapAcknowledgedSave(real.saveSessionToDB, getGate())(...args);`
      }))
      plugin.onLoad({ filter: /^page-wrapper$/, namespace: 'ack-fixture' }, () => ({
        loader: 'js', resolveDir: root,
        contents: `import * as real from ${JSON.stringify(storage)};
import { getReadGate } from 'fixture-read-gate';
import { wrapScopedRead } from ${JSON.stringify(readGateModule)};
export * from ${JSON.stringify(storage)};
export const __canonicalReadIdentity = real.loadAllSessions;
export const loadAllSessions = (...args) => wrapScopedRead(real.loadAllSessions, getReadGate())(...args);`
      }))
    }
  }],
  entryPoints: ['fixture-entry']
})
const inputs = Object.keys(result.metafile.inputs)
const storageInputs = inputs.filter(input => path.resolve(root, input) === storage)
const gateInputs = inputs.filter(input => path.resolve(root, input) === gateModule)
const readGateInputs = inputs.filter(input => path.resolve(root, input) === readGateModule)
const wrapper = inputs.find(input => input === 'ack-fixture:wrapper')
const pageWrapper = inputs.find(input => input === 'ack-fixture:page-wrapper')
const gate = inputs.find(input => input === 'ack-fixture:gate')
const readGate = inputs.find(input => input === 'ack-fixture:read-gate')
const fixtureEntry = inputs.find(input => input === 'ack-fixture:entry')
const pageInput = inputs.find(input => path.resolve(root, input) === entry)
const baselineInput = inputs.find(input => path.resolve(root, input) === baseline)
if (storageInputs.length !== 1 || gateInputs.length !== 1 || readGateInputs.length !== 1 ||
    !wrapper || !pageWrapper || !gate || !readGate || !fixtureEntry || !pageInput || !baselineInput ||
    !result.metafile.inputs[pageInput].imports.some(item => item.path === pageWrapper) ||
    !result.metafile.inputs[pageWrapper].imports.some(item => item.path === storageInputs[0]) ||
    !result.metafile.inputs[pageWrapper].imports.some(item => item.path === readGate) ||
    !result.metafile.inputs[pageWrapper].imports.some(item => item.path === readGateInputs[0]) ||
    !result.metafile.inputs[fixtureEntry].imports.some(item => item.path === readGate) ||
    !result.metafile.inputs[fixtureEntry].imports.some(item => item.path === readGateInputs[0]) ||
    !result.metafile.inputs[baselineInput].imports.some(item => item.path === wrapper) ||
    !result.metafile.inputs[wrapper].imports.some(item => item.path === storageInputs[0]) ||
    !result.metafile.inputs[wrapper].imports.some(item => item.path === gate) ||
    !result.metafile.inputs[wrapper].imports.some(item => item.path === gateInputs[0]) ||
    !result.metafile.inputs[fixtureEntry].imports.some(item => item.path === gate) ||
    !result.metafile.inputs[fixtureEntry].imports.some(item => item.path === gateInputs[0])) {
  throw Error('Fixture build did not establish canonical storage inputs and exact page-read/baseline-ack wrappers.')
}
const bundle = await readFile(path.join(artifactRoot, 'ack-fixture.js'))
const html = '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/ack-fixture.js"></script></body></html>'
let server
let browser
let context
let pageA
let pageB
const pageErrors = { A: [], B: [] }
const networkViolations = []
const assertFixture = (condition, message) => {
  if (!condition) throw Error(message)
}
try {
  server = createServer((request, response) => {
    if (request.url === '/ack-fixture.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      response.end(bundle)
      return
    }
    if (request.url === '/' || request.url === '/favicon.ico') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(html)
      return
    }
    response.writeHead(404)
    response.end()
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('Fixture server did not expose a TCP address')
  const origin = 'http://127.0.0.1:' + address.port
  browser = await chromium.launch({ headless: true })
  context = await browser.newContext()
  await context.route('**/*', async route => {
    const url = route.request().url()
    if (url.startsWith(origin + '/') || url === origin) return route.continue()
    networkViolations.push(url)
    return route.abort()
  })
  pageA = await context.newPage()
  pageB = await context.newPage()
  pageA.on('pageerror', error => pageErrors.A.push(String(error.stack || error)))
  pageB.on('pageerror', error => pageErrors.B.push(String(error.stack || error)))
  await Promise.all([pageA.goto(origin + '/'), pageB.goto(origin + '/')])
  const ready = page => page.waitForFunction(() => typeof window.__ackFixtureSeed === 'function' &&
    typeof window.__ackFixtureMount === 'function' && typeof window.__ackFixtureModules?.canonicalIdentityMatches === 'function')
  await Promise.all([ready(pageA), ready(pageB)])
  await pageA.evaluate(() => window.__ackFixtureSeed('scope-a', 'scope-b', 'fixture'))
  const identities = await Promise.all([
    pageA.evaluate(() => window.__ackFixtureModules.canonicalIdentityMatches()),
    pageB.evaluate(() => window.__ackFixtureModules.canonicalIdentityMatches())
  ])
  assertFixture(identities.every(Boolean), 'Canonical storage identity did not survive the real browser bundle')
  const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'ack-fixture', threadId: 'pane' }
  await Promise.all([
    pageA.evaluate(routeValue => window.__ackFixtureMount(document.getElementById('root'), 'scope-ui-a', routeValue), route),
    pageB.evaluate(routeValue => window.__ackFixtureMount(document.getElementById('root'), 'scope-ui-b', routeValue), route)
  ])
  await Promise.all([pageA.waitForSelector('#root > *'), pageB.waitForSelector('#root > *')])
  await Promise.all([pageA.waitForTimeout(250), pageB.waitForTimeout(250)])
  const initialAudits = await Promise.all([
    pageA.evaluate(() => ({
      violations: window.__ackFixtureHostAudit.violations(),
      violationOverflow: window.__ackFixtureHostAudit.violationOverflow()
    })),
    pageB.evaluate(() => ({
      violations: window.__ackFixtureHostAudit.violations(),
      violationOverflow: window.__ackFixtureHostAudit.violationOverflow()
    }))
  ])
  assertFixture(networkViolations.length === 0, 'Unexpected provider/network request: ' + JSON.stringify(networkViolations))
  for (const [label, audit] of [['A', initialAudits[0]], ['B', initialAudits[1]]]) {
    assertFixture(audit.violations.length === 0, 'Default-deny host violation in page ' + label + ': ' + JSON.stringify(audit.violations))
    assertFixture(audit.violationOverflow === 0, 'Host audit overflow in page ' + label)
  }
  const sessionA = await pageA.evaluate(() => window.__ackFixtureModules.storage.loadSessionFromDB('fixture', 'scope-a'))
  const sessionB = await pageB.evaluate(() => window.__ackFixtureModules.storage.loadSessionFromDB('fixture', 'scope-b'))
  assertFixture(sessionA?.id === 'fixture' && sessionB?.id === 'fixture', 'Seeded sessions were not visible through real IndexedDB')
  await pageA.evaluate(() => window.__ackFixtureGateControl.arm('scope-a', 'fixture', 'ack-a'))
  await pageA.evaluate(session => {
    window.__ackPromiseSettled = false
    window.__ackPromise = window.__ackFixtureModules.acknowledgedSave(
      { ...session, messages: [...session.messages, { role: 'assistant', content: 'A committed' }] },
      'scope-a',
      { pendingSaveOwner: null }
    ).finally(() => { window.__ackPromiseSettled = true })
  }, sessionA)
  await pageA.waitForFunction(() => window.__ackFixtureGateControl.trace().some(event => event.stage === 'storage-committed-ack-held'))
  assertFixture(await pageA.evaluate(() => window.__ackPromiseSettled === false), 'A acknowledgement promise was not held after storage commit')
  await pageB.evaluate(() => window.__ackFixtureReadGateControl.arm('scope-a', 'read-b'))
  await pageB.evaluate(() => {
    window.__readPromiseSettled = false
    window.__readPromise = window.__ackFixtureModules.scopedRead('scope-a').finally(() => { window.__readPromiseSettled = true })
  })
  await pageB.waitForFunction(() => window.__ackFixtureReadGateControl.trace().some(event => event.stage === 'read-resolved-held'))
  const snapshotB = await pageB.evaluate(() => window.__ackFixtureReadGateControl.snapshot('read-b'))
  const observedA = snapshotB.find(session => session.id === 'fixture')
  assertFixture(observedA?.messages?.some(message => message.content === 'A committed'), 'B did not observe the committed A snapshot before ACK release')
  assertFixture(await pageB.evaluate(() => window.__ackPromiseSettled === undefined), 'B unexpectedly shared A promise state')
  const untouchedB = await pageB.evaluate(() => window.__ackFixtureModules.storage.loadSessionFromDB('fixture', 'scope-b'))
  assertFixture(!untouchedB?.messages?.some(message => message.content === 'A committed'), 'Scope B observed a cross-scope write')
  await pageB.evaluate(() => window.__ackFixtureReadGateControl.release('read-b'))
  await pageB.waitForFunction(() => window.__readPromiseSettled === true)
  await pageA.evaluate(() => window.__ackFixtureGateControl.release('ack-a'))
  await pageA.waitForFunction(() => window.__ackPromiseSettled === true)
  const finalA = await pageA.evaluate(() => window.__ackFixtureModules.storage.loadSessionFromDB('fixture', 'scope-a'))
  const finalB = await pageB.evaluate(() => window.__ackFixtureModules.storage.loadSessionFromDB('fixture', 'scope-b'))
  assertFixture(finalA?.messages?.some(message => message.content === 'A committed'), 'Final A snapshot lost the committed message')
  assertFixture(!finalB?.messages?.some(message => message.content === 'A committed'), 'Final B snapshot was contaminated by A')
  const traceA = await pageA.evaluate(() => window.__ackFixtureGateControl.trace().map(event => event.stage))
  const traceB = await pageB.evaluate(() => window.__ackFixtureReadGateControl.trace().map(event => event.stage))
  assertFixture(JSON.stringify(traceA) === JSON.stringify(['armed', 'matched-save', 'storage-committed-ack-held', 'ack-released']), 'Unexpected A acknowledgement trace: ' + JSON.stringify(traceA))
  assertFixture(JSON.stringify(traceB) === JSON.stringify(['armed', 'matched-read', 'read-resolved-held', 'read-released']), 'Unexpected B read trace: ' + JSON.stringify(traceB))
  assertFixture(pageErrors.A.length === 0 && pageErrors.B.length === 0, 'Browser page error: ' + JSON.stringify(pageErrors))
  console.log(JSON.stringify({
    status: 'passed',
    stage: 'real-browser-a-to-b-to-a-ack-isolation',
    windows: 2,
    scopes: ['scope-a', 'scope-b'],
    providerCalls: 0,
    networkViolations,
    pageErrors
  }))
} finally {
  if (context) await context.close().catch(() => {})
  if (browser) await browser.close().catch(() => {})
  if (server) await new Promise(resolve => server.close(() => resolve()))
  await rm(artifactRoot, { recursive: true, force: true })
}
