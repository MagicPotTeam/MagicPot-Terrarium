'use strict'

const MODE = process.argv[2]
const NORMAL = 'NORMAL'
const MALFORMED = 'MALFORMED'
const WAITEXIT = 'WAITEXIT'
const JOB_ID = '0123456789abcdef0123456789abcdef'
const PROTOCOL = 'magicpot-document-text/v1'
const RESULT = JSON.stringify({
  protocol: PROTOCOL,
  jobId: JOB_ID,
  ok: true,
  format: 'pdf',
  segments: [{ text: 'fixture-known-result', locator: { kind: 'pdf-item', page: 1, item: 0 } }],
  truncated: false,
  warnings: []
})

if (![NORMAL, MALFORMED, WAITEXIT].includes(MODE)) process.exit(91)
if (typeof process.send !== 'function') process.exit(92)

let responded = false
let acknowledged = false

const finish = () => {
  if (acknowledged) return
  acknowledged = true
  if (typeof process.disconnect === 'function' && process.connected) process.disconnect()
  process.exitCode = 0
}

process.on('message', (message) => {
  if (typeof message !== 'string') return
  if (!responded) {
    responded = true
    if (MODE === MALFORMED) process.send('fixture-malformed-frame')
    else process.send(RESULT)
    return
  }
  if (message === 'ACK') finish()
})

if (MODE === WAITEXIT) {
  // The test owns termination for this fixed fixture mode; no timer or open file is used.
}
