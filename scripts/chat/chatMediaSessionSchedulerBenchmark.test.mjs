import assert from 'node:assert/strict'
import test from 'node:test'

const SESSION_COUNT = 6
const TASKS_PER_SESSION = 8
const GLOBAL_LIMIT = 3
const SESSION_LIMIT = 2

function createMediaScheduler({ globalLimit, sessionLimit, onStart, onComplete }) {
  const queue = []
  const activeBySession = new Map()
  let activeTotal = 0
  let pumping = false

  const pump = () => {
    if (pumping) return
    pumping = true
    try {
      let started = true
      while (activeTotal < globalLimit && started) {
        started = false
        const index = queue.findIndex(
          (entry) => (activeBySession.get(entry.sessionId) || 0) < sessionLimit
        )
        if (index < 0) break
        const [entry] = queue.splice(index, 1)
        activeTotal += 1
        activeBySession.set(entry.sessionId, (activeBySession.get(entry.sessionId) || 0) + 1)
        started = true
        void (async () => {
          onStart(entry)
          await entry.run()
          onComplete(entry)
          activeTotal -= 1
          const sessionActive = activeBySession.get(entry.sessionId) - 1
          if (sessionActive === 0) activeBySession.delete(entry.sessionId)
          else activeBySession.set(entry.sessionId, sessionActive)
          pump()
        })()
      }
    } finally {
      pumping = false
    }
  }

  return {
    enqueue(sessionId, taskId, run) {
      return new Promise((resolve, reject) => {
        queue.push({ sessionId, taskId, run: async () => {
          try {
            resolve(await run())
          } catch (error) {
            reject(error)
            throw error
          }
        } })
        pump()
      })
    }
  }
}

function createDeterministicGeneration(sessionId, taskId) {
  const workUnits = 1 + ((sessionId * 3 + taskId) % 4)
  return async () => {
    for (let step = 0; step < workUnits; step += 1) await Promise.resolve()
    return { sessionId, taskId, workUnits, status: 'completed' }
  }
}

test('six concurrent chat sessions respect global and per-session media limits', async () => {
  const events = []
  const activeBySession = new Map()
  let activeTotal = 0
  let maxActiveTotal = 0
  const maxActiveBySession = new Map()
  const scheduler = createMediaScheduler({
    globalLimit: GLOBAL_LIMIT,
    sessionLimit: SESSION_LIMIT,
    onStart: ({ sessionId, taskId }) => {
      activeTotal += 1
      activeBySession.set(sessionId, (activeBySession.get(sessionId) || 0) + 1)
      maxActiveTotal = Math.max(maxActiveTotal, activeTotal)
      maxActiveBySession.set(
        sessionId,
        Math.max(maxActiveBySession.get(sessionId) || 0, activeBySession.get(sessionId))
      )
      events.push(`start:${sessionId}:${taskId}`)
    },
    onComplete: ({ sessionId, taskId }) => {
      events.push(`complete:${sessionId}:${taskId}`)
      activeTotal -= 1
      const remaining = activeBySession.get(sessionId) - 1
      if (remaining === 0) activeBySession.delete(sessionId)
      else activeBySession.set(sessionId, remaining)
    }
  })

  const jobs = Array.from({ length: SESSION_COUNT }, (_, sessionId) =>
    Array.from({ length: TASKS_PER_SESSION }, (_, taskId) =>
      scheduler.enqueue(sessionId, taskId, createDeterministicGeneration(sessionId, taskId))
    )
  )
  const results = (await Promise.all(jobs.flat())).sort(
    (left, right) => left.sessionId - right.sessionId || left.taskId - right.taskId
  )

  assert.equal(results.length, SESSION_COUNT * TASKS_PER_SESSION)
  assert.ok(results.every((result) => result.status === 'completed'))
  assert.equal(new Set(results.map((result) => `${result.sessionId}:${result.taskId}`)).size, results.length)
  assert.equal(maxActiveTotal, GLOBAL_LIMIT)
  assert.ok([...maxActiveBySession.values()].every((value) => value <= SESSION_LIMIT))
  assert.equal(maxActiveBySession.size, SESSION_COUNT)
  assert.ok(new Set(events.filter((event) => event.startsWith('start:')).map((event) => event.split(':')[1])).size === SESSION_COUNT)
  assert.equal(activeTotal, 0)
  assert.equal(activeBySession.size, 0)
})

test('production benchmark exports deterministic decodable PNG fixture', async () => {
  const benchmark = await import('./chatImageMemoryBenchmark.mjs')
  const png = benchmark.createDeterministicPng(6, 8, 8)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(png.readUInt32BE(16), 8)
  assert.equal(png.readUInt32BE(20), 8)
})
