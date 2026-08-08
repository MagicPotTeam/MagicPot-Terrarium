import { createHash, timingSafeEqual } from 'node:crypto'
import { getProductionTriggerLifecycle } from '../magicAgentPlatform2/triggers/productionTriggerLifecycle'
import type { ExternalTriggerEvent } from '../magicAgentPlatform2/triggers/externalEventTriggerSource'
import type {
  MagicAgentPlatformCreateChildAgentInstanceReq,
  MagicAgentPlatformCreateRootAgentInstanceReq,
  MagicAgentPlatformJoinRuntimeChannelReq,
  MagicAgentPlatformLeaveRuntimeChannelReq,
  MagicAgentPlatformUnwireRuntimeChannelReq,
  MagicAgentPlatformWireRuntimeChannelReq,
  MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq,
  MagicAgentPlatformClaimRuntimeChannelMessageReq,
  MagicAgentPlatformGetRuntimeChannelWireReq,
  MagicAgentPlatformGetRuntimeChannelReq,
  MagicAgentPlatformGetAgentInstanceReq,
  MagicAgentPlatformRemoveAgentInstanceReq,
  MagicAgentPlatformStartAgentInstanceReq,
  MagicAgentPlatformStopAgentInstanceReq,
  MagicAgentPlatformCreateDriveReq,
  MagicAgentPlatformGetDriveReq,
  MagicAgentPlatformReportDriveProgressReq,
  MagicAgentPlatformTransitionDriveReq,
  MagicAgentPlatformRetryDriveDeliveryReq,
  MagicAgentPlatformTransferDriveReq,
  MagicAgentPlatformSetDriveLinksReq,
  MagicAgentPlatformCreateTriggerReq,
  MagicAgentPlatformGetTriggerReq,
  MagicAgentPlatformManualFireTriggerReq,
  MagicAgentPlatformGraphRunAttachReq,
  MagicAgentPlatformGraphRunReq,
  MagicAgentPlatformGraphV2GetPublishedReq,
  MagicAgentPlatformGraphV2GetReq,
  MagicAgentPlatformGraphV2PublishReq,
  MagicAgentPlatformGraphV2SaveReq,
  MagicAgentPlatformGraphCancelReq,
  MagicAgentPlatformGraphPauseReq,
  MagicAgentPlatformGraphResumeReq,
  MagicAgentPlatformSessionForkReq,
  MagicAgentPlatformSessionExportReq,
  MagicAgentPlatformSessionDiffReq,
  MagicAgentPlatformRunReq,
  MagicAgentPlatformTriggerControlReq,
  MagicAgentPlatformUpdateTriggerReq
} from '@shared/api/svcMagicAgentPlatform'
import type { ServiceInvocationContext } from '@shared/api/apiUtils/serviceInvocation'
import { newAbortHandler } from '@shared/api/apiUtils/abortHandler'
import type { MagicAgentGraphRunPublicEvent } from '@shared/magicAgent/graphTypes'
import type { MagicAgentPlatformSvcImpl } from './svcMagicAgentPlatformImpl'

export type MagicAgentSdkGatewayRequest = {
  method: string
  payload: unknown
  authorization?: string
}

export type MagicAgentSdkGatewayResponse = { status: number; body: unknown }
export type MagicAgentSdkGatewayStreamResponse =
  | MagicAgentSdkGatewayResponse
  | {
      status: 200
      stream: (
        onData: (event: MagicAgentGraphRunPublicEvent) => void,
        signal: AbortSignal
      ) => Promise<void>
    }

const secureEqual = (left: string, right: string): boolean => {
  const leftDigest = createHash('sha256').update(left).digest()
  const rightDigest = createHash('sha256').update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

const bearerToken = (authorization: string | undefined): string | undefined => {
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? '')
  return match?.[1]
}

