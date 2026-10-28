import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createContext, Script } from 'node:vm'

const source = readFileSync(
  new URL('../packages/figplugin-hosts/shared/execution-journal.js', import.meta.url),
  'utf8'
)
const visual = readFileSync(
  new URL('../packages/figplugin-hosts/shared/visual-evidence.js', import.meta.url),
  'utf8'
)
const PREFIX = 'magicpot.figplugin.execution.v1.'
const TTL = 7 * 24 * 60 * 60 * 1000
const plain = (value) => JSON.parse(JSON.stringify(value))
const intent = (index = 1, at = 1000) => ({
  protocol: 1,
  purpose: 'execute-host-plan',
  host: 'figma',
  pluginId: 'owned.figma',
  actionId: index.toString(16).padStart(32, '0'),
  executionId: '2'.repeat(32),
  callId: '3'.repeat(32),
  captureId: '4'.repeat(32),
  planSha256: '5'.repeat(64),
  documentId: 'owned-document',
  scopeId: 'owned-page',
  adapterVersion: 'figma-native-1',
  expiresAt: at + 120000,
  plan: {
    schemaVersion: 2,
    kind: 'host-plan',
    captureId: '4'.repeat(32),
    steps: [{ command: 'node.rename', targetId: '1:2', name: 'PRIVATE-DESIGN-TEXT' }]
  }
})
function module(withTextEncoder = true) {
  const vm = createContext({
    ...(withTextEncoder ? { TextEncoder } : {}),
    Uint8Array,
    setTimeout,
    clearTimeout
  })
  new Script(visual).runInContext(vm)
  new Script(source).runInContext(vm)
  return { vm, api: vm.MagicPotExecutionJournalV1 }
}
function fixture(values = new Map(), hooks = {}) {
  const { api, vm } = module()
  let time = 1000
  const calls = []
  const storage = {
    async read(key) {
      calls.push(['read', key])
      if (hooks.read) await hooks.read(key)
      return values.get(key)
    },
    async write(key, text) {
      calls.push(['write', key])
      if (hooks.write) await hooks.write(key, text)
      values.set(key, text)
      if (hooks.afterWrite) await hooks.afterWrite(key, text)
    },
    async keys() {
      calls.push(['keys'])
      return hooks.keys ? hooks.keys() : [...values.keys()]
    },
    async remove(key) {
      calls.push(['remove', key])
      values.delete(key)
    }
  }
  return {
    api,
    vm,
    values,
    calls,
    storage,
    journal: api.create(storage, () => time),
    advance: (ms) => {
      time += ms
    },
    setTime: (value) => {
      time = value
    }
  }
}
const marker = (index, at = 1000) => ({
  schemaVersion: 1,
  actionId: index.toString(16).padStart(32, '0'),
  fingerprint: 'a'.repeat(64),
  recordedAt: at,
  expiresAt: at + 120000
})

