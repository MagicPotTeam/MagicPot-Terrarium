import type {
  AgentConfigActivateRequest,
  AgentConfigRollbackRequest,
  AgentConfigCreateRequest,
  AgentConfigVersionResult,
  AgentConfigStageRequest,
  AgentInstanceCreateChildRequest,
  AgentTeamCreateRequest,
  AgentTeamAddMemberRequest,
  AgentTeamRemoveRequest,
  AgentTeamRemoveMemberRequest,
  AgentTeamReplaceRequest,
  AgentTeamLifecycleRequest,
  AgentTeamStartRequest,
  AgentTeamLifecycleResult,
  AgentTeamResource,
  AgentInstanceCreateRootRequest,
  AgentInstancePauseResumeRequest,
  AgentInstanceReplaceRequest,
  AgentInstanceRemoveRequest,
  AgentInstanceResource,
  AgentInstanceStartRequest,
  AgentInstanceStopRequest,
  AgentRunRequest,
  AgentRunResult,
  DriveCreateRequest,
  DriveProgressRequest,
  DriveResource,
  DriveTransitionRequest,
  DriveRetryDeliveryRequest,
  DriveTransferRequest,
  DriveSetLinksRequest,
  JsonValue,
  GraphV2GetRequest,
  GraphV2GetResult,
  GraphV2ListPublishedResult,
  GraphV2NodeRegistryResult,
  GraphV2PublishedGetRequest,
  GraphV2PublishResult,
  GraphV2SaveRequest,
  GraphV2SaveResult,
  GraphRunAttachRequest,
  GraphRunRequest,
  GraphRunResult,
  GraphRunCancelRequest,
  GraphRunCancelResult,
  GraphRunControlRequest,
  GraphRunPauseResult,
  GraphRunResumeResult,
  GraphRunPendingInputMutationRequest,
  GraphRunInjectPendingInputRequest,
  GraphRunEditPendingInputRequest,
  GraphRunPendingInputMutationResult,
  MagicAgentGraphRunPublicEvent,
  RuntimeChannelAcknowledgeRequest,
  RuntimeChannelClaimRequest,
  RuntimeChannelPublishRequest,
  RuntimeChannelPublishResult,
  RuntimeChannelDelivery,
  RuntimeChannelCreateRequest,
  RuntimeChannelJoinRequest,
  RuntimeChannelLeaveRequest,
  RuntimeChannelResource,
  RuntimeChannelUnwireRequest,
  RuntimeChannelWireRequest,
  RuntimeChannelWireResource,
  TriggerControlRequest,
  TriggerCreateRequest,
  TriggerEmitRequest,
  TriggerManualFireRequest,
  TriggerResource,
  TriggerUpdateRequest,
  SessionForkRequest,
  SessionForkResult,
  SessionExportRequest,
  SessionExportResult,
  SessionDiffRequest,
  SessionDiffResult,
  SemanticMemorySearchRequest,
  SemanticMemorySearchResult,
  SemanticMemoryInspectRequest,
  SemanticMemoryInspectResult,
  SemanticMemoryDeleteRequest,
  SemanticMemorySetDisabledRequest,
  SemanticMemorySetVisibilityRequest,
  SemanticMemoryClearScopeRequest,
  SemanticMemoryAdminResult,
  SemanticMemoryRebuildRequest,
  SemanticMemoryRebuildJob,
  SemanticMemoryIngestSessionRequest,
  SemanticMemoryIngestScopeRequest,
  SemanticMemoryAgentSessionRequest,
  SemanticMemoryAgentSessionLink,
  SemanticMemoryIngestResult
} from './contracts.js'

export interface AgentTransport {
  request(method: string, payload: JsonValue): Promise<JsonValue>
  stream?(method: string, payload: JsonValue, signal?: AbortSignal): AsyncIterable<JsonValue>
}

export class MagicAgentClient {
  constructor(private readonly transport: AgentTransport) {}

