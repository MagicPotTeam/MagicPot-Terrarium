import { describe, expect, it, vi } from 'vitest'
import { dispatchTeamTask, type TeamTaskDispatchStore } from './agentTeamTaskDispatch'
import { setTeamTaskStatus, type TeamTask } from './agentTeamTasks'

const task = (id: string, dependsOn: string[] = [], status: TeamTask['status'] = 'pending'): TeamTask => ({ id, title: id, ownerId: '', status, dependsOn })

function fixture(initial: TeamTask[]) {
  let tasks = initial
  let queue = Promise.resolve()
  const store: TeamTaskDispatchStore = {
    updateTasks(update) {
      const operation = queue.then(() => { tasks = update(tasks) })
      queue = operation.catch(() => undefined)
      return operation
    }
  }
  return { store, getTasks: () => tasks }
}

describe('team task dispatch admission', () => {
  it('does not invoke the executor until every prerequisite is done', async () => {
    const state = fixture([task('a'), task('b'), task('c', ['a', 'b'])])
    const execute = vi.fn(async () => {})
    await expect(dispatchTeamTask(state.store, 'c', execute)).rejects.toThrow()
    await state.store.updateTasks(current => setTeamTaskStatus(current, 'a', 'done'))
    await expect(dispatchTeamTask(state.store, 'c', execute)).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    await state.store.updateTasks(current => setTeamTaskStatus(current, 'b', 'done'))
    await dispatchTeamTask(state.store, 'c', execute)
    expect(execute).toHaveBeenCalledOnce()
    expect(state.getTasks()[2].status).toBe('running')
  })

  it('serializes competing claims and prevents duplicate dispatch', async () => {
    const state = fixture([task('a')])
    const execute = vi.fn(async () => {})
    const results = await Promise.allSettled([dispatchTeamTask(state.store, 'a', execute), dispatchTeamTask(state.store, 'a', execute)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(execute).toHaveBeenCalledOnce()
  })

  it('fails closed for malformed graphs, missing tasks and commit failures', async () => {
    const execute = vi.fn(async () => {})
    for (const tasks of [[task('a', ['missing'])], [task('a', ['b']), task('b', ['a'])], []]) {
      await expect(dispatchTeamTask(fixture(tasks).store, 'a', execute)).rejects.toThrow()
    }
    await expect(dispatchTeamTask({ updateTasks: async () => { throw new Error('commit failed') } }, 'a', execute)).rejects.toThrow('commit failed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('retains the claim if execution fails, rather than silently retrying work', async () => {
    const state = fixture([task('a')])
    await expect(dispatchTeamTask(state.store, 'a', async () => { throw new Error('executor failed') })).rejects.toThrow('executor failed')
    expect(state.getTasks()[0].status).toBe('running')
  })
})
