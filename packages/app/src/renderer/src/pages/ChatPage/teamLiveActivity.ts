// Ephemeral, caller-owned presentation state. Never store tool arguments or output.
export type TeamLiveRun = { scope: string; sessionId: string; runId: number }
export type TeamLiveToolEvent = { runId: string; toolCallId: string; toolName: unknown; status: 'running' | 'completed' | 'failed' | 'cancelled' }
type Entry = { runId: number; startedAt: number; tools: Map<string, string> }
const MAX_SESSIONS = 1024
const MAX_TOOLS = 16
const validId = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !Array.from(value).some(char => { const code = char.charCodeAt(0); return code < 32 || code === 127 })
const validRun = (run: TeamLiveRun) => !!run && validId(run.scope, 256) && validId(run.sessionId, 256) && Number.isSafeInteger(run.runId) && run.runId > 0
const safeTool = (value: unknown) => typeof value === 'string' && /^[\p{L}\p{N}_.-]{1,80}$/u.test(value) ? value : '未知工具'

export function createTeamLiveActivity() {
  const sessions = new Map<string, Map<string, Entry>>()
  // Keep watermarks even after end/clearScope to prevent ABA for this instance.
  const watermarks = new Map<string, Map<string, number>>()
  let disposed = false
  let sessionCount = 0
  const current = (run: TeamLiveRun) => !disposed && validRun(run) && sessions.get(run.scope)?.get(run.sessionId)?.runId === run.runId ? sessions.get(run.scope)?.get(run.sessionId) : undefined
  return {
    start(run: TeamLiveRun, startedAt: number): boolean {
      if (disposed || !validRun(run) || !Number.isFinite(startedAt) || startedAt < 0) return false
      const old = sessions.get(run.scope)?.get(run.sessionId)
      if (old?.runId === run.runId) return true
      let scopeMarks = watermarks.get(run.scope)
      const watermark = scopeMarks?.get(run.sessionId)
      if (watermark !== undefined && run.runId <= watermark) return false
      if (watermark === undefined && sessionCount >= MAX_SESSIONS) return false
      if (!scopeMarks) { scopeMarks = new Map(); watermarks.set(run.scope, scopeMarks) }
      if (watermark === undefined) sessionCount++
      scopeMarks.set(run.sessionId, run.runId)
      let scoped = sessions.get(run.scope)
      if (!scoped) { scoped = new Map(); sessions.set(run.scope, scoped) }
      scoped.set(run.sessionId, { runId: run.runId, startedAt, tools: new Map() })
      return true
    },
    tool(run: TeamLiveRun, event: TeamLiveToolEvent): boolean {
      const entry = current(run)
      if (!entry || !event || !validId(event.runId, 128) || !validId(event.toolCallId, 128) || !['running', 'completed', 'failed', 'cancelled'].includes(event.status)) return false
      const key = JSON.stringify([event.runId, event.toolCallId])
      if (event.status === 'running') {
        if (!entry.tools.has(key) && entry.tools.size >= MAX_TOOLS) return false
        // Reinsert so the last still-running tool is the display choice.
        entry.tools.delete(key)
        entry.tools.set(key, safeTool(event.toolName))
        return true
      }
      return entry.tools.delete(key)
    },
    retry(run: TeamLiveRun): boolean {
      const entry = current(run)
      if (!entry) return false
      entry.tools.clear()
      return true
    },
    end(run: TeamLiveRun): boolean {
      if (!current(run)) return false
      const scoped = sessions.get(run.scope)!
      scoped.delete(run.sessionId)
      if (!scoped.size) sessions.delete(run.scope)
      return true
    },
    read(run: TeamLiveRun): { startedAt: number; toolName: string | null } | undefined {
      const entry = current(run)
      if (!entry) return undefined
      return { startedAt: entry.startedAt, toolName: [...entry.tools.values()].at(-1) ?? null }
    },
    clearScope(scope: string): boolean {
      if (disposed || !validId(scope, 256)) return false
      sessions.delete(scope)
      return true
    },
    dispose(): void {
      disposed = true
      sessions.clear()
      watermarks.clear()
      sessionCount = 0
    }
  }
}