test('journal is lazy, non-writable and stores only bounded action metadata', async () => {
  const f = fixture()
  assert.equal(f.calls.length, 0)
  const input = intent(),
    snapshot = JSON.stringify(input)
  const receipt = await f.journal.reserve(input)
  assert.equal(JSON.stringify(input), snapshot)
  assert.equal(Object.isFrozen(receipt), true)
  const text = f.values.get(PREFIX + input.actionId),
    value = JSON.parse(text)
  assert.deepEqual(Object.keys(value).sort(), [
    'actionId',
    'expiresAt',
    'fingerprint',
    'recordedAt',
    'schemaVersion'
  ])
  assert.ok(Buffer.byteLength(text) <= 512)
  assert.doesNotMatch(text, /PRIVATE|owned-document|owned-page|session|token|steps/)
  const hashInput = [
    input.host,
    input.pluginId,
    input.executionId,
    input.callId,
    input.documentId,
    input.scopeId,
    input.captureId,
    input.adapterVersion,
    input.planSha256,
    input.plan,
    null,
    null
  ]
  assert.equal(
    value.fingerprint,
    createHash('sha256').update(JSON.stringify(hashInput)).digest('hex')
  )
  const original = f.api
  new Script(source).runInContext(f.vm)
  assert.equal(f.vm.MagicPotExecutionJournalV1, original)
  assert.equal(Object.getOwnPropertyDescriptor(f.vm, 'MagicPotExecutionJournalV1').writable, false)
})
test('reconstructed runtime refuses sequential replay without rewriting a reservation', async () => {
  const first = fixture()
  await first.journal.reserve(intent())
  const before = JSON.stringify([...first.values])
  const next = fixture(first.values)
  await assert.rejects(next.journal.reserve(intent()), /JOURNAL_REPLAY/)
  assert.equal(JSON.stringify([...first.values]), before)
  assert.equal(
    next.calls.some(([method]) => method === 'write'),
    false
  )
})
test('an action ID cannot be rebound to changed target, document, plan or correction payload', async () => {
  const f = fixture()
  await f.journal.reserve(intent())
  for (const change of [
    { documentId: 'other-document' },
    { scopeId: 'other-page' },
    { planSha256: '6'.repeat(64) },
    {
      plan: {
        ...intent().plan,
        steps: [{ command: 'node.rename', targetId: '1:2', name: 'Different text' }]
      }
    },
    { visualCorrection: { round: 2 } },
    { visualTargetIds: ['other-target'] }
  ])
    await assert.rejects(f.journal.reserve({ ...intent(), ...change }), /JOURNAL_CONFLICT/)
})
test('two concurrent requests in one runtime reserve an action once', async () => {
  const f = fixture()
  const second = f.api.create(f.storage, () => 1000)
  const result = await Promise.allSettled([f.journal.reserve(intent()), second.reserve(intent())])
  assert.equal(result.filter((value) => value.status === 'fulfilled').length, 1)
  assert.equal(result.filter((value) => value.status === 'rejected').length, 1)
  assert.equal(f.calls.filter(([method]) => method === 'write').length, 1)
})
test('lost storage acknowledgement retains a tombstone and cannot trigger retry execution', async () => {
  const f = fixture(new Map(), {
    afterWrite: () => {
      throw new Error('PRIVATE_FAILURE')
    }
  })
  await assert.rejects(f.journal.reserve(intent()), /^Error: JOURNAL_UNAVAILABLE$/)
  assert.equal(f.values.size, 1)
  await assert.rejects(fixture(f.values).journal.reserve(intent()), /JOURNAL_REPLAY/)
})
for (const stage of ['read', 'write', 'keys'])
  test(`${stage} failure is redacted and denies reservation`, async () => {
    const f = fixture(new Map(), {
      [stage]: () => {
        throw new Error('PRIVATE_FAILURE')
      }
    })
    await assert.rejects(f.journal.reserve(intent()), /^Error: JOURNAL_UNAVAILABLE$/)
    assert.equal(f.values.size, 0)
  })
