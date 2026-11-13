import { describe, expect, it } from 'vitest'
import { canSetTeamTaskStatus, setTeamTaskDependencies, setTeamTaskStatus, teamTaskBlockers, validateTeamTasks, type TeamTask } from './agentTeamTasks'

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
