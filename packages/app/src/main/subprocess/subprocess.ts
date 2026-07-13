import { spawn, type ChildProcess } from 'child_process'
import { exec } from 'child_process'
import { promisify } from 'util'
import * as os from 'os'

const execAsync = promisify(exec)

type ProcessInfo = {
  name: string
  process: ChildProcess
}

const FORCE_KILL_WAIT_MS = 1000

function hasProcessExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null
}

function waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasProcessExited(process)) {
    return Promise.resolve(true)
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      process.off('exit', onExit)
      process.off('close', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(hasProcessExited(process)), timeoutMs)

    process.once('exit', onExit)
    process.once('close', onExit)

    // Avoid missing an event emitted between the first check and listener registration.
    if (hasProcessExited(process)) {
      finish(true)
    }
  })
}

type SubProcessHooks = {
  afterStart?: (pid: number) => void
  onStdout?: (data: string) => void
  onStderr?: (data: string) => void
  onClose?: (code: number | null, signal: string | null) => void
  onError?: (error: Error) => void
}

// 子进程管理类
class SubProcessManager {
  // 直接用 pid 作 key ，不考虑 pid 冲突
  // 启动子进程是低频行为，不考虑内存泄漏
  private processes: Map<number, ProcessInfo> = new Map()

  // 添加子进程到管理列表
  addProcess(pid: number, name: string, process: ChildProcess): void {
    this.processes.set(pid, { name, process })
  }

  // 从管理列表中移除子进程
  removeProcess(pid: number): ProcessInfo | undefined {
    const processInfo = this.processes.get(pid)
    if (processInfo) {
      this.processes.delete(pid)
    }
    return processInfo
  }

  // 获取所有活跃的子进程
  getActiveProcesses(): Array<{ pid: number; name: string }> {
    return Array.from(this.processes.entries()).map(([pid, info]) => ({
      pid,
      name: info.name
    }))
  }

  getProcess(pid: number): ProcessInfo | undefined {
    return this.processes.get(pid)
  }

  // 终止所有子进程
  async killAllProcesses(): Promise<void> {
    const processes = Array.from(this.processes.entries())
    const managedPids = processes.map(([pid]) => pid)

    if (processes.length === 0) {
      console.log('[SubProcessManager] 没有活跃的子进程需要终止')
      return
    }

    console.log(`[SubProcessManager] 开始终止 ${processes.length} 个子进程...`)

    try {
      // Preserve and use the PID snapshot while parents still exist; close handlers may mutate the map.
      await this.killPythonProcesses(managedPids)
      await Promise.all(
        processes.map(async ([pid, info]) => {
          try {
            await terminateProcess(pid, info, 3000)
          } catch (error) {
            console.error(`[SubProcessManager] 终止子进程失败 (PID: ${pid}):`, error)
          }
        })
      )
    } finally {
      // Never discard the only process references until all cleanup attempts have completed.
      this.processes.clear()
    }

    console.log('[SubProcessManager] 所有子进程已终止')
  }

  /**
   * 清理可能的 Python 残留子进程
   *
   * 重要安全说明：此方法只清理由本应用启动的 Python 子进程（通过追踪子进程树）
   * 不会影响用户系统上其他 Python 应用程序
   */
  private async killPythonProcesses(managedPids: number[]): Promise<void> {
    const isWindows = os.platform() === 'win32'

    if (managedPids.length === 0) {
      console.log('[SubProcessManager] 没有需要清理的 Python 子进程')
      return
    }

    try {
      if (isWindows) {
        // Windows 上查找我们启动的进程的子进程树
        for (const parentPid of managedPids) {
          try {
            // 使用 WMIC 查找特定父进程的子进程
            const { stdout } = await execAsync(
              `wmic process where (ParentProcessId=${parentPid}) get ProcessId /format:csv 2>nul`
            )

            if (stdout.trim()) {
              const lines = stdout.trim().split('\n')
              for (const line of lines) {
                const parts = line.trim().split(',')
                const childPid = parts[parts.length - 1]
                if (childPid && !isNaN(parseInt(childPid, 10))) {
                  try {
                    await execAsync(`taskkill /F /T /PID ${childPid}`)
                    console.log(
                      `[SubProcessManager] 已清理子进程: PID ${childPid} (父进程: ${parentPid})`
                    )
                  } catch (error) {
                    // 忽略已退出的进程
                  }
                }
              }
            }
          } catch (error) {
            // WMIC 查询失败，忽略
          }
        }
      } else {
        // Unix 系统：只清理我们管理的进程组
        for (const pid of managedPids) {
          try {
            // 使用进程组 ID 来终止整个进程树
            await execAsync(`pkill -9 -P ${pid} || true`)
            console.log(`[SubProcessManager] 已清理进程 ${pid} 的子进程`)
          } catch (error) {
            // 忽略错误
          }
        }
      }
    } catch (error) {
      console.warn('[SubProcessManager] 清理子进程时发生错误（已忽略）:', error)
    }
  }
}