test('a silently discarded write cannot authorize mutation', async () => {
  const f = fixture()
  const journal = f.api.create({ ...f.storage, write: async () => {} }, () => 1000)
  await assert.rejects(journal.reserve(intent()), /JOURNAL_UNAVAILABLE/)
})
test('cancellation before storage does nothing; cancellation during storage keeps the marker', async () => {
  const before = fixture()
  await assert.rejects(
    before.journal.reserve(intent(), () => {
      throw new Error('CANCELLED')
    }),
    /CANCELLED/
  )
  assert.equal(before.calls.length, 0)
  let cancelled = false
  const during = fixture(new Map(), {
    afterWrite: () => {
      cancelled = true
    }
  })
  await assert.rejects(
    during.journal.reserve(intent(), () => {
      if (cancelled) throw new Error('CANCELLED')
    }),
    /CANCELLED/
  )
  assert.equal(during.values.size, 1)
})
test('expiry during storage refuses mutation despite a persisted marker', async () => {
  let f
  f = fixture(new Map(), { afterWrite: () => f.advance(500) })
  await assert.rejects(f.journal.reserve({ ...intent(), expiresAt: 1500 }), /JOURNAL_INVALID/)
  assert.equal(f.values.size, 1)
})
test('retention removes only expired own markers, never unrelated storage', async () => {
  const expired = marker(2, 1000)
  const values = new Map([
    [PREFIX + expired.actionId, JSON.stringify(expired)],
    ['unrelated-preference', 'PRIVATE-OTHER']
  ])
  const f = fixture(values)
  f.advance(TTL)
  await f.journal.reserve(intent(3, 1000 + TTL))
  assert.equal(values.has(PREFIX + expired.actionId), false)
  assert.equal(values.get('unrelated-preference'), 'PRIVATE-OTHER')
  assert.equal(values.size, 2)
})
test('capacity is fail-closed; active reservations are not evicted', async () => {
  const values = new Map(
    Array.from({ length: 256 }, (_, index) => {
      const value = marker(index + 1)
      return [PREFIX + value.actionId, JSON.stringify(value)]
    })
  )
  const f = fixture(values),
    before = JSON.stringify([...values])
  await assert.rejects(f.journal.reserve(intent(257)), /JOURNAL_FULL/)
  assert.equal(JSON.stringify([...values]), before)
})
for (const raw of [
  '{broken',
  'x'.repeat(513),
  'null',
  JSON.stringify({ ...marker(2), schemaVersion: 2 }),
  JSON.stringify({ ...marker(2), secret: 'PRIVATE' })
]) {
  test(`corrupt reservation blocks new writes without silently resetting the store: ${raw.slice(0, 20)}`, async () => {
    const f = fixture(new Map([[PREFIX + marker(2).actionId, raw]]))
    await assert.rejects(f.journal.reserve(intent()), /JOURNAL_UNAVAILABLE/)
    assert.equal(f.values.size, 1)
    assert.equal(f.values.get(PREFIX + marker(2).actionId), raw)
  })
}
test('enumeration, unknown reserved keys, clock rollback and invalid intent are bounded', async () => {
  for (const keys of [Array(4097).fill('x'), ['duplicate', 'duplicate'], [PREFIX + 'invalid']]) {
    const f = fixture(new Map(), { keys: () => keys })
    await assert.rejects(f.journal.reserve(intent()), /JOURNAL_UNAVAILABLE/)
    assert.equal(f.values.size, 0)
  }
  const future = marker(2, 2000),
    f = fixture(new Map([[PREFIX + future.actionId, JSON.stringify(future)]]))
  await assert.rejects(f.journal.reserve(intent()), /JOURNAL_UNAVAILABLE/)
  for (const changed of [
    { expiresAt: 1000 },
    { expiresAt: 601001 },
    { actionId: '../x' },
    { planSha256: 'x' },
    { documentId: 'x'.repeat(161) }
  ])
    await assert.rejects(fixture().journal.reserve({ ...intent(), ...changed }), /JOURNAL_INVALID/)
})
test('Figma and Photoshop adapters preserve lazy calls and SDK storage isolation', async () => {
  const f = fixture(),
    values = new Map(),
    calls = []
  const figma = {
    async getAsync(key) {
      calls.push('get')
      return values.get(key)
    },
    async setAsync(key, value) {
      calls.push('set')
      values.set(key, value)
    },
    async keysAsync() {
      calls.push('keys')
      return [...values.keys()]
    },
    async deleteAsync(key) {
      values.delete(key)
    }
  }
  const photoshop = {
    get length() {
      return values.size
    },
    key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  }
  const a = f.api.createFigma(figma, () => 1000),
    b = f.api.createPhotoshop(photoshop, () => 1000)
  assert.equal(calls.length, 0)
  await a.reserve(intent())
  await assert.rejects(b.reserve(intent()), /JOURNAL_REPLAY/)
  assert.throws(() => f.api.createFigma({}), /JOURNAL_UNAVAILABLE/)
  assert.throws(() => f.api.createPhotoshop({}), /JOURNAL_UNAVAILABLE/)
})

test('stalled persistence times out; a late storage completion never authorizes mutation', async () => {
  let release, timeout
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const f = fixture(new Map(), { write: () => gate })
  f.vm.setTimeout = (callback) => {
    timeout = callback
    return 1
  }
  f.vm.clearTimeout = () => {}
  const pending = f.journal.reserve(intent())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.calls.at(-1)[0], 'write')
  const rejected = assert.rejects(pending, /JOURNAL_TIMEOUT/)
  timeout()
  await rejected
  assert.equal(f.values.size, 0)
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.values.size, 1, 'a late durable marker remains fail-closed')
  await assert.rejects(fixture(f.values).journal.reserve(intent()), /JOURNAL_REPLAY/)
})

