// Test-only child process. Never uses a real model, native host, account or normal user data.
import fs from 'node:fs'
import path from 'node:path'
import { FigPluginBridgeRuntime } from './bridgeRuntime'
import { SqliteNativeWriteCoordinator } from './nativeWriteCoordinator'
import { binding, context } from './checkpointTestUtils'
import { createHostPlanningPreview } from '@shared/figplugin/hostPlanPreview'
import { createHostPlanReadback, type HostPlan } from '@shared/figplugin/hostPlan'
const [root, number, clock] = process.argv.slice(2)
if (!process.send || !root || !path.basename(root).startsWith('mp-owned-write-process-'))
  throw new Error('Owned test root required')
const now = Number(clock),
  serial = Number(number)
if (!Number.isSafeInteger(now) || !Number.isSafeInteger(serial))
  throw new Error('Invalid owned test input')
const c = structuredClone(context)
c.captureId = serial.toString(16).padStart(32, '0')
c.execution!.visualAudit = 'unavailable'
const plan: HostPlan = {
  schemaVersion: 2,
  kind: 'host-plan',
  captureId: c.captureId,
  steps: [{ command: 'node.rename', targetId: 'owned-node', name: 'Owned result' }]
}
const runtime = new FigPluginBridgeRuntime({
  now: () => now,
  writes: new SqliteNativeWriteCoordinator(path.join(root, 'store'), () => now),
  validateBinding: async () => true,
  allowNativeWrite: () => true,
  invoke: async () => ({
    content: JSON.stringify(createHostPlanningPreview(JSON.stringify(plan), c))
  })
})
const startsEmpty = runtime.listPlanExecutions().length === 0 && runtime.listSessions().length === 0
const effects = new Set<string>()
async function start() {
  const b = { ...binding, pluginId: `owned.worker${serial}`, projectId: `owned-project${serial}` }
  const ticket = await runtime.createPairing(b)
  const session = await runtime.redeem({
    protocol: 1,
    ticketId: ticket.ticketId,
    pairingSecret: ticket.pairingSecret,
    pluginId: b.pluginId,
    host: b.host,
    artifactSha256: b.artifactSha256,
    clientNonce: c.captureId
  })
  const receipt = await runtime.prepare(session.sessionId, session.sessionToken, {
    protocol: 1,
    requestId: c.captureId,
    sequence: 1,
    featureId: 'plan-preview',
    prompt: 'Owned rename',
    hostContext: c,
    context: {
      selectionRevision: c.captureId,
      nodes: [{ id: 'owned-node', type: 'RECTANGLE', name: 'Original', locked: false }]
    }
  })
  const model = runtime.listPreviews()[0]
  await runtime.approve(receipt.callId, model.payloadSha256)
  for (let i = 0; i < 50 && !runtime.listPlanExecutions().length; i++)
    await new Promise((resolve) => setTimeout(resolve, 0))
  const preview = runtime.listPlanExecutions()[0]
  if (!preview) throw new Error('No approved test preview')
  await runtime.approvePlan(preview.executionId, preview.planSha256)
  let claimed: Awaited<ReturnType<FigPluginBridgeRuntime['claimPlan']>> | undefined
  process.on('message', async (command) => {
    try {
      if (command === 'stop') {
        runtime.dispose()
        process.exit(0)
      }
      if (command === 'claim' || command === 'crash') {
        claimed = await runtime.claimPlan(session.sessionId, session.sessionToken, {
          protocol: 1,
          callId: receipt.callId
        })
        if (claimed.status === 'ready' && !effects.has(claimed.intent.actionId)) {
          effects.add(claimed.intent.actionId)
          fs.appendFileSync(path.join(root, 'effects.txt'), `${serial}\n`)
        }
        if (command === 'crash') process.exit(claimed.status === 'ready' ? 73 : 1)
        process.send!({ kind: 'claim', serial, status: claimed.status })
      }
      if (command === 'finish') {
        if (claimed?.status !== 'ready') throw new Error('No test intent')
        const after = structuredClone(c)
        after.nodes[0].name = 'Owned result'
        const result = runtime.planResult(session.sessionId, session.sessionToken, {
          protocol: 1,
          executionId: preview.executionId,
          actionId: claimed.intent.actionId,
          status: 'completed',
          effect: 'applied',
          completed: 1,
          total: 1,
          readback: createHostPlanReadback(c, after, plan)
        })
        process.send!({ kind: 'finished', serial, state: result.status.state })
      }
    } catch (error) {
      process.send!({
        kind: 'failure',
        serial,
        message: error instanceof Error ? error.message : 'failure'
      })
    }
  })
  process.send!({ kind: 'ready', serial, startsEmpty })
}
start().catch((error) => {
  process.send!({ kind: 'failure', serial, message: String(error) })
  runtime.dispose()
  process.exit(1)
})