async function terminateProcess(
  pid: number,
  info: ProcessInfo,
  gracePeriod: number
): Promise<void> {
  const { process, name } = info
  if (hasProcessExited(process)) {
    return
  }

  const isWindows = os.platform() === 'win32'
  console.log(`[SubProcessManager] 终止子进程: ${name} (PID: ${pid})`)

  try {
    if (isWindows) {
      await execAsync(`taskkill /T /PID ${pid}`)
    } else {
      process.kill('SIGTERM')
    }
  } catch (error) {
    console.warn(`[SubProcessManager] 优雅终止进程失败 (PID: ${pid})，将尝试强制终止:`, error)
  }

  if (await waitForProcessExit(process, gracePeriod)) {
    return
  }

  console.log(`[SubProcessManager] 强制终止子进程: ${name} (PID: ${pid})`)
  try {
    if (isWindows) {
      await execAsync(`taskkill /F /T /PID ${pid}`)
    } else {
      process.kill('SIGKILL')
    }
  } catch (error) {
    // The process may have exited between the timeout and the force-kill attempt.
    if (!hasProcessExited(process)) {
      console.warn(`[SubProcessManager] 强制终止进程失败 (PID: ${pid}):`, error)
    }
  }

  if (!(await waitForProcessExit(process, FORCE_KILL_WAIT_MS))) {
    console.warn(`[SubProcessManager] 未收到子进程退出事件 (PID: ${pid})，停止等待`)
  }
}

// 创建全局子进程管理器实例
const subProcessManager = new SubProcessManager()

function connectToProcess(proc: ProcessInfo, hooks?: SubProcessHooks): Promise<void> {
  return new Promise((resolve, reject) => {
    if (proc.process.pid === 0 || proc.process.pid === undefined) {
      // 子进程未启动
      reject(new Error('Process not started'))
      return
    }
    const pid = proc.process.pid

    hooks?.afterStart?.(pid)

    proc.process.stdout?.on('data', (data) => {
      hooks?.onStdout?.(data.toString())
    })

    proc.process.stderr?.on('data', (data) => {
      hooks?.onStderr?.(data.toString())
    })

    proc.process.on('close', (code, signal) => {
      hooks?.onClose?.(code, signal)
      if (code === 0 || signal === 'SIGTERM' || signal === 'SIGINT') {
        resolve()
      } else {
        reject(new Error(`'Process ${proc.name} closed with code ${code} and signal ${signal}`))
      }
    })
  })
}

export type ConnectSubProcessArgs = {
  pid: number
  hooks?: SubProcessHooks
}

export async function connectSubProcess(args: ConnectSubProcessArgs): Promise<void> {
  const proc = subProcessManager.getProcess(args.pid)
  if (!proc || !proc.process || hasProcessExited(proc.process)) {
    // 子进程已退出
    return
  }

  if (proc.process.pid !== args.pid) {
    // 子进程 pid 不匹配
    throw new Error('Process pid mismatch')
  }

  return connectToProcess(proc, args.hooks)
}

export type SubProcessArgs = {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  hooks?: SubProcessHooks
}

export async function spawnSubProcess(name: string, args: SubProcessArgs): Promise<void> {
  const proc = spawn(args.command, args.args, {
    cwd: args.cwd,
    env: args.env
  })
  if (!proc.pid) {
    // NodeJS 要求处理子进程 on error ，否则会有系统级错误
    proc.on('error', (error) => {
      console.error(`[SubProcessManager] 启动子进程失败: ${name}`, error)
      args.hooks?.onError?.(error)
    })
    throw new Error('Failed to spawn process')
  }

  const pid = proc.pid

  // 将子进程添加到管理器中
  subProcessManager.addProcess(pid, name, proc)

  // 监听进程退出，自动从管理器中移除
  proc.on('close', () => {
    subProcessManager.removeProcess(pid)
  })

  try {
    await connectToProcess({ name, process: proc }, args.hooks)
    console.log('spawnSubProcess done')
    // 注意：不要在这里移除进程，让它在 close 事件中自动移除
    // 这样即使进程还在运行，也能在清理时被正确终止
  } catch (error) {
    subProcessManager.removeProcess(pid)
    throw error
  }
}

/**
 * 终止子进程
 *
 * await 会等待子进程关闭，如果子进程没有关闭，会等待 gracePeriod 后强制终止
 *
 * @param pid 子进程 pid
 * @param gracePeriod 优雅终止的等待时间，单位毫秒
 * @returns 终止子进程的 Promise
 */
export async function killSubProcess(pid: number, gracePeriod: number = 3000): Promise<void> {
  const proc = subProcessManager.getProcess(pid)
  if (!proc) {
    console.log(`[SubProcessManager] 子进程 ${pid} 已关闭或不存在`)
    return
  }

  try {
    await terminateProcess(pid, proc, gracePeriod)
  } finally {
    subProcessManager.removeProcess(pid)
  }
}

// 导出清理函数，供 App 关闭时调用
export async function cleanupSubProcesses(): Promise<void> {
  await subProcessManager.killAllProcesses()
}

// 导出获取活跃进程的函数，用于调试
export function getActiveSubProcesses(): Array<{ pid: number; name: string }> {
  return subProcessManager.getActiveProcesses()
}