const validateExternalEvent = (value: unknown): ExternalTriggerEvent => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('trigger.emit payload must be an object.')
  const payload = value as Record<string, unknown>
  const fields = new Set(['source', 'eventId', 'eventName', 'emittedAt', 'payloadDigest'])
  for (const field of Object.keys(payload))
    if (!fields.has(field)) throw new Error(`Unknown trigger.emit field: ${field}.`)
  if (payload.source !== 'sdk' && payload.source !== 'custom')
    throw new Error('trigger.emit source must be sdk or custom.')
  if (typeof payload.eventId !== 'string' || !payload.eventId.trim())
    throw new Error('trigger.emit eventId is required.')
  if (typeof payload.eventName !== 'string' || !payload.eventName.trim())
    throw new Error('trigger.emit eventName is required.')
  if (
    typeof payload.emittedAt !== 'number' ||
    !Number.isFinite(payload.emittedAt) ||
    payload.emittedAt < 0
  )
    throw new Error('trigger.emit emittedAt must be non-negative and finite.')
  if (
    payload.payloadDigest !== undefined &&
    (typeof payload.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(payload.payloadDigest))
  )
    throw new Error('trigger.emit payloadDigest must be SHA-256 hex.')
  return payload as unknown as ExternalTriggerEvent
}

export class MagicAgentSdkGateway {
  constructor(
    private readonly service: Pick<
      MagicAgentPlatformSvcImpl,
      | 'runAgent'
      | 'createRuntimeChannel'
      | 'joinRuntimeChannel'
      | 'leaveRuntimeChannel'
      | 'wireRuntimeChannel'
      | 'unwireRuntimeChannel'
      | 'listRuntimeChannelWires'
      | 'getRuntimeChannelWire'
      | 'publishRuntimeChannelMessage'
      | 'claimRuntimeChannelMessage'
      | 'acknowledgeRuntimeChannelMessage'
      | 'listRuntimeChannels'
      | 'getRuntimeChannel'
      | 'listAgentInstances'
      | 'getAgentInstance'
      | 'createRootAgentInstance'
      | 'createChildAgentInstance'
      | 'pauseAgentInstance'
      | 'resumeAgentInstance'
      | 'replaceAgentInstance'
      | 'createAgentConfigVersion'
      | 'stageAgentConfig'
      | 'activateAgentConfig'
      | 'rollbackAgentConfig'
      | 'startAgentInstance'
      | 'stopAgentInstance'
      | 'removeAgentInstance'
      | 'createTeam'
      | 'addTeamMember'
      | 'removeTeam'
      | 'removeTeamMember'
      | 'replaceTeam'
      | 'startTeam'
      | 'pauseTeam'
      | 'resumeTeam'
      | 'stopTeam'
      | 'listDrives'
      | 'getDrive'
      | 'createDrive'
      | 'transitionDrive'
      | 'reportDriveProgress'
      | 'retryDelivery'
      | 'transferDrive'
      | 'setDriveLinks'
      | 'listTriggers'
      | 'getTrigger'
      | 'createTrigger'
      | 'updateTrigger'
      | 'enableTrigger'
      | 'disableTrigger'
      | 'pauseTrigger'
      | 'resumeTrigger'
      | 'retryTrigger'
      | 'manualFireTrigger'
      | 'attachGraphRun'
      | 'runGraph'
      | 'pauseGraphRun'
      | 'resumeGraphRun'
      | 'saveGraphV2'
      | 'getGraphV2'
      | 'publishGraphV2'
      | 'getPublishedGraphV2'
      | 'listPublishedGraphsV2'
      | 'listGraphV2NodeRegistry'
      | 'cancelGraphRun'
      | 'injectPendingInput'
      | 'editPendingInput'
      | 'cancelPendingInput'
      | 'forkSessionAtEvent'
      | 'exportSession'
      | 'diffSessions'
      | 'searchMemory'
      | 'inspectMemory'
      | 'deleteMemory'
      | 'setMemoryDisabled'
      | 'setMemoryVisibility'
      | 'clearMemoryScope'
      | 'rebuildMemory'
      | 'ingestSessionMemory'
      | 'ingestMemoryScope'
      | 'linkMemoryAgentSession'
      | 'unlinkMemoryAgentSession'
      | 'listMemoryAgentSessions'
    >,
    private readonly token: string,
    private readonly authenticatedActor?: { kind: string; id: string }
  ) {
    if (!token.trim()) throw new Error('MagicAgent SDK gateway token must not be empty.')
    if (
      this.authenticatedActor &&
      (!this.authenticatedActor.kind.trim() || !this.authenticatedActor.id.trim())
    )
      throw new Error('MagicAgent SDK authenticated actor must have non-empty kind and id.')
  }

