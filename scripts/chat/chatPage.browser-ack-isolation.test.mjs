// Isolated real-ChatPage/IndexedDB acknowledgement fixture, INCOMPLETE: fail closed.
// Offline bundle preparation only: never launch a browser or listen on a port here.
// A successful bundle is not an integration-test pass.
import { access, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const result = await build({
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: path.join(root, '__ack_fixture_memory_only__.js'),
  metafile: true,
  write: false,
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
import { __canonicalSaveIdentity } from 'fixture-storage-wrapper';
import { __canonicalReadIdentity } from 'fixture-page-storage-wrapper';
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
  value: Object.freeze({ ChatPage, storage, canonicalIdentityMatches }),
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
// unlisted read/invocation, and the explicitly disabled HTML activation below, are
// sticky violations even if React catches the exception. The fixture is expected
// to fail until an audited contract for this mandatory activation exists.
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
defineService('svcLLMProxy', {
  listAgentJobs: async () => ({ jobs: [] }),
  listAgentProcesses: async () => ({ jobs: [] }),
  listAgentTeamMessages: async () => ({ intents: [] }),
  listAgentArchiveQueries: undefined,
  listAgentInteractions: undefined,
  managedFirstRunPaneRevision: undefined,
  setAgentSkillScope: undefined,
  setAgentHtmlScope: async () => deny('svcLLMProxy.setAgentHtmlScope:disabled')
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
// Offline-prepared mount, never called by this script; do not mount until a complete,
// explicitly allowlisted host exists and global errors/violations are asserted.
// Import execution precedes this entry code; a future browser harness must install
// default-deny network and global-access monitors before evaluating the bundle.
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
// IMPORTANT: the host audit above is only a framework, not an installed or audited
// host facade. Real UI, transport, identity assertion, CAS and interleavings remain
// unimplemented. Never start a browser or print PASS until the required behavioral
// assertions and applicable isolation/security checks are present.
throw Error('INCOMPLETE FIXTURE: real ChatPage host adapter, transport and A→B→A assertions are not implemented; no browser started.')
