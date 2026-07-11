import {
  builtInMagicAgentGraphs,
  type MagicAgentGraphDefinition,
  type MagicAgentGraphListItem,
  type MagicAgentGraphPreflightSnapshot,
  type MagicAgentGraphSourceKind
} from '@shared/magicAgent'
import type { MagicAgentPackageGraphDefinition } from '@shared/magicAgentRuntime'
import type { AgentRouteLike } from '@shared/agent'
import type { MagicAgentPackageStore } from '../package'
import { assertSafeMagicAgentGraphId } from './graphIds'
import type { MagicAgentUserGraphStore } from './userGraphStore'
import {
  createMagicAgentGraphPreflightSnapshot,
  isMagicAgentGraphSafeWithoutExplicitTools,
  type MagicAgentGraphPreflightOptions
} from './graphPreflight'

export type MagicAgentGraphCatalogSource = 'built-in' | 'user' | 'package'

export type MagicAgentGraphCatalogEntry = {
  graph: MagicAgentGraphDefinition
  source: MagicAgentGraphCatalogSource
  builtIn: boolean
  readOnly: boolean
  forkable: boolean
  removable: boolean
  runnable: boolean
  safeToRun: boolean
  unavailableReason?: string
  packageId?: string
  packageName?: string
  packageVersion?: string
  contributionId?: string
  contributionTitle?: string
  createdAt?: number
  updatedAt?: number
  preflight: MagicAgentGraphPreflightSnapshot
}

export type MagicAgentGraphCatalogListOptions = MagicAgentGraphPreflightOptions & {
  route?: AgentRouteLike
  includeUserGraphs?: boolean
  includePackageGraphs?: boolean
}