  async saveGraphV2(request: GraphV2SaveRequest): Promise<GraphV2SaveResult> {
    return (await this.transport.request(
      'graph.v2.save',
      request as unknown as JsonValue
    )) as unknown as GraphV2SaveResult
  }

  async getGraphV2(request: GraphV2GetRequest): Promise<GraphV2GetResult> {
    return (await this.transport.request(
      'graph.v2.get',
      request as unknown as JsonValue
    )) as unknown as GraphV2GetResult
  }

  async publishGraphV2(request: GraphV2GetRequest): Promise<GraphV2PublishResult> {
    return (await this.transport.request(
      'graph.v2.publish',
      request as unknown as JsonValue
    )) as unknown as GraphV2PublishResult
  }

  async getPublishedGraphV2(request: GraphV2PublishedGetRequest): Promise<GraphV2GetResult> {
    return (await this.transport.request(
      'graph.v2.published.get',
      request as unknown as JsonValue
    )) as unknown as GraphV2GetResult
  }

  async listPublishedGraphsV2(request: GraphV2GetRequest): Promise<GraphV2ListPublishedResult> {
    return (await this.transport.request(
      'graph.v2.published.list',
      request as unknown as JsonValue
    )) as unknown as GraphV2ListPublishedResult
  }

  async listGraphV2NodeRegistry(): Promise<GraphV2NodeRegistryResult> {
    return (await this.transport.request(
      'graph.v2.nodeRegistry.list',
      {}
    )) as unknown as GraphV2NodeRegistryResult
  }

