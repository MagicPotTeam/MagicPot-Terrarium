// Offline-only controls shared with the incomplete ChatPage acknowledgement fixture.
// This module neither starts a browser nor opens storage or a network connection.
export function createAcknowledgementGate(deny) {
  if (typeof deny !== 'function') throw new TypeError('A sticky deny function is required')
  const fail = (path) => {
    deny(path)
    throw Error(`Fixture deny unexpectedly returned: ${path}`)
  }
  let nextGate = null
  const events = []
  const usedTokens = new Set()

  function arm(scope, id, token) {
    if (nextGate || typeof scope !== 'string' || !scope || typeof id !== 'string' || !id ||
        typeof token !== 'string' || !token || usedTokens.has(token)) {
      return fail('gate:invalid-arm')
    }
    usedTokens.add(token)
    let resume
    const released = new Promise((resolve) => { resume = resolve })
    nextGate = { scope, id, token, released, resume, state: 'armed' }
    events.push({ stage: 'armed', scope, id, token })
  }

  function capture(scope, id) {
    const gate = nextGate
    if (!gate || gate.scope !== scope || gate.id !== id || gate.state !== 'armed') return null
    gate.state = 'in-flight'
    events.push({ stage: 'matched-save', scope, id, token: gate.token })
    return gate
  }

  function cancel(gate) {
    if (!gate) return
    if (gate !== nextGate || gate.state !== 'in-flight') return fail('gate:invalid-cancel')
    events.push({ stage: 'save-rejected', scope: gate.scope, id: gate.id, token: gate.token })
    nextGate = null
  }

  async function hold(gate) {
    if (!gate) return
    if (gate !== nextGate || gate.state !== 'in-flight') return fail('gate:invalid-commit')
    gate.state = 'held'
    events.push({ stage: 'storage-committed-ack-held', scope: gate.scope, id: gate.id, token: gate.token })
    await gate.released
    events.push({ stage: 'ack-released', scope: gate.scope, id: gate.id, token: gate.token })
    if (nextGate !== gate || gate.state !== 'released') return fail('gate:invalid-resume')
    nextGate = null
  }

  function release(token) {
    const gate = nextGate
    if (!gate || gate.state !== 'held' || gate.token !== token) return fail('gate:invalid-release')
    gate.state = 'released'
    gate.resume()
  }

  const control = Object.freeze({ arm, release, trace: () => events.map((event) => ({ ...event })) })
  return Object.freeze({ control, capture, cancel, hold })
}

// Capture the exact armed save before it enters storage, but hold only after the real
// save promise succeeds. A rejected real save is rethrown unchanged, never held/retried.
export function wrapAcknowledgedSave(save, gate) {
  if (typeof save !== 'function' || !gate) throw new TypeError('A save function and gate are required')
  return async (...args) => {
    const [session, scope] = args
    const reservation = gate.capture(scope, session.id)
    let result
    try {
      result = await save(...args)
    } catch (error) {
      try { gate.cancel(reservation) } catch { /* Preserve the actual storage failure. */ }
      throw error
    }
    await gate.hold(reservation)
    return result
  }
}
