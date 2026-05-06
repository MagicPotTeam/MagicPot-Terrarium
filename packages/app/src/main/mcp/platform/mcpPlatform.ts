import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import {
  type McpAuditEntry,
  type McpCapabilitySource,
  type McpHealthSnapshot,
  type McpNegotiationSnapshot,
  type McpPermissionContext,
  type McpPermissionDecision,
  type McpTransportSnapshot
} from '@shared/agent/mcpPlatform'
import { McpCapabilityRegistry } from './capabilityRegistry'
import { McpPlatformLifecycle } from './lifecycle'
import { createMagicPotMcpServerBundle } from './transports'

export type MagicPotMcpPlatformOptions = {
  name: string
  version: string
  permissionPolicy?: (context: McpPermissionContext) => McpPermissionDecision
}

export type MagicPotMcpPlatformTransportState = {
  stdio: McpTransportSnapshot
  streamableHttp?: McpTransportSnapshot
}

export class MagicPotMcpPlatform {
  readonly registry: McpCapabilityRegistry
  readonly lifecycle: McpPlatformLifecycle

  private readonly bundle = createMagicPotMcpServerBundle('magicpot-mcp-platform', '0.0.0')
  private readonly transports: McpTransportSnapshot[] = []
  private readonly auditTrail: McpAuditEntry[] = []
  private stdioHandle: Awaited<ReturnType<MagicPotMcpPlatform['bundle']['connectStdio']>> | null =
    null
  private streamableHttpHandle: Awaited<
    ReturnType<MagicPotMcpPlatform['bundle']['connectStreamableHttp']>
  > | null = null

  constructor(
    private readonly options: MagicPotMcpPlatformOptions,
    private readonly permissionPolicy?: MagicPotMcpPlatformOptions['permissionPolicy']
  ) {
    this.registry = new McpCapabilityRegistry({
      name: options.name,
      version: options.version
    })
    this.lifecycle = new McpPlatformLifecycle()
    this.updateTransportSnapshot({
      kind: 'stdio',
      status: 'idle'
    })
    this.registerInspectionSurfaces()
  }

  registerSource(source: McpCapabilitySource): void {
    this.registry.registerSource(source)
  }

  registerSession(session: Parameters<McpCapabilityRegistry['registerSession']>[0]): void {
    this.registry.registerSession(session)
  }

  negotiate(client?: McpNegotiationSnapshot['client']): McpNegotiationSnapshot {
    return this.registry.negotiate(client)
  }

  describeHealth(): McpHealthSnapshot {
    return this.registry.snapshotHealth(this.lifecycle.getState(), [...this.transports])
  }

  listAuditEntries(): McpAuditEntry[] {
    return [...this.auditTrail]
  }

  get server() {
    return this.bundle.server
  }

  appendAudit(entry: McpAuditEntry): void {
    const audit = {
      ...entry,
      metadata: entry.metadata ? { ...entry.metadata } : undefined
    }
    this.auditTrail.push(audit)
    this.registry.appendAudit(audit)
  }

  checkPermission(context: McpPermissionContext): McpPermissionDecision {
    return this.registry.checkPermission(context, this.permissionPolicy)
  }

  updateTransportSnapshot(snapshot: McpTransportSnapshot): void {
    const index = this.transports.findIndex((item) => item.kind === snapshot.kind)
    if (index === -1) {
      this.transports.push(snapshot)
      return
    }

    this.transports[index] = snapshot
  }

  async startStdio(): Promise<void> {
    if (this.stdioHandle) {
      this.updateTransportSnapshot({
        kind: 'stdio',
        status: 'ready'
      })
      return
    }

    this.lifecycle.transition('initializing', 'stdio transport requested')
    this.updateTransportSnapshot({
      kind: 'stdio',
      status: 'starting'
    })
    this.stdioHandle = await this.bundle.connectStdio()
    this.updateTransportSnapshot(this.stdioHandle.snapshot)
    this.lifecycle.transition('ready', 'stdio transport connected')
  }

  async startStreamableHttp(options: { host?: string; port: number; path: string }): Promise<{
    stop(): Promise<void>
    endpoint?: string
  }> {
    this.lifecycle.transition('initializing', 'streamable http transport requested')
    const handle = await this.bundle.connectStreamableHttp({
      ...options,
      sessionIdGenerator: randomUUID
    })
    this.streamableHttpHandle = handle
    this.updateTransportSnapshot(handle.snapshot)
    this.lifecycle.transition('ready', 'streamable http transport connected')
    return {
      endpoint: handle.snapshot.endpoint,
      stop: async () => {
        await handle.stop()
        if (this.streamableHttpHandle === handle) {
          this.streamableHttpHandle = null
        }
        this.updateTransportSnapshot({
          kind: 'streamable-http',
          status: 'stopped',
          ...(handle.snapshot.endpoint ? { endpoint: handle.snapshot.endpoint } : {})
        })
        this.lifecycle.transition('stopped', 'streamable http transport stopped')
      }
    }
  }

  async stop(): Promise<void> {
    if (this.streamableHttpHandle) {
      const handle = this.streamableHttpHandle
      this.streamableHttpHandle = null
      await handle.stop().catch(() => undefined)
      this.updateTransportSnapshot({
        kind: 'streamable-http',
        status: 'stopped',
        ...(handle.snapshot.endpoint ? { endpoint: handle.snapshot.endpoint } : {})
      })
    }

    if (this.stdioHandle) {
      const handle = this.stdioHandle
      this.stdioHandle = null
      await handle.close().catch(() => undefined)
      this.updateTransportSnapshot({
        kind: 'stdio',
        status: 'stopped'
      })
    }

    this.lifecycle.transition('stopped', 'all MCP platform transports stopped')
  }

  private registerInspectionSurfaces(): void {
    this.server.registerTool(
      'platform.health',
      {
        description: 'Return the platform lifecycle, transport, and capability health snapshot.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true
        }
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(this.describeHealth(), null, 2)
          }
        ],
        structuredContent: this.describeHealth()
      })
    )

    this.server.registerTool(
      'platform.audit.list',
      {
        description: 'List the in-memory MCP audit trail.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true
        }
      },
      async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify(this.listAuditEntries(), null, 2)
          }
        ],
        structuredContent: {
          audits: this.listAuditEntries()
        }
      })
    )

    this.server.registerResource(
      'platform.capabilities',
      'magicpot://mcp/platform/capabilities',
      {
        description: 'Canonical capability registry snapshot.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://mcp/platform/capabilities',
            mimeType: 'application/json',
            text: JSON.stringify(this.registry.snapshot(), null, 2)
          }
        ]
      })
    )

    this.server.registerResource(
      'platform.health',
      'magicpot://mcp/platform/health',
      {
        description: 'Current MCP platform health snapshot.',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'magicpot://mcp/platform/health',
            mimeType: 'application/json',
            text: JSON.stringify(this.describeHealth(), null, 2)
          }
        ]
      })
    )

    this.server.registerPrompt(
      'platform.system',
      {
        description: 'Summarize the MagicPot MCP platform for an operator or downstream agent.',
        argsSchema: {
          focus: z.string().optional()
        }
      },
      async (args) => ({
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Summarize the MagicPot MCP platform with focus on: ${args.focus || 'general operations'}`
            }
          }
        ]
      })
    )
  }
}