  async searchSemanticMemory(
    request: SemanticMemorySearchRequest
  ): Promise<SemanticMemorySearchResult> {
    return this.transport.request(
      'memory.search',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemorySearchResult>
  }
  async inspectSemanticMemory(
    request: SemanticMemoryInspectRequest
  ): Promise<SemanticMemoryInspectResult> {
    return this.transport.request(
      'memory.inspect',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryInspectResult>
  }
  async deleteSemanticMemory(
    request: SemanticMemoryDeleteRequest
  ): Promise<SemanticMemoryAdminResult> {
    return this.transport.request(
      'memory.delete',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAdminResult>
  }
  async setSemanticMemoryDisabled(
    request: SemanticMemorySetDisabledRequest
  ): Promise<SemanticMemoryAdminResult> {
    return this.transport.request(
      'memory.setDisabled',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAdminResult>
  }
  async setSemanticMemoryVisibility(
    request: SemanticMemorySetVisibilityRequest
  ): Promise<SemanticMemoryAdminResult> {
    return this.transport.request(
      'memory.setVisibility',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAdminResult>
  }
  async clearSemanticMemoryScope(
    request: SemanticMemoryClearScopeRequest
  ): Promise<SemanticMemoryAdminResult> {
    return this.transport.request(
      'memory.clearScope',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAdminResult>
  }
  async rebuildSemanticMemory(
    request: SemanticMemoryRebuildRequest
  ): Promise<SemanticMemoryRebuildJob> {
    return this.transport.request(
      'memory.rebuild',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryRebuildJob>
  }
  async ingestSessionMemory(
    request: SemanticMemoryIngestSessionRequest
  ): Promise<SemanticMemoryIngestResult> {
    return this.transport.request(
      'memory.ingestSession',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryIngestResult>
  }
  async ingestSemanticMemoryScope(
    request: SemanticMemoryIngestScopeRequest
  ): Promise<SemanticMemoryIngestResult> {
    return this.transport.request(
      'memory.ingestScope',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryIngestResult>
  }
  async linkSemanticMemoryAgentSession(
    request: SemanticMemoryAgentSessionRequest
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    return this.transport.request(
      'memory.linkAgentSession',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAgentSessionLink[]>
  }
  async unlinkSemanticMemoryAgentSession(
    request: SemanticMemoryAgentSessionRequest
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    return this.transport.request(
      'memory.unlinkAgentSession',
      request as unknown as JsonValue
    ) as unknown as Promise<SemanticMemoryAgentSessionLink[]>
  }
  async listSemanticMemoryAgentSessions(
    agentId: string
  ): Promise<SemanticMemoryAgentSessionLink[]> {
    return this.transport.request('memory.listAgentSessions', {
      agentId
    } as JsonValue) as unknown as Promise<SemanticMemoryAgentSessionLink[]>
  }

  async exportSession(request: SessionExportRequest): Promise<SessionExportResult> {
    return (await this.transport.request(
      'session.export',
      request as unknown as JsonValue
    )) as unknown as SessionExportResult
  }

  async diffSessions(request: SessionDiffRequest): Promise<SessionDiffResult> {
    return (await this.transport.request(
      'session.diff',
      request as unknown as JsonValue
    )) as unknown as SessionDiffResult
  }

  async forkSessionAtEvent(request: SessionForkRequest): Promise<SessionForkResult> {
    return (await this.transport.request(
      'session.fork',
      request as unknown as JsonValue
    )) as unknown as SessionForkResult
  }

  async injectPendingInput(
    request: GraphRunInjectPendingInputRequest
  ): Promise<GraphRunPendingInputMutationResult> {
    return this.transport.request(
      'graphRun.input.inject',
      request as unknown as JsonValue
    ) as unknown as Promise<GraphRunPendingInputMutationResult>
  }

  async editPendingInput(
    request: GraphRunEditPendingInputRequest
  ): Promise<GraphRunPendingInputMutationResult> {
    return this.transport.request(
      'graphRun.input.edit',
      request as unknown as JsonValue
    ) as unknown as Promise<GraphRunPendingInputMutationResult>
  }

  async cancelPendingInput(
    request: GraphRunPendingInputMutationRequest
  ): Promise<GraphRunPendingInputMutationResult> {
    return this.transport.request(
      'graphRun.input.cancel',
      request as unknown as JsonValue
    ) as unknown as Promise<GraphRunPendingInputMutationResult>
  }

  async runGraph(request: GraphRunRequest): Promise<GraphRunResult> {
    return (await this.transport.request(
      'graph.run',
      request as unknown as JsonValue
    )) as unknown as GraphRunResult
  }

  async pauseGraphRun(request: GraphRunControlRequest): Promise<GraphRunPauseResult> {
    return (await this.transport.request(
      'graphRun.pause',
      request as unknown as JsonValue
    )) as unknown as GraphRunPauseResult
  }

  async resumeGraphRun(request: GraphRunControlRequest): Promise<GraphRunResumeResult> {
    return (await this.transport.request(
      'graphRun.resume',
      request as unknown as JsonValue
    )) as unknown as GraphRunResumeResult
  }

  async cancelGraphRun(request: GraphRunCancelRequest): Promise<GraphRunCancelResult> {
    return (await this.transport.request(
      'graphRun.cancel',
      request as unknown as JsonValue
    )) as unknown as GraphRunCancelResult
  }

  attachGraphRun(
    request: GraphRunAttachRequest,
    signal?: AbortSignal
  ): AsyncIterable<MagicAgentGraphRunPublicEvent> {
    if (!this.transport.stream) throw new Error('This transport does not support streaming.')
    return this.transport.stream(
      'graphRun.attach',
      request as unknown as JsonValue,
      signal
    ) as AsyncIterable<MagicAgentGraphRunPublicEvent>
  }

  async run<Input extends JsonValue, Output extends JsonValue>(
    request: AgentRunRequest<Input>
  ): Promise<AgentRunResult<Output>> {
    return (await this.transport.request(
      'agent.run',
      request as unknown as JsonValue
    )) as unknown as AgentRunResult<Output>
  }

  async listRuntimeChannels(): Promise<RuntimeChannelResource[]> {
    return (
      (await this.transport.request('channel.list', {})) as unknown as {
        channels: RuntimeChannelResource[]
      }
    ).channels
  }
  async getRuntimeChannel(channelId: string): Promise<RuntimeChannelResource | undefined> {
    return (
      (await this.transport.request('channel.get', { channelId })) as unknown as {
        channel?: RuntimeChannelResource
      }
    ).channel
  }

  async createRuntimeChannel(
    request: RuntimeChannelCreateRequest
  ): Promise<RuntimeChannelResource> {
    return (
      (await this.transport.request(
        'channel.create',
        request as unknown as JsonValue
      )) as unknown as {
        channel: RuntimeChannelResource
      }
    ).channel
  }

  async joinRuntimeChannel(request: RuntimeChannelJoinRequest): Promise<RuntimeChannelResource> {
    return (
      (await this.transport.request(
        'channel.join',
        request as unknown as JsonValue
      )) as unknown as { channel: RuntimeChannelResource }
    ).channel
  }
  async leaveRuntimeChannel(request: RuntimeChannelLeaveRequest): Promise<RuntimeChannelResource> {
    return (
      (await this.transport.request(
        'channel.leave',
        request as unknown as JsonValue
      )) as unknown as { channel: RuntimeChannelResource }
    ).channel
  }

  async listRuntimeChannelWires(): Promise<RuntimeChannelWireResource[]> {
    return (
      (await this.transport.request('channel.wire.list', {})) as unknown as {
        wires: RuntimeChannelWireResource[]
      }
    ).wires
  }
  async getRuntimeChannelWire(wireId: string): Promise<RuntimeChannelWireResource | undefined> {
    return (
      (await this.transport.request('channel.wire.get', { wireId })) as unknown as {
        wire?: RuntimeChannelWireResource
      }
    ).wire
  }

  async wireRuntimeChannel(
    request: RuntimeChannelWireRequest
  ): Promise<RuntimeChannelWireResource> {
    return (
      (await this.transport.request(
        'channel.wire',
        request as unknown as JsonValue
      )) as unknown as { wire: RuntimeChannelWireResource }
    ).wire
  }
  async unwireRuntimeChannel(
    request: RuntimeChannelUnwireRequest
  ): Promise<RuntimeChannelWireResource> {
    return (
      (await this.transport.request(
        'channel.unwire',
        request as unknown as JsonValue
      )) as unknown as { wire: RuntimeChannelWireResource }
    ).wire
  }

  async publishRuntimeChannelMessage(
    request: RuntimeChannelPublishRequest
  ): Promise<RuntimeChannelPublishResult> {
    return (await this.transport.request(
      'channel.publish',
      request as unknown as JsonValue
    )) as unknown as RuntimeChannelPublishResult
  }

  async claimRuntimeChannelMessage(
    request: RuntimeChannelClaimRequest
  ): Promise<RuntimeChannelDelivery> {
    return (await this.transport.request(
      'channel.claim',
      request as unknown as JsonValue
    )) as unknown as RuntimeChannelDelivery
  }
  async acknowledgeRuntimeChannelMessage(
    request: RuntimeChannelAcknowledgeRequest
  ): Promise<RuntimeChannelDelivery> {
    return (await this.transport.request(
      'channel.ack',
      request as unknown as JsonValue
    )) as unknown as RuntimeChannelDelivery
  }

  async listAgentInstances<State extends JsonValue = JsonValue>(): Promise<
    AgentInstanceResource<State>[]
  > {
    return (
      (await this.transport.request('agentInstance.list', {})) as unknown as {
        instances: AgentInstanceResource<State>[]
      }
    ).instances
  }
  async getAgentInstance<State extends JsonValue = JsonValue>(
    instanceId: string
  ): Promise<AgentInstanceResource<State> | undefined> {
    return (
      (await this.transport.request('agentInstance.get', { instanceId })) as unknown as {
        instance?: AgentInstanceResource<State>
      }
    ).instance
  }
  async createTeam(request: AgentTeamCreateRequest): Promise<AgentTeamResource> {
    return this.transport.request(
      'team.create',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamResource>
  }
  async addTeamMember(request: AgentTeamAddMemberRequest): Promise<AgentTeamResource> {
    return this.transport.request(
      'team.member.add',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamResource>
  }
  async removeTeam(request: AgentTeamRemoveRequest): Promise<AgentTeamResource> {
    return this.transport.request(
      'team.remove',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamResource>
  }
  async removeTeamMember(request: AgentTeamRemoveMemberRequest): Promise<AgentTeamResource> {
    return this.transport.request(
      'team.member.remove',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamResource>
  }

  async replaceTeam(request: AgentTeamReplaceRequest): Promise<AgentTeamLifecycleResult> {
    return this.transport.request(
      'team.replace',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamLifecycleResult>
  }
  async startTeam(request: AgentTeamStartRequest): Promise<AgentTeamLifecycleResult> {
    return this.transport.request(
      'team.start',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamLifecycleResult>
  }
  async pauseTeam(request: AgentTeamLifecycleRequest): Promise<AgentTeamLifecycleResult> {
    return this.transport.request(
      'team.pause',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamLifecycleResult>
  }
  async resumeTeam(request: AgentTeamLifecycleRequest): Promise<AgentTeamLifecycleResult> {
    return this.transport.request(
      'team.resume',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamLifecycleResult>
  }
  async stopTeam(request: AgentTeamLifecycleRequest): Promise<AgentTeamLifecycleResult> {
    return this.transport.request(
      'team.stop',
      request as unknown as JsonValue
    ) as unknown as Promise<AgentTeamLifecycleResult>
  }

  async createRootAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstanceCreateRootRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.createRoot',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async createChildAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstanceCreateChildRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.createChild',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async createAgentConfigVersion(
    request: AgentConfigCreateRequest
  ): Promise<AgentConfigVersionResult> {
    return (await this.transport.request(
      'agentInstance.config.create',
      request as unknown as JsonValue
    )) as unknown as AgentConfigVersionResult
  }
  async stageAgentConfig<State extends JsonValue = JsonValue>(
    request: AgentConfigStageRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.config.stage',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async activateAgentConfig<State extends JsonValue = JsonValue>(
    request: AgentConfigActivateRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.config.activate',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async rollbackAgentConfig<State extends JsonValue = JsonValue>(
    request: AgentConfigRollbackRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.config.rollback',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }

  async pauseAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstancePauseResumeRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.pause',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async resumeAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstancePauseResumeRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.resume',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async startAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstanceStartRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.start',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async stopAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstanceStopRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.stop',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }
  async replaceAgentInstance(request: AgentInstanceReplaceRequest): Promise<AgentInstanceResource> {
    return (await this.transport.request(
      'agentInstance.replace',
      request as unknown as JsonValue
    )) as unknown as AgentInstanceResource
  }
  async removeAgentInstance<State extends JsonValue = JsonValue>(
    request: AgentInstanceRemoveRequest
  ): Promise<AgentInstanceResource<State>> {
    return (
      (await this.transport.request(
        'agentInstance.remove',
        request as unknown as JsonValue
      )) as unknown as { instance: AgentInstanceResource<State> }
    ).instance
  }

  async listDrives<State extends JsonValue = JsonValue>(): Promise<
    readonly DriveResource<State>[]
  > {
    const value = (await this.transport.request('drive.list', {})) as unknown as {
      drives: readonly DriveResource<State>[]
    }
    return value.drives
  }

  async getDrive<State extends JsonValue = JsonValue>(
    driveId: string
  ): Promise<DriveResource<State> | undefined> {
    const value = (await this.transport.request('drive.get', { driveId })) as unknown as {
      drive?: DriveResource<State>
    }
    return value.drive
  }

  async createDrive<State extends JsonValue = JsonValue>(request: DriveCreateRequest) {
    return this.driveMutation<State>('drive.create', request)
  }

  async transitionDrive<State extends JsonValue = JsonValue>(request: DriveTransitionRequest) {
    return this.driveMutation<State>('drive.transition', request)
  }

  async retryDriveDelivery<State extends JsonValue = JsonValue>(
    request: DriveRetryDeliveryRequest
  ) {
    return this.driveMutation<State>('drive.retryDelivery', request)
  }

  async transferDrive<State extends JsonValue = JsonValue>(request: DriveTransferRequest) {
    return this.driveMutation<State>('drive.transfer', request)
  }

  async setDriveLinks<State extends JsonValue = JsonValue>(request: DriveSetLinksRequest) {
    return this.driveMutation<State>('drive.setLinks', request)
  }

  async reportDriveProgress<State extends JsonValue = JsonValue>(request: DriveProgressRequest) {
    return this.driveMutation<State>('drive.reportProgress', request)
  }

  private async driveMutation<State extends JsonValue>(
    method: string,
    request:
      | DriveCreateRequest
      | DriveTransitionRequest
      | DriveRetryDeliveryRequest
      | DriveTransferRequest
      | DriveSetLinksRequest
      | DriveProgressRequest
  ): Promise<DriveResource<State>> {
    const value = (await this.transport.request(
      method,
      request as unknown as JsonValue
    )) as unknown as { drive: DriveResource<State> }
    return value.drive
  }

  async listTriggers<State extends JsonValue = JsonValue>(): Promise<
    readonly TriggerResource<State>[]
  > {
    const value = (await this.transport.request('trigger.list', {})) as unknown as {
      triggers: readonly TriggerResource<State>[]
    }
    return value.triggers
  }

  async getTrigger<State extends JsonValue = JsonValue>(
    triggerId: string
  ): Promise<TriggerResource<State> | undefined> {
    const value = (await this.transport.request('trigger.get', { triggerId })) as unknown as {
      trigger?: TriggerResource<State>
    }
    return value.trigger
  }

  async createTrigger<State extends JsonValue = JsonValue>(
    request: TriggerCreateRequest
  ): Promise<TriggerResource<State>> {
    return this.triggerMutation<State>('trigger.create', request)
  }

  async updateTrigger<State extends JsonValue = JsonValue>(
    request: TriggerUpdateRequest
  ): Promise<TriggerResource<State>> {
    return this.triggerMutation<State>('trigger.update', request)
  }

  async enableTrigger<State extends JsonValue = JsonValue>(request: TriggerControlRequest) {
    return this.triggerMutation<State>('trigger.enable', request)
  }
  async disableTrigger<State extends JsonValue = JsonValue>(request: TriggerControlRequest) {
    return this.triggerMutation<State>('trigger.disable', request)
  }
  async pauseTrigger<State extends JsonValue = JsonValue>(request: TriggerControlRequest) {
    return this.triggerMutation<State>('trigger.pause', request)
  }
  async resumeTrigger<State extends JsonValue = JsonValue>(request: TriggerControlRequest) {
    return this.triggerMutation<State>('trigger.resume', request)
  }
  async retryTrigger<State extends JsonValue = JsonValue>(request: TriggerControlRequest) {
    return this.triggerMutation<State>('trigger.retry', request)
  }

  async emitTriggerEvent(request: TriggerEmitRequest): Promise<number> {
    const value = (await this.transport.request(
      'trigger.emit',
      request as unknown as JsonValue
    )) as unknown as { enqueued: number }
    return value.enqueued
  }

  async manualFireTrigger<State extends JsonValue = JsonValue>(
    request: TriggerManualFireRequest
  ): Promise<TriggerResource<State>> {
    const value = (await this.transport.request(
      'trigger.manualFire',
      request as unknown as JsonValue
    )) as unknown as { occurrence: TriggerResource<State> }
    return value.occurrence
  }

  private async triggerMutation<State extends JsonValue>(
    method: string,
    request: TriggerCreateRequest | TriggerUpdateRequest | TriggerControlRequest
  ): Promise<TriggerResource<State>> {
    const value = (await this.transport.request(
      method,
      request as unknown as JsonValue
    )) as unknown as { trigger: TriggerResource<State> }
    return value.trigger
  }

  async cancel(runId: string): Promise<void> {
    await this.transport.request('agent.cancel', { runId })
  }
}
