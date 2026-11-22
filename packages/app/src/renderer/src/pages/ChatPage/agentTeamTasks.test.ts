import { describe, expect, it } from 'vitest'
import { canSetTeamTaskStatus, revertTeamTaskRun, setTeamTaskDependencies, setTeamTaskStatus, teamTaskBlockers, teamTaskOutcome, validateTeamTasks, type TeamTask } from './agentTeamTasks'

const task = (id: string, dependsOn: string[] = [], status: TeamTask['status'] = 'pending'): TeamTask => ({ id, title: id, ownerId: '', status, dependsOn })

describe('team task dependency graph', () => {
  it('reports prerequisites and disallows starting or completing until they are done', () => {
    const tasks = [task('first'), task('second', ['first'])]
    expect(teamTaskBlockers(tasks, tasks[1]).map(item => item.id)).toEqual(['first'])
    expect(canSetTeamTaskStatus(tasks, 'second', 'running')).toBe(false)
    expect(canSetTeamTaskStatus(tasks, 'second', 'done')).toBe(false)
    const ready = setTeamTaskStatus(tasks, 'first', 'done')
    expect(teamTaskBlockers(ready, ready[1])).toEqual([])
    expect(setTeamTaskStatus(ready, 'second', 'done')[1].status).toBe('done')
    expect(tasks[0].status).toBe('pending')
  })
  it('rejects self, indirect cycles, missing or duplicate dependencies without mutating inputs', () => {
    const tasks = [task('a'), task('b', ['a']), task('c', ['b'])]
    for (const dependencies of [['a'], ['c'], ['missing'], ['b', 'b']]) {
      expect(() => setTeamTaskDependencies(tasks, 'a', dependencies)).toThrow()
    }
    expect(tasks[0].dependsOn).toEqual([])
  })
  it('prevents reopening a prerequisite while a dependent task is active or completed', () => {
    for (const status of ['running', 'done'] as const) {
      const tasks = [task('a', [], 'done'), task('b', ['a'], status)]
      expect(canSetTeamTaskStatus(tasks, 'a', 'pending')).toBe(false)
      expect(() => setTeamTaskDependencies(tasks, 'a', ['b'])).toThrow()
    }
  })
  it('rejects malformed, oversized, and duplicate task records', () => {
    expect(() => validateTeamTasks([task('same'), task('same')])).toThrow()
    expect(() => validateTeamTasks(Array.from({ length: 129 }, (_, index) => task(String(index))))).toThrow()
    expect(() => validateTeamTasks([{ ...task('x'), dependsOn: 'a' as unknown as string[] }])).toThrow()
  })
  it('allows diamond dependencies with a shared ancestor', () => {
    expect(() => validateTeamTasks([task('a'), task('b', ['a']), task('c', ['a']), task('d', ['b', 'c'])])).not.toThrow()
  })
})

describe('team task run outcome', () => {
  it('keeps records written before lastOutcome existed valid, shows only known outcomes and rejects non-string ones', () => {
    const legacy = [{ id: 'a', title: 'a', ownerId: 'm', status: 'running', dependsOn: [] }] as TeamTask[]
    expect(() => validateTeamTasks(legacy)).not.toThrow()
    expect(teamTaskOutcome(legacy[0])).toBeUndefined()
    for (const lastOutcome of ['failed', 'cancelled', 'interrupted'] as const) {
      expect(() => validateTeamTasks([{ ...task('a'), lastOutcome }])).not.toThrow()
      expect(teamTaskOutcome({ ...task('a'), lastOutcome })).toBe(lastOutcome)
    }
    // K23b: an unknown string (a later version's outcome) no longer blocks the graph; it shows as none.
    for (const lastOutcome of ['done', '', 'timed_out']) {
      expect(() => validateTeamTasks([{ ...task('a'), lastOutcome } as unknown as TeamTask])).not.toThrow()
      expect(teamTaskOutcome({ lastOutcome })).toBeUndefined()
    }
    for (const lastOutcome of [1, null, {}, ['failed']]) {
      expect(() => validateTeamTasks([{ ...task('a'), lastOutcome } as unknown as TeamTask])).toThrow('Invalid task')
    }
  })
  it('keeps a graph with an unknown outcome usable and drops that outcome on the task\'s next status change', () => {
    const later = 'timed_out' as unknown as TeamTask['lastOutcome']
    const tasks: TeamTask[] = [
      { ...task('done', [], 'done'), ownerId: 'm', lastOutcome: later },
      { ...task('next', ['done']), ownerId: 'm', lastOutcome: later },
      { ...task('other'), lastOutcome: later }
    ]
    expect(teamTaskBlockers(tasks, tasks[1])).toEqual([])
    expect(canSetTeamTaskStatus(tasks, 'next', 'running')).toBe(true)
    const running = setTeamTaskStatus(tasks, 'next', 'running')
    expect(running[1]).toEqual({ id: 'next', title: 'next', ownerId: 'm', status: 'running', dependsOn: ['done'] })
    // Only the changed task loses it; the others keep their record as written.
    expect(running[0]).toBe(tasks[0])
    expect(running[2]).toBe(tasks[2])
    expect(revertTeamTaskRun(running, 'next', 'm', 'failed')?.[1].lastOutcome).toBe('failed')
    expect(setTeamTaskStatus(tasks, 'next', 'pending', 'interrupted')[1].lastOutcome).toBe('interrupted')
    const reopened = setTeamTaskStatus(tasks, 'done', 'pending')
    expect(reopened[0]).toEqual({ id: 'done', title: 'done', ownerId: 'm', status: 'pending', dependsOn: [] })
    expect(setTeamTaskDependencies(tasks, 'other', ['done'])[2].lastOutcome).toBe(later)
  })
  it('returns only a running task of the same owner to pending, with its outcome, without mutating the input', () => {
    const tasks: TeamTask[] = [{ ...task('a', [], 'running'), ownerId: 'm' }, task('b', ['a'])]
    const reverted = revertTeamTaskRun(tasks, 'a', 'm', 'cancelled')
    expect(reverted?.[0]).toEqual({ id: 'a', title: 'a', ownerId: 'm', status: 'pending', dependsOn: [], lastOutcome: 'cancelled' })
    expect(reverted?.[1]).toBe(tasks[1])
    expect(tasks[0].status).toBe('running')
    expect(revertTeamTaskRun(tasks, 'a', 'other', 'failed')).toBeNull()
    expect(revertTeamTaskRun(tasks, 'missing', 'm', 'failed')).toBeNull()
    for (const status of ['pending', 'done'] as const) {
      const settled: TeamTask[] = [{ ...task('a', [], status), ownerId: 'm' }]
      expect(revertTeamTaskRun(settled, 'a', 'm', 'failed')).toBeNull()
    }
  })
  it('drops the previous outcome on every status change and records one only with pending', () => {
    const tasks: TeamTask[] = [{ ...task('a'), lastOutcome: 'failed' }]
    expect(setTeamTaskStatus(tasks, 'a', 'running')[0]).not.toHaveProperty('lastOutcome')
    expect(setTeamTaskStatus(tasks, 'a', 'done')[0]).not.toHaveProperty('lastOutcome')
    expect(() => setTeamTaskStatus(tasks, 'a', 'done', 'failed')).toThrow('Invalid task outcome')
    expect(() => setTeamTaskStatus(tasks, 'a', 'pending', 'bogus' as never)).toThrow('Invalid task outcome')
    expect(setTeamTaskStatus(tasks, 'a', 'pending', 'interrupted')[0].lastOutcome).toBe('interrupted')
  })
})
