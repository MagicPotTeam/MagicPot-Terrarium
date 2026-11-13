// Fixture-only application-layer read barrier. It never opens storage or starts a browser.
// A held result was already returned by the real read; this deliberately alters when its
// consumer resumes and must not be described as a native IndexedDB transaction pause.
export function createScopedReadGate(deny) {
  if (typeof deny !== 'function') throw new TypeError('A sticky deny function is required')
  const fail = (path) => {
    deny(path)
    throw Error(`Fixture deny unexpectedly returned: ${path}`)
  }
  let nextGate = null
  const usedTokens = new Set()
  const events = []

  function arm(scope, token) {
    if (nextGate || typeof scope !== 'string' || !scope || typeof token !== 'string' || !token || usedTokens.has(token)) {
      return fail('read:invalid-arm')
    }
    usedTokens.add(token)
    let resume
    const released = new Promise((resolve) => { resume = resolve })
    nextGate = { scope, token, released, resume, state: 'armed', snapshot: null }
    events.push({ stage: 'armed', scope, token })
  }

  function capture(scope) {
    const gate = nextGate
    if (!gate || gate.scope !== scope) return null
    // Never let a second read silently pass as the selected observation while the
    // chosen read is active. An already-running read cannot be captured retroactively.
    if (gate.state !== 'armed') return fail('read:overlap')
    gate.state = 'in-flight'
    events.push({ stage: 'matched-read', scope, token: gate.token })
    return gate
  }

  function cancel(gate) {
    if (!gate) return
    if (gate !== nextGate || gate.state !== 'in-flight') return fail('read:invalid-cancel')
    events.push({ stage: 'read-rejected', scope: gate.scope, token: gate.token })
    nextGate = null
  }

  async function hold(gate, result) {
    if (!gate) return
    if (gate !== nextGate || gate.state !== 'in-flight') return fail('read:invalid-hold')
    if (!Array.isArray(result)) {
      events.push({ stage: 'read-invalid', scope: gate.scope, token: gate.token })
      nextGate = null
      return fail('read:invalid-result')
    }
    try {
      gate.snapshot = structuredClone(result)
    } catch {
      events.push({ stage: 'read-invalid', scope: gate.scope, token: gate.token })
      nextGate = null
      return fail('read:uncloneable-result')
    }
    gate.state = 'held'
    events.push({ stage: 'read-resolved-held', scope: gate.scope, token: gate.token })
    await gate.released
    if (nextGate !== gate || gate.state !== 'released') return fail('read:invalid-resume')
    events.push({ stage: 'read-released', scope: gate.scope, token: gate.token })
    nextGate = null
  }

  function snapshot(token) {
    const gate = nextGate
    if (!gate || gate.state !== 'held' || gate.token !== token) return fail('read:invalid-snapshot')
    return structuredClone(gate.snapshot)
  }

  function release(token) {
    const gate = nextGate
    if (!gate || gate.state !== 'held' || gate.token !== token) return fail('read:invalid-release')
    gate.state = 'released'
    gate.resume()
  }

  const control = Object.freeze({ arm, snapshot, release, trace: () => events.map((event) => ({ ...event })) })
  return Object.freeze({ control, capture, cancel, hold })
}

// Call the underlying read with identical arguments. Its original result/error is passed
// through, but the matched consumer is deliberately paused after successful completion.
export function wrapScopedRead(read, gate) {
  if (typeof read !== 'function' || !gate) throw new TypeError('A read function and gate are required')
  return async (...args) => {
    const reservation = gate.capture(args[0])
    let result
    try {
      result = await read(...args)
    } catch (error) {
      try { gate.cancel(reservation) } catch { /* Preserve the original read failure. */ }
      throw error
    }
    await gate.hold(reservation, result)
    return result
  }
}