test('real process exit after a synthetic effect retains its reservation; a new process does not replay', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'magicpot-host-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bootstrap = `
    const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
    const root=${JSON.stringify(root)};
    const context=vm.createContext({TextEncoder,Uint8Array,setTimeout,clearTimeout});
    vm.runInContext(${JSON.stringify(visual)},context);
    vm.runInContext(${JSON.stringify(source)},context);
    const storage={
      read:async key=>{try{return fs.readFileSync(path.join(root,key+'.json'),'utf8')}catch(e){if(e.code==='ENOENT')return;throw e}},
      write:async(key,value)=>{const fd=fs.openSync(path.join(root,key+'.json'),'wx',0o600);try{fs.writeFileSync(fd,value);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}},
      keys:async()=>fs.readdirSync(root).filter(x=>x.endsWith('.json')).map(x=>x.slice(0,-5)),
      remove:async key=>fs.unlinkSync(path.join(root,key+'.json'))
    };
    const journal=context.MagicPotExecutionJournalV1.create(storage,()=>1000);
    (async()=>{try{
      await journal.reserve(${JSON.stringify(intent())});
      fs.appendFileSync(path.join(root,'synthetic-effect.txt'),'ONCE');
      process.exit(73);
    }catch(e){if(e.message==='JOURNAL_REPLAY'){console.log('REPLAY_BLOCKED');process.exit(0)}console.error(e.message);process.exit(1)}})();
  `
  // Windows has a relatively small command-line limit. Keep the generated
  // child program in the temporary directory instead of passing both large
  // shared modules through `node -e`.
  const childPath = path.join(root, 'replay-child.cjs')
  writeFileSync(childPath, bootstrap, 'utf8')
  const first = spawnSync(process.execPath, [childPath], { encoding: 'utf8', timeout: 10000 })
  assert.equal(first.status, 73, first.stderr)
  const effect = path.join(root, 'synthetic-effect.txt'),
    record = path.join(root, PREFIX + intent().actionId + '.json')
  const before = {
    effect: readFileSync(effect, 'utf8'),
    record: readFileSync(record, 'utf8'),
    modified: statSync(effect).mtimeMs
  }
  const second = spawnSync(process.execPath, [childPath], {
    encoding: 'utf8',
    timeout: 10000
  })
  assert.equal(second.status, 0, second.stderr)
  assert.match(second.stdout, /REPLAY_BLOCKED/)
  assert.equal(readFileSync(effect, 'utf8'), 'ONCE')
  assert.equal(readFileSync(record, 'utf8'), before.record)
  assert.equal(statSync(effect).mtimeMs, before.modified)
})

test('capacity pressure reclaims only already-expired intents instead of blocking a week of work', async () => {
  const values = new Map(
    Array.from({ length: 256 }, (_, index) => {
      const value = marker(index + 1, index + 1000)
      return [PREFIX + value.actionId, JSON.stringify(value)]
    })
  )
  const f = fixture(values)
  f.setTime(200000)
  await f.journal.reserve(intent(257, 200000))
  assert.equal(values.size, 256)
  assert.equal(values.has(PREFIX + marker(1).actionId), false)
  assert.equal(values.has(PREFIX + marker(2).actionId), true)
  assert.equal(values.has(PREFIX + intent(257).actionId), true)
})

test('journal reserves without TextEncoder and preserves Unicode plan identity', async () => {
  const { api, vm } = module(false)
  const values = new Map()
  const journal = api.create(
    {
      read: async (key) => values.get(key),
      write: async (key, value) => values.set(key, value),
      keys: async () => [...values.keys()],
      remove: async (key) => values.delete(key)
    },
    () => 1000
  )
  const input = intent()
  input.plan.steps[0].name = '原图😀e\u0301'
  const receipt = await journal.reserve(input)
  const expected = fixture()
  await expected.journal.reserve(input)
  assert.equal(receipt.fingerprint, JSON.parse([...expected.values.values()][0]).fingerprint)
  await assert.rejects(() => journal.reserve(input), /JOURNAL_REPLAY/)
  assert.equal(typeof vm.TextEncoder, 'undefined', 'must not install a global shim')
})
