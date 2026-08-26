export const findTaskInBuckets = <Task, Status extends string>(
  buckets: readonly (readonly [Status, readonly Task[]])[],
  predicate: (task: Task) => boolean
): [Status, Task] | [null, null] => {
  for (const [status, tasks] of buckets) {
    const task = tasks.find(predicate)
    if (task) return [status, task]
  }
  return [null, null]
}
