import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { validateMemorySamples } from './isolatedCppPreviewExperiment.mjs'
import { startSyntheticResponsesMock } from '../syntheticResponsesMock.mjs'

const phases = ['draft-ready', 'send', 'idle-after-send']
const rendererPid = 4101
const sample = (phase, requestedAt, extra = {}) => ({
  phase, rendererPid, requestedAt, readDurationMs: 20,
  processesKB: [{ pid: rendererPid, type: 'Tab', memory: { workingSetSize: 64 * 1024 } }],
  rendererHeapBytes: { used: 2 * 1024 * 1024 },
  errors: [], ...extra
})
const completeSamples = () => phases.map((phase, index) => sample(phase, 1000 + index * 250))

test('three measured phases pass and retain gaps, errors, and non-detailed samples', () => {
  const samples = [
    sample('draft-ready', 1000),
    sample('send', 1250),
    sample('send', 1500, { rendererHeapBytes: null, readDurationMs: 80 }),
    { phase: 'send', requestedAt: 2000, readDurationMs: 5000, errors: ['process-unavailable', 'heap-unavailable'] },
    sample('idle-after-send', 3000)
  ]
  const before = structuredClone(samples)
  assert.deepEqual(validateMemorySamples(samples), {
    validRendererSamplesByPhase: { 'draft-ready': 1, send: 2, 'idle-after-send': 1 },
    errorSampleCount: 1,
    maxRequestedGapMs: 1000,
    maxReadDurationMs: 5000
  })
  assert.deepEqual(samples, before)
})

test('empty samples cannot certify an experiment', () => {
  assert.throws(() => validateMemorySamples([]), /Missing valid owned renderer memory samples: draft-ready/)
})

test('a different renderer with valid OS and heap counters cannot stand in for the owned PID', () => {
  const samples = completeSamples()
  samples[1].processesKB = [{ pid: rendererPid + 1, type: 'Tab', memory: { workingSetSize: 128 * 1024 } }]
  assert.throws(() => validateMemorySamples(samples), /Missing valid owned renderer memory samples: send/)
})

test('valid OS samples without detailed heap data fail for the affected phase', () => {
  const samples = completeSamples()
  samples[1].rendererHeapBytes = null
  assert.throws(() => validateMemorySamples(samples), /Missing detailed renderer heap samples: send/)
})

test('each required measurement phase must be present', () => {
  for (const missing of phases) {
    assert.throws(
      () => validateMemorySamples(completeSamples().filter(value => value.phase !== missing)),
      { message: 'Missing valid owned renderer memory samples: ' + missing }
    )
  }
})

test('non-finite or zero working-set readings cannot certify the send phase', () => {
  for (const value of [NaN, Infinity, 0]) {
    const samples = completeSamples()
    samples[1].processesKB[0].memory.workingSetSize = value
    assert.throws(() => validateMemorySamples(samples), /Missing valid owned renderer memory samples: send/)
  }
})

const A = 'data:image/png;base64,QUFB'
const B = 'data:image/png;base64,QkJC'
const digest = value => createHash('sha256').update(value).digest('hex')
const requestBody = images => JSON.stringify({
  input: [
    { role: 'user', content: [{ type: 'input_image', image_url: images[0] }] },
    { role: 'user', content: [
      { type: 'input_text', text: 'Synthetic ordering fixture' },
      ...images.slice(1).map(image_url => ({ type: 'input_image', image_url }))
    ] }
  ]
})
async function post(mock, images) {
  const body = requestBody(images)
  const response = await fetch(mock.baseURL + '/responses', {
    method: 'POST', body, signal: AbortSignal.timeout(5000)
  })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).output[0].content[0].text, 'ok')
  return Buffer.byteLength(body)
}

test('opt-in image hashes preserve ordered A/B/A occurrences across messages', async t => {
  const mock = await startSyntheticResponsesMock({ observeImageHashes: true })
  t.after(() => mock.close())
  const originalBytes = await post(mock, [A, B, A])
  const changedBytes = await post(mock, [B, A, B])
  // These different payloads defeat the former count-and-length-only check.
  assert.equal(originalBytes, changedBytes)
  const observations = mock.observations()
  assert.equal(observations.length, 2)
  assert.equal(observations[0].imageCount, 3)
  assert.deepEqual(observations[0].imageUrlSha256, [digest(A), digest(B), digest(A)])
  assert.deepEqual(observations[1].imageUrlSha256, [digest(B), digest(A), digest(B)])
  assert.notDeepEqual(observations[0].imageUrlSha256, observations[1].imageUrlSha256)
  assert(!JSON.stringify(observations).includes(A))
})

test('hash-enabled observations return detached arrays and records', async t => {
  const mock = await startSyntheticResponsesMock({ observeImageHashes: true })
  t.after(() => mock.close())
  await post(mock, [A, B, A])
  const first = mock.observations()
  const second = mock.observations()
  first[0].imageUrlSha256.splice(0, 3, 'caller-mutated')
  first[0].imageLabels.push('caller-mutated')
  first[0].bytes = -1
  first.push({ imageUrlSha256: ['caller-added'] })
  assert.deepEqual(mock.observations(), second)
  assert.deepEqual(second[0].imageUrlSha256, [digest(A), digest(B), digest(A)])
  assert.notStrictEqual(mock.observations()[0].imageUrlSha256, second[0].imageUrlSha256)
})

test('default mock observation shape stays unchanged without opt-in', async t => {
  const mock = await startSyntheticResponsesMock()
  t.after(() => mock.close())
  const bytes = await post(mock, [A, B, A])
  assert.deepEqual(mock.observations(), [{
    bytes, imageCount: 3, imageLabels: ['unknown', 'unknown', 'unknown']
  }])
  assert.equal(Object.hasOwn(mock.observations()[0], 'imageUrlSha256'), false)
})