export type MagicAgentGraphCatalogInspectOptions = MagicAgentGraphPreflightOptions & {
  route?: AgentRouteLike
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const catalogSourceToListSourceKind = (
  source: MagicAgentGraphCatalogSource
): MagicAgentGraphSourceKind => (source === 'built-in' ? 'builtIn' : source)

const firstErrorMessage = (preflight: MagicAgentGraphPreflightSnapshot): string | undefined =>
  preflight.issues.find((issue) => issue.severity === 'error')?.message

const toListItem = (entry: MagicAgentGraphCatalogEntry): MagicAgentGraphListItem => ({
  graphId: entry.graph.graphId,
  name: entry.graph.name,
  description: entry.graph.description,
  version: entry.graph.version,
  tags: [...entry.graph.tags],
  nodeCount: entry.graph.nodes.length,
  channelCount: entry.graph.channels.length,
  outputCount: entry.graph.outputs.length,
  builtIn: entry.builtIn,
  sourceKind: catalogSourceToListSourceKind(entry.source),
  readOnly: entry.readOnly,
  forkable: entry.forkable,
  removable: entry.removable,
  runnable: entry.runnable,
  safeToRun: entry.safeToRun,
  ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
  ...(entry.packageId
    ? {
        packageId: entry.packageId,
        sourcePackageId: entry.packageId
      }
    : {}),
  ...(entry.packageName
    ? {
        packageName: entry.packageName,
        sourcePackageName: entry.packageName
      }
    : {}),
  ...(entry.packageVersion
    ? {
        packageVersion: entry.packageVersion,
        sourcePackageVersion: entry.packageVersion
      }
    : {}),
  ...(entry.contributionId ? { contributionId: entry.contributionId } : {}),
  ...(entry.contributionTitle ? { contributionTitle: entry.contributionTitle } : {}),
  ...(entry.createdAt !== undefined ? { createdAt: entry.createdAt } : {}),
  ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
  preflight: clone(entry.preflight)
})

const isPackageGraph = (
  graph: MagicAgentGraphDefinition | MagicAgentPackageGraphDefinition
): graph is MagicAgentPackageGraphDefinition => 'sourcePackageId' in graph

export class MagicAgentGraphCatalogService {
  private readonly builtInGraphs: MagicAgentGraphDefinition[]
  private readonly userGraphStore?: MagicAgentUserGraphStore
  private readonly packageStore?: MagicAgentPackageStore

  constructor(
    options: {
      builtInGraphs?: MagicAgentGraphDefinition[]
      userGraphStore?: MagicAgentUserGraphStore
      packageStore?: MagicAgentPackageStore
    } = {}
  ) {
    this.builtInGraphs = options.builtInGraphs || builtInMagicAgentGraphs
    this.userGraphStore = options.userGraphStore
    this.packageStore = options.packageStore
  }

  async listEntries(
    options: MagicAgentGraphCatalogListOptions = {}
  ): Promise<MagicAgentGraphCatalogEntry[]> {
    const entries: MagicAgentGraphCatalogEntry[] = []
    for (const graph of this.builtInGraphs) {
      entries.push(this.createEntry(graph, 'built-in', options))
    }

    if (this.userGraphStore && options.includeUserGraphs !== false) {
      for (const record of await this.userGraphStore.listRecords({
        ...(options.route ? { route: options.route } : { includeAllRoutes: true })
      })) {
        entries.push(
          this.createEntry(record.graph, 'user', options, {
            createdAt: record.createdAt,
            updatedAt: record.updatedAt
          })
        )
      }
    }

    if (this.packageStore && options.includePackageGraphs !== false) {
      const listGraphs = this.packageStore.listGraphs?.bind(this.packageStore)
      if (listGraphs) {
        for (const graph of await listGraphs()) {
          entries.push(this.createEntry(graph, 'package', options))
        }
      }
    }

    return this.mergeEntries(entries)
  }

  async list(options: MagicAgentGraphCatalogListOptions = {}): Promise<MagicAgentGraphListItem[]> {
    return (await this.listEntries(options)).map(toListItem)
  }

  async inspect(
    graphId: string,
    options: MagicAgentGraphCatalogInspectOptions = {}
  ): Promise<MagicAgentGraphCatalogEntry | undefined> {
    const normalizedGraphId = assertSafeMagicAgentGraphId(graphId)
    const entries = await this.listEntries(options)
    return entries.find((entry) => entry.graph.graphId === normalizedGraphId)
  }

  async resolveRunnableGraph(
    graphId: string,
    options: MagicAgentGraphCatalogInspectOptions & { requireSafe?: boolean } = {}
  ): Promise<MagicAgentGraphDefinition> {
    const entry = await this.inspect(graphId, options)
    if (!entry) {
      throw new Error(`MagicAgentGraph "${graphId}" does not exist.`)
    }
    if (!entry.runnable) {
      throw new Error(entry.unavailableReason || `MagicAgentGraph "${graphId}" is not runnable.`)
    }
    if (options.requireSafe !== false && !entry.preflight.safeToRun) {
      throw new Error(
        firstErrorMessage(entry.preflight) || `MagicAgentGraph "${graphId}" failed preflight.`
      )
    }
    return clone(entry.graph)
  }

  private mergeEntries(entries: MagicAgentGraphCatalogEntry[]): MagicAgentGraphCatalogEntry[] {
    const byId = new Map<string, MagicAgentGraphCatalogEntry>()
    const priority: Record<MagicAgentGraphCatalogSource, number> = {
      'built-in': 0,
      user: 1,
      package: 2
    }
    for (const entry of entries) {
      const existing = byId.get(entry.graph.graphId)
      if (!existing || priority[entry.source] < priority[existing.source]) {
        byId.set(entry.graph.graphId, entry)
      }
    }
    return [...byId.values()].sort((left, right) =>
      left.graph.graphId.localeCompare(right.graph.graphId)
    )
  }

  private createEntry(
    graphInput: MagicAgentGraphDefinition | MagicAgentPackageGraphDefinition,
    source: MagicAgentGraphCatalogSource,
    options: MagicAgentGraphPreflightOptions,
    timestamps: { createdAt?: number; updatedAt?: number } = {}
  ): MagicAgentGraphCatalogEntry {
    const graph = clone(graphInput)
    assertSafeMagicAgentGraphId(graph.graphId)
    const preflight = createMagicAgentGraphPreflightSnapshot(graph, options)
    const packageGraph = isPackageGraph(graphInput) ? graphInput : undefined
    const packageRunnable = packageGraph ? packageGraph.runnable !== false : true
    const packageUnavailable = packageGraph?.unavailableReason
    const safeWithoutExplicitTools = isMagicAgentGraphSafeWithoutExplicitTools(graph)
    const runnable =
      source === 'package'
        ? Boolean(packageRunnable && (preflight.safeToRun || safeWithoutExplicitTools))
        : preflight.safeToRun ||
          safeWithoutExplicitTools ||
          source === 'built-in' ||
          source === 'user'
    const unavailableReason = !runnable
      ? packageUnavailable ||
        firstErrorMessage(preflight) ||
        `MagicAgentGraph "${graph.graphId}" failed preflight.`
      : undefined

    return {
      graph,
      source,
      builtIn: source === 'built-in',
      readOnly: source !== 'user',
      forkable: source !== 'user',
      removable: source === 'user',
      runnable,
      safeToRun: preflight.safeToRun,
      ...(unavailableReason ? { unavailableReason } : {}),
      ...(packageGraph ? { packageId: packageGraph.sourcePackageId } : {}),
      ...(packageGraph ? { packageName: packageGraph.sourcePackageName } : {}),
      ...(packageGraph ? { packageVersion: packageGraph.sourcePackageVersion } : {}),
      ...(packageGraph ? { contributionId: packageGraph.contributionId } : {}),
      ...(packageGraph?.contributionTitle
        ? { contributionTitle: packageGraph.contributionTitle }
        : {}),
      ...(timestamps.createdAt !== undefined ? { createdAt: timestamps.createdAt } : {}),
      ...(timestamps.updatedAt !== undefined ? { updatedAt: timestamps.updatedAt } : {}),
      preflight
    }
  }
}