  preflightAuth(authorization: string | undefined): MagicAgentSdkGatewayResponse | undefined {
    const suppliedToken = bearerToken(authorization)
    if (!suppliedToken || !secureEqual(suppliedToken, this.token))
      return { status: 401, body: { code: 'unauthorized', message: 'Invalid SDK bearer token.' } }
    return undefined
  }

  async dispatchStream(
    request: MagicAgentSdkGatewayRequest
  ): Promise<MagicAgentSdkGatewayStreamResponse> {
    const authFailure = this.preflightAuth(request.authorization)
    if (authFailure) return authFailure
    if (request.method !== 'graphRun.attach')
      return { status: 404, body: { code: 'not_found', message: request.method } }
    if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))
      return {
        status: 400,
        body: { code: 'invalid_request', message: 'graphRun.attach payload must be an object.' }
      }
    const invocation: ServiceInvocationContext = {
      methodName: request.method,
      senderUrl: 'magicpot-sdk://authenticated-client',
      frameUrl: 'magicpot-sdk://authenticated-client',
      isMainFrame: true,
      ...(this.authenticatedActor ? { authenticatedActor: this.authenticatedActor } : {})
    }
    return {
      status: 200,
      stream: async (onData, signal) => {
        const [abortSender, abortReceiver] = newAbortHandler()
        if (signal.aborted) abortSender.abort()
        else signal.addEventListener('abort', abortSender.abort, { once: true })
        await this.service.attachGraphRun(
          request.payload as MagicAgentPlatformGraphRunAttachReq,
          { onData, abortReceiver },
          invocation
        )
      }
    }
  }

  async dispatch(request: MagicAgentSdkGatewayRequest): Promise<MagicAgentSdkGatewayResponse> {
    const authFailure = this.preflightAuth(request.authorization)
    if (authFailure) return authFailure
    const invocation: ServiceInvocationContext = {
      methodName: request.method,
      senderUrl: 'magicpot-sdk://authenticated-client',
      frameUrl: 'magicpot-sdk://authenticated-client',
      isMainFrame: true,
      ...(this.authenticatedActor ? { authenticatedActor: this.authenticatedActor } : {})
    }
    try {
      if (request.method === 'graph.run') {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error('graph.run payload must be an object.')
        const payload = request.payload as Record<string, unknown>
        if ('actor' in payload)
          throw new Error('graph.run actor is derived from authenticated credentials.')
        const allowed = new Set([
          'graphId',
          'input',
          'route',
          'runId',
          'outputIds',
          'nodeExecution',
          'allowedToolNames',
          'metadata'
        ])
        for (const key of Object.keys(payload))
          if (!allowed.has(key)) throw new Error(`graph.run contains unsupported field "${key}".`)
        return {
          status: 200,
          body: await this.service.runGraph(
            payload as unknown as MagicAgentPlatformGraphRunReq,
            invocation
          )
        }
      }
      if (
        request.method === 'graph.v2.save' ||
        request.method === 'graph.v2.get' ||
        request.method === 'graph.v2.publish' ||
        request.method === 'graph.v2.published.get' ||
        request.method === 'graph.v2.published.list' ||
        request.method === 'graph.v2.nodeRegistry.list'
      ) {
        if (request.method === 'graph.v2.nodeRegistry.list') {
          if (
            !request.payload ||
            typeof request.payload !== 'object' ||
            Array.isArray(request.payload) ||
            Object.keys(request.payload).length
          )
            throw new Error('graph.v2.nodeRegistry.list payload must be an empty object.')
          return { status: 200, body: await this.service.listGraphV2NodeRegistry({}, invocation) }
        }
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error(`${request.method} payload must be an object.`)
        const payload = request.payload as Record<string, unknown>
        if ('actor' in payload)
          throw new Error(`${request.method} actor is derived from authenticated credentials.`)
        const allowed = new Set(
          request.method === 'graph.v2.save'
            ? ['graph', 'route', 'replace']
            : request.method === 'graph.v2.published.get'
              ? ['graphId', 'route', 'version']
              : ['graphId', 'route']
        )
        for (const field of Object.keys(payload))
          if (!allowed.has(field)) throw new Error(`Unknown ${request.method} field: ${field}.`)
        if (!payload.route || typeof payload.route !== 'object' || Array.isArray(payload.route))
          throw new Error(`${request.method} route must be an object.`)
        if (request.method === 'graph.v2.save') {
          if (!payload.graph || typeof payload.graph !== 'object' || Array.isArray(payload.graph))
            throw new Error('graph.v2.save graph must be an object.')
          if (payload.replace !== undefined && typeof payload.replace !== 'boolean')
            throw new Error('graph.v2.save replace must be a boolean.')
          return {
            status: 200,
            body: await this.service.saveGraphV2(
              payload as unknown as MagicAgentPlatformGraphV2SaveReq,
              invocation
            )
          }
        }
        if (typeof payload.graphId !== 'string' || !payload.graphId.trim())
          throw new Error(`${request.method} graphId is required.`)
        if (request.method !== 'graph.v2.get') {
          const route = payload.route as Record<string, unknown>
          const routeFields = new Set(['channel', 'scopeType', 'scopeId'])
          for (const field of Object.keys(route))
            if (!routeFields.has(field))
              throw new Error(`Unknown ${request.method} route field: ${field}.`)
          for (const field of routeFields)
            if (typeof route[field] !== 'string' || !(route[field] as string).trim())
              throw new Error(`${request.method} route ${field} is required.`)
        }
        if (request.method === 'graph.v2.publish')
          return {
            status: 200,
            body: await this.service.publishGraphV2(
              payload as unknown as MagicAgentPlatformGraphV2PublishReq,
              invocation
            )
          }
        if (request.method === 'graph.v2.published.get') {
          if (typeof payload.version !== 'string' || !payload.version.trim())
            throw new Error('graph.v2.published.get version is required.')
          return {
            status: 200,
            body: await this.service.getPublishedGraphV2(
              payload as unknown as MagicAgentPlatformGraphV2GetPublishedReq,
              invocation
            )
          }
        }
        if (request.method === 'graph.v2.published.list')
          return {
            status: 200,
            body: await this.service.listPublishedGraphsV2(
              payload as unknown as MagicAgentPlatformGraphV2GetReq,
              invocation
            )
          }
        return {
          status: 200,
          body: await this.service.getGraphV2(
            payload as unknown as MagicAgentPlatformGraphV2GetReq,
            invocation
          )
        }
      }
      const memoryMethods = new Map<string, string>([
        ['memory.search', 'searchMemory'],
        ['memory.inspect', 'inspectMemory'],
        ['memory.delete', 'deleteMemory'],
        ['memory.setDisabled', 'setMemoryDisabled'],
        ['memory.setVisibility', 'setMemoryVisibility'],
        ['memory.clearScope', 'clearMemoryScope'],
        ['memory.rebuild', 'rebuildMemory'],
        ['memory.ingestSession', 'ingestSessionMemory'],
        ['memory.ingestScope', 'ingestMemoryScope'],
        ['memory.linkAgentSession', 'linkMemoryAgentSession'],
        ['memory.unlinkAgentSession', 'unlinkMemoryAgentSession'],
        ['memory.listAgentSessions', 'listMemoryAgentSessions']
      ])
      const memoryMethod = memoryMethods.get(request.method)
      if (memoryMethod) {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error(`${request.method} payload must be an object.`)
        if ('actor' in (request.payload as Record<string, unknown>))
          throw new Error(`${request.method} actor is derived from authenticated credentials.`)
        return {
          status: 200,
          body: await (this.service as any)[memoryMethod](request.payload, invocation)
        }
      }
      if (request.method === 'session.fork') {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error('session.fork payload must be an object.')
        const payload = request.payload as Record<string, unknown>
        const allowed = new Set(['sourceRoute', 'sourceEventId', 'targetRoute', 'idempotencyKey'])
        for (const field of Object.keys(payload)) {
          if (field === 'actor')
            throw new Error('session.fork actor is derived from authenticated credentials.')
          if (!allowed.has(field)) throw new Error(`Unknown session.fork field: ${field}.`)
        }
        return {
          status: 200,
          body: await this.service.forkSessionAtEvent(
            payload as unknown as MagicAgentPlatformSessionForkReq,
            invocation
          )
        }
      }
      if (request.method === 'session.export' || request.method === 'session.diff') {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error(`${request.method} payload must be an object.`)
        const payload = request.payload as Record<string, unknown>
        if ('actor' in payload)
          throw new Error(`${request.method} actor is derived from authenticated credentials.`)
        const allowed = new Set(
          request.method === 'session.export'
            ? ['sourceRoute', 'format']
            : ['leftRoute', 'rightRoute']
        )
        for (const field of Object.keys(payload))
          if (!allowed.has(field)) throw new Error(`Unknown ${request.method} field: ${field}.`)
        const validateRoute = (field: 'sourceRoute' | 'leftRoute' | 'rightRoute'): void => {
          const value = payload[field]
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error(`${request.method} ${field} must be an object.`)
          const route = value as Record<string, unknown>
          const routeFields = new Set(['channel', 'scopeType', 'scopeId'])
          for (const key of Object.keys(route))
            if (!routeFields.has(key))
              throw new Error(`Unknown ${request.method} ${field} field: ${key}.`)
          for (const key of routeFields)
            if (typeof route[key] !== 'string' || !(route[key] as string).trim())
              throw new Error(`${request.method} ${field} ${key} is required.`)
        }
        if (request.method === 'session.export') {
          validateRoute('sourceRoute')
          if (!['markdown', 'html', 'jsonl'].includes(String(payload.format)))
            throw new Error('session.export format must be markdown, html, or jsonl.')
        } else {
          validateRoute('leftRoute')
          validateRoute('rightRoute')
        }
        return {
          status: 200,
          body:
            request.method === 'session.export'
              ? await this.service.exportSession(
                  payload as unknown as MagicAgentPlatformSessionExportReq,
                  invocation
                )
              : await this.service.diffSessions(
                  payload as unknown as MagicAgentPlatformSessionDiffReq,
                  invocation
                )
        }
      }
      if (
        request.method === 'graphRun.input.inject' ||
        request.method === 'graphRun.input.edit' ||
        request.method === 'graphRun.input.cancel'
      ) {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error(`${request.method} payload must be an object.`)
        const payload = request.payload as Record<string, unknown>
        if ('actor' in payload)
          throw new Error(`${request.method} actor is derived from authenticated credentials.`)
        const common = new Set([
          'runId',
          'route',
          'pendingInputId',
          'expectedRevision',
          'idempotencyKey'
        ])
        const allowed = new Set(common)
        if (request.method !== 'graphRun.input.cancel') allowed.add('value')
        for (const field of Object.keys(payload))
          if (!allowed.has(field)) throw new Error(`Unknown ${request.method} field: ${field}.`)
        const method =
          request.method === 'graphRun.input.inject'
            ? 'injectPendingInput'
            : request.method === 'graphRun.input.edit'
              ? 'editPendingInput'
              : 'cancelPendingInput'
        return {
          status: 200,
          body: await this.service[method](payload as never, invocation)
        }
      }
      if (
        request.method === 'graphRun.pause' ||
        request.method === 'graphRun.resume' ||
        request.method === 'graphRun.cancel'
      ) {
        if (
          !request.payload ||
          typeof request.payload !== 'object' ||
          Array.isArray(request.payload)
        )
          throw new Error(`${request.method} payload must be an object.`)
        const payload = request.payload as Record<string, unknown>
        const allowed = new Set(
          request.method === 'graphRun.cancel' ? ['runId', 'route', 'reason'] : ['runId', 'route']
        )
        for (const field of Object.keys(payload)) {
          if (field === 'actor')
            throw new Error(`${request.method} actor is derived from authenticated credentials.`)
          if (!allowed.has(field)) throw new Error(`Unknown ${request.method} field: ${field}.`)
        }
        if (typeof payload.runId !== 'string' || !payload.runId.trim())
          throw new Error(`${request.method} runId is required.`)
        if (!payload.route || typeof payload.route !== 'object' || Array.isArray(payload.route))
          throw new Error(`${request.method} route must be an object.`)
        const route = payload.route as Record<string, unknown>
        const routeFields = new Set(['channel', 'scopeType', 'scopeId'])
        for (const field of Object.keys(route))
          if (!routeFields.has(field))
            throw new Error(`Unknown ${request.method} route field: ${field}.`)
        for (const field of routeFields)
          if (typeof route[field] !== 'string' || !(route[field] as string).trim())
            throw new Error(`${request.method} route ${field} is required.`)
        if (
          payload.reason !== undefined &&
          (typeof payload.reason !== 'string' || !payload.reason.trim())
        )
          throw new Error(`${request.method} reason must be a non-empty string.`)
        if (request.method === 'graphRun.pause')
          return {
            status: 200,
            body: await this.service.pauseGraphRun(
              payload as unknown as MagicAgentPlatformGraphPauseReq,
              invocation
            )
          }
        if (request.method === 'graphRun.resume')
          return {
            status: 200,
            body: await this.service.resumeGraphRun(
              payload as unknown as MagicAgentPlatformGraphResumeReq,
              invocation
            )
          }
        return {
          status: 200,
          body: await this.service.cancelGraphRun(
            payload as unknown as MagicAgentPlatformGraphCancelReq,
            invocation
          )
        }
      }
      if (request.method === 'agent.run') {
        const payload = request.payload as Partial<MagicAgentPlatformRunReq> & {
          input?: { prompt?: unknown }
          sessionId?: unknown
        }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload))
          throw new Error('agent.run payload must be an object.')
        const text =
          typeof payload.text === 'string'
            ? payload.text
            : typeof payload.input === 'object' &&
                payload.input !== null &&
                'prompt' in payload.input
              ? String(payload.input.prompt)
              : ''
        const result = await this.service.runAgent(
          {
            ...(typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {}),
            text,
            route: {
              channel: 'sdk',
              scopeType: 'dm',
              scopeId: typeof payload.sessionId === 'string' ? payload.sessionId : 'external'
            }
          },
          invocation
        )
        const body = {
          runId: result.runId,
          status: result.status,
          output: {
            content: result.content,
            agentId: result.agentId,
            messages: result.messages,
            toolCalls: result.toolCalls,
            events: result.events,
            startedAt: result.startedAt
          }
        }
        return { status: 200, body }
      }
      if (request.method === 'channel.publish') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.publish actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.publishRuntimeChannelMessage(
            request.payload as never,
            invocation
          )
        }
      }
      if (request.method === 'channel.claim') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.claim actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.claimRuntimeChannelMessage(
            request.payload as MagicAgentPlatformClaimRuntimeChannelMessageReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.ack') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.ack actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.acknowledgeRuntimeChannelMessage(
            request.payload as MagicAgentPlatformAcknowledgeRuntimeChannelMessageReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.create') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.create actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.createRuntimeChannel(request.payload as never, invocation)
        }
      }
      if (request.method === 'channel.join') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.join actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.joinRuntimeChannel(
            request.payload as MagicAgentPlatformJoinRuntimeChannelReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.leave') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.leave actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.leaveRuntimeChannel(
            request.payload as MagicAgentPlatformLeaveRuntimeChannelReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.wire') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.wire actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.wireRuntimeChannel(
            request.payload as MagicAgentPlatformWireRuntimeChannelReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.unwire') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('channel.unwire actor is derived from authenticated credentials.')
        return {
          status: 200,
          body: await this.service.unwireRuntimeChannel(
            request.payload as MagicAgentPlatformUnwireRuntimeChannelReq,
            invocation
          )
        }
      }
      if (request.method === 'channel.wire.list')
        return { status: 200, body: await this.service.listRuntimeChannelWires() }
      if (request.method === 'channel.wire.get')
        return {
          status: 200,
          body: await this.service.getRuntimeChannelWire(
            request.payload as MagicAgentPlatformGetRuntimeChannelWireReq
          )
        }
      if (request.method === 'channel.list')
        return { status: 200, body: await this.service.listRuntimeChannels({}) }
      if (request.method === 'channel.get')
        return {
          status: 200,
          body: await this.service.getRuntimeChannel(
            request.payload as MagicAgentPlatformGetRuntimeChannelReq
          )
        }
      if (
        request.method === 'team.create' ||
        request.method === 'team.remove' ||
        request.method === 'team.member.add' ||
        request.method === 'team.member.remove' ||
        request.method === 'team.replace' ||
        request.method === 'team.start' ||
        request.method === 'team.pause' ||
        request.method === 'team.resume' ||
        request.method === 'team.stop'
      ) {
        if (
          request.payload &&
          typeof request.payload === 'object' &&
          ('actor' in request.payload ||
            'ownerId' in request.payload ||
            ('team' in request.payload &&
              request.payload.team &&
              typeof request.payload.team === 'object' &&
              ('ownerId' in request.payload.team || 'createdBy' in request.payload.team)) ||
            ('member' in request.payload &&
              request.payload.member &&
              typeof request.payload.member === 'object' &&
              'addedBy' in request.payload.member))
        )
          throw new Error('Team authority is derived from trusted configuration.')
        const method =
          request.method === 'team.create'
            ? this.service.createTeam
            : request.method === 'team.remove'
              ? this.service.removeTeam
              : request.method === 'team.member.add'
                ? this.service.addTeamMember
                : request.method === 'team.member.remove'
                  ? this.service.removeTeamMember
                  : request.method === 'team.replace'
                    ? this.service.replaceTeam
                    : request.method === 'team.start'
                      ? this.service.startTeam
                      : request.method === 'team.pause'
                        ? this.service.pauseTeam
                        : request.method === 'team.resume'
                          ? this.service.resumeTeam
                          : this.service.stopTeam
        return { status: 200, body: await method(request.payload as never, invocation) }
      }
      if (request.method === 'agentInstance.replace') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('Agent actor is derived from trusted configuration.')
        return {
          status: 200,
          body: await this.service.replaceAgentInstance(request.payload as never, invocation)
        }
      }
      if (request.method === 'agentInstance.pause' || request.method === 'agentInstance.resume') {
        if (request.payload && typeof request.payload === 'object' && 'actor' in request.payload)
          throw new Error('Agent lifecycle actor is derived from trusted configuration.')
        const method =
          request.method === 'agentInstance.pause'
            ? this.service.pauseAgentInstance
            : this.service.resumeAgentInstance
        return { status: 200, body: await method(request.payload as never, invocation) }
      }
      if (request.method === 'agentInstance.config.create') {
        if (
          request.payload &&
          typeof request.payload === 'object' &&
          ('actor' in request.payload ||
            ('config' in request.payload &&
              request.payload.config &&
              typeof request.payload.config === 'object' &&
              ('createdBy' in request.payload.config || 'contentDigest' in request.payload.config)))
        )
          throw new Error('Agent config creator and digest are derived from trusted configuration.')
        return {
          status: 200,
          body: await this.service.createAgentConfigVersion(request.payload as never, invocation)
        }
      }
      if (
        request.method === 'agentInstance.config.stage' ||
        request.method === 'agentInstance.config.activate' ||
        request.method === 'agentInstance.config.rollback'
      ) {
        if (
          request.payload &&
          typeof request.payload === 'object' &&
          ('actor' in request.payload || 'config' in request.payload)
        )
          throw new Error('Agent config actor and content are derived from trusted configuration.')
        const methods = {
          'agentInstance.config.stage': this.service.stageAgentConfig,
          'agentInstance.config.activate': this.service.activateAgentConfig,
          'agentInstance.config.rollback': this.service.rollbackAgentConfig
        } as const
        return {
          status: 200,
          body: await methods[request.method](request.payload as never, invocation)
        }
      }
      if (request.method === 'agentInstance.list')
        return { status: 200, body: await this.service.listAgentInstances({}) }
      if (request.method === 'agentInstance.get')
        return {
          status: 200,
          body: await this.service.getAgentInstance(
            request.payload as MagicAgentPlatformGetAgentInstanceReq
          )
        }
      if (request.method === 'agentInstance.createRoot')
        return {
          status: 200,
          body: await this.service.createRootAgentInstance(
            request.payload as MagicAgentPlatformCreateRootAgentInstanceReq,
            invocation
          )
        }
      if (request.method === 'agentInstance.createChild')
        return {
          status: 200,
          body: await this.service.createChildAgentInstance(
            request.payload as MagicAgentPlatformCreateChildAgentInstanceReq,
            invocation
          )
        }
      if (request.method === 'agentInstance.start')
        return {
          status: 200,
          body: await this.service.startAgentInstance(
            request.payload as MagicAgentPlatformStartAgentInstanceReq,
            invocation
          )
        }
      if (request.method === 'agentInstance.stop')
        return {
          status: 200,
          body: await this.service.stopAgentInstance(
            request.payload as MagicAgentPlatformStopAgentInstanceReq,
            invocation
          )
        }
      if (request.method === 'agentInstance.remove')
        return {
          status: 200,
          body: await this.service.removeAgentInstance(
            request.payload as MagicAgentPlatformRemoveAgentInstanceReq,
            invocation
          )
        }
      if (request.method === 'drive.list')
        return { status: 200, body: await this.service.listDrives({}) }
      if (request.method === 'drive.get')
        return {
          status: 200,
          body: await this.service.getDrive(request.payload as MagicAgentPlatformGetDriveReq)
        }
      if (request.method === 'drive.create')
        return {
          status: 200,
          body: await this.service.createDrive(request.payload as MagicAgentPlatformCreateDriveReq)
        }
      if (request.method === 'drive.transition')
        return {
          status: 200,
          body: await this.service.transitionDrive(
            request.payload as MagicAgentPlatformTransitionDriveReq
          )
        }
      if (request.method === 'drive.retryDelivery')
        return {
          status: 200,
          body: await this.service.retryDelivery(
            request.payload as MagicAgentPlatformRetryDriveDeliveryReq
          )
        }

      if (request.method === 'drive.transfer')
        return {
          status: 200,
          body: await this.service.transferDrive(
            request.payload as MagicAgentPlatformTransferDriveReq
          )
        }
      if (request.method === 'drive.setLinks')
        return {
          status: 200,
          body: await this.service.setDriveLinks(
            request.payload as MagicAgentPlatformSetDriveLinksReq
          )
        }
      if (request.method === 'drive.reportProgress')
        return {
          status: 200,
          body: await this.service.reportDriveProgress(
            request.payload as MagicAgentPlatformReportDriveProgressReq
          )
        }
      if (request.method === 'trigger.list')
        return { status: 200, body: await this.service.listTriggers({}) }
      if (request.method === 'trigger.get')
        return {
          status: 200,
          body: await this.service.getTrigger(request.payload as MagicAgentPlatformGetTriggerReq)
        }
      if (request.method === 'trigger.create')
        return {
          status: 200,
          body: await this.service.createTrigger(
            request.payload as MagicAgentPlatformCreateTriggerReq
          )
        }
      if (request.method === 'trigger.update')
        return {
          status: 200,
          body: await this.service.updateTrigger(
            request.payload as MagicAgentPlatformUpdateTriggerReq
          )
        }
      const controls = {
        'trigger.enable': this.service.enableTrigger,
        'trigger.disable': this.service.disableTrigger,
        'trigger.pause': this.service.pauseTrigger,
        'trigger.resume': this.service.resumeTrigger,
        'trigger.retry': this.service.retryTrigger
      } as const
      if (request.method in controls)
        return {
          status: 200,
          body: await controls[request.method as keyof typeof controls](
            request.payload as MagicAgentPlatformTriggerControlReq
          )
        }
      if (request.method === 'trigger.manualFire')
        return {
          status: 200,
          body: await this.service.manualFireTrigger(
            request.payload as MagicAgentPlatformManualFireTriggerReq
          )
        }
      if (request.method === 'trigger.emit') {
        const payload = validateExternalEvent(request.payload)
        const lifecycle = getProductionTriggerLifecycle()
        if (!lifecycle) throw new Error('Production trigger runtime is unavailable.')
        return {
          status: 200,
          body: { enqueued: lifecycle.runtime.externalEventSource.enqueue(payload) }
        }
      }
      return { status: 404, body: { code: 'method_not_found', message: request.method } }
    } catch (error) {
      return {
        status: 400,
        body: {
          code: 'invalid_request',
          message:
            request.method === 'channel.ack'
              ? 'Runtime Channel acknowledgement failed.'
              : error instanceof Error
                ? error.message
                : String(error)
        }
      }
    }
  }
}
