import type { ChatSession } from './chatStorage'

export type TeamTask = NonNullable<ChatSession['teamTasks']>[number]
const MAX_TASKS = 128

/** A task graph is local team metadata; validating it never starts work. */
export function validateTeamTasks(tasks: readonly TeamTask[]): void {
  if (!Array.isArray(tasks) || tasks.length > MAX_TASKS) throw new Error('Invalid task count')
  const byId = new Map<string, TeamTask>()
  for (const task of tasks) {
    if (!task || typeof task.id !== 'string' || !task.id || byId.has(task.id) ||
      typeof task.title !== 'string' || !task.title.trim() || task.title.length > 256 ||
      typeof task.ownerId !== 'string' || !['pending', 'running', 'done'].includes(task.status) ||
      !Array.isArray(task.dependsOn) || task.dependsOn.length > MAX_TASKS ||
      task.dependsOn.some(id => typeof id !== 'string' || !id) ||
      new Set(task.dependsOn).size !== task.dependsOn.length) throw new Error('Invalid task')
    byId.set(task.id, task)
  }
  // Iterative graph traversal makes cycles and missing prerequisites fail closed.
  const visited = new Set<string>()
  const visiting = new Set<string>()
  for (const task of tasks) {
    if (visited.has(task.id)) continue
    const stack: Array<{ id: string; exit: boolean }> = [{ id: task.id, exit: false }]
    while (stack.length) {
      const node = stack.pop()!
      if (node.exit) { visiting.delete(node.id); visited.add(node.id); continue }
      if (visited.has(node.id)) continue
      if (visiting.has(node.id)) throw new Error('Circular task dependency')
      const current = byId.get(node.id)
      if (!current) throw new Error('Missing task dependency')
      visiting.add(node.id)
      stack.push({ id: node.id, exit: true })
      for (const dependency of current.dependsOn) stack.push({ id: dependency, exit: false })
    }
  }
  for (const task of tasks) {
    if (task.status !== 'pending' && task.dependsOn.some(id => byId.get(id)?.status !== 'done')) {
      throw new Error('Active task has unfinished dependencies')
    }
  }
}

export function teamTaskBlockers(tasks: readonly TeamTask[], task: TeamTask): TeamTask[] {
  validateTeamTasks(tasks)
  const byId = new Map(tasks.map(item => [item.id, item]))
  return task.dependsOn.map(id => byId.get(id)!).filter(item => item.status !== 'done')
}

export function setTeamTaskDependencies(tasks: readonly TeamTask[], taskId: string, dependsOn: readonly string[]): TeamTask[] {
  validateTeamTasks(tasks)
  if (!tasks.some(task => task.id === taskId)) throw new Error('Task unavailable')
  const updated = tasks.map(task => task.id === taskId ? { ...task, dependsOn: [...dependsOn] } : task)
  validateTeamTasks(updated)
  return updated
}

export function setTeamTaskStatus(tasks: readonly TeamTask[], taskId: string, status: TeamTask['status']): TeamTask[] {
  validateTeamTasks(tasks)
  if (!tasks.some(task => task.id === taskId)) throw new Error('Task unavailable')
  const updated = tasks.map(task => task.id === taskId ? { ...task, status } : task)
  validateTeamTasks(updated)
  return updated
}

export function canSetTeamTaskStatus(tasks: readonly TeamTask[], taskId: string, status: TeamTask['status']): boolean {
  try { setTeamTaskStatus(tasks, taskId, status); return true } catch { return false }
}
