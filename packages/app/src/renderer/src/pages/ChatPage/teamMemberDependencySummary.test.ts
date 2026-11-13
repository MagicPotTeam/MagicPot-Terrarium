import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as teamTasks from './agentTeamTasks'
import { getTeamMemberDependencySummary, prepareTeamMemberDependencySummaries } from './teamMemberDependencySummary'
import type { TeamTask } from './agentTeamTasks'

const task = (id: string, title: string, ownerId: string, dependsOn: string[] = [], status: TeamTask['status'] = 'pending'): TeamTask => ({ id, title, ownerId, dependsOn, status })
const tasks = [task('a', '准备素材', 'other'), task('b', '排版', 'member', ['a']), task('c', '发布', 'member', ['a'])]
const summary = (status: 'idle' | 'running' | 'approval' | 'completed' | 'failed' | 'cancelled' | 'unknown', options: { ended?: boolean; tasks?: readonly TeamTask[] } = {}) => getTeamMemberDependencySummary({ tasks: options.tasks ?? tasks, memberId: 'member', status, teamEnded: options.ended ?? false })

describe('team member dependency summary', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('validates once for a multi-owner dense graph and preserves owner and dependency order', () => {
    const graph = [
      task('a', '第一', 'other'), task('b', '第二', 'other'), task('c', '完成', 'other', [], 'done'),
      task('d', '一', 'writer', ['b', 'a', 'c']), task('e', '二', 'writer', ['a', 'b']),
      task('f', '三', 'designer', ['a', 'b'])
    ]
    const validate = vi.spyOn(teamTasks, 'validateTeamTasks')
    const forMember = prepareTeamMemberDependencySummaries(graph, false)
    expect(validate).toHaveBeenCalledTimes(1)
    expect(forMember('writer', 'idle')).toEqual({ detailText: '等待依赖：第二、第一', idleStatusText: '等待依赖：第二、第一' })
    expect(forMember('designer', 'running')).toEqual({ detailText: '等待依赖：第一、第二' })
    expect(forMember('none', 'idle')).toEqual({})
    expect(validate).toHaveBeenCalledTimes(1)
    const changed = graph.map(item => item.id === 'a' ? { ...item, status: 'done' as const } : item)
    expect(prepareTeamMemberDependencySummaries(changed, false)('writer', 'idle')).toEqual({ detailText: '等待依赖：第二', idleStatusText: '等待依赖：第二' })
  })
  it('deduplicates shared blockers across pending tasks and ignores completed dependencies and other owners', () => {
    const input = [...tasks, task('d', '已完成', 'other', [], 'done'), task('e', '审核', 'member', ['d']), task('f', '别人的任务', 'other', ['d'])]
    expect(summary('idle', { tasks: input })).toEqual({ detailText: '等待依赖：准备素材', idleStatusText: '等待依赖：准备素材' })
  })
  it('preserves live and terminal statuses while still providing optional details', () => {
    for (const status of ['running', 'approval', 'completed', 'failed', 'cancelled', 'unknown'] as const) {
      expect(summary(status)).toEqual({ detailText: '等待依赖：准备素材' })
    }
  })
  it('does not report blockers after team end, including when otherwise idle', () => {
    expect(summary('idle', { ended: true })).toEqual({})
  })
  it('returns nothing for missing tasks or unblocked work', () => {
    expect(getTeamMemberDependencySummary({ memberId: 'member', status: 'idle', teamEnded: false })).toEqual({})
    expect(summary('idle', { tasks: [task('a', '准备', 'other', [], 'done'), task('b', '工作', 'member', ['a'])] })).toEqual({})
  })
  it('reports invalid graph as detail, never as a runtime status, including ended teams', () => {
    const invalid = [task('b', '工作', 'member', ['missing'])]
    for (const status of ['idle', 'running', 'approval', 'completed', 'failed'] as const) {
      expect(summary(status, { tasks: invalid })).toEqual({ detailText: '任务数据无效' })
    }
    expect(summary('idle', { ended: true, tasks: invalid })).toEqual({ detailText: '任务数据无效' })
  })
  it('bounds and sanitizes untrusted titles without splitting unicode characters', () => {
    const input = [task('a', '\u061c\u202e<script>\n' + '😀'.repeat(80), 'other'), task('b', '工作', 'member', ['a'])]
    const result = summary('idle', { tasks: input }).idleStatusText!
    // Verify control characters are removed.
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u202a-\u202e]/u)
    expect(Array.from(result.replace('等待依赖：', '')).length).toBeLessThanOrEqual(41)
    expect(result).toContain('…')
    expect(result).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u)
  })
})
