import { validateTeamTasks, type TeamTask } from './agentTeamTasks'
import type { ProcessEntry } from './components/AgentProcessArea'

type DependencySummary = { detailText?: string; idleStatusText?: string }
type MemberStatus = ProcessEntry['status']

/** Build display-only summaries once per task graph, without changing scheduling. */
export function prepareTeamMemberDependencySummaries(
  tasks: readonly TeamTask[] | undefined,
  teamEnded: boolean
): (memberId: string, status: MemberStatus) => DependencySummary {
  try {
    const graph = tasks === undefined ? [] : tasks
    validateTeamTasks(graph)
    if (teamEnded) return () => ({})

    const byId = new Map(graph.map(task => [task.id, task]))
    const titlesByOwner = new Map<string, Set<string>>()
    for (const task of graph) {
      if (task.status !== 'pending') continue
      for (const id of task.dependsOn) {
        // validateTeamTasks has already checked that every dependency exists.
        const blocker = byId.get(id)!
        if (blocker.status === 'done') continue
        // Control and bidi formatting characters must not affect the surrounding UI.
        // eslint-disable-next-line no-control-regex
        const title = blocker.title.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, ' ').replace(/\s+/gu, ' ').trim() || '未命名任务'
        let titles = titlesByOwner.get(task.ownerId)
        if (!titles) { titles = new Set(); titlesByOwner.set(task.ownerId, titles) }
        titles.add(title)
      }
    }
    const textByOwner = new Map<string, string>()
    for (const [owner, titles] of titlesByOwner) {
      const characters = Array.from([...titles].join('、'))
      textByOwner.set(owner, `等待依赖：${characters.slice(0, 40).join('')}${characters.length > 40 ? '…' : ''}`)
    }
    return (memberId, status) => {
      const text = textByOwner.get(memberId)
      if (!text) return {}
      return status === 'idle' ? { detailText: text, idleStatusText: text } : { detailText: text }
    }
  } catch {
    // Invalid data stays a detail; it cannot override the actual process status.
    return () => ({ detailText: '任务数据无效' })
  }
}

/** Convenience for isolated callers; the process area prepares once for all members. */
export function getTeamMemberDependencySummary(input: {
  tasks?: readonly TeamTask[]
  memberId: string
  status: MemberStatus
  teamEnded: boolean
}): DependencySummary {
  return prepareTeamMemberDependencySummaries(input.tasks, input.teamEnded)(input.memberId, input.status)
}
