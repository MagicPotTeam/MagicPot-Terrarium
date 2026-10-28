import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createNodeTestArtifactDir } from '../testSupport/nodeTestArtifacts'
import {
  acquireManagedMediaGenerationLock,
  cleanupManagedMediaGenerationArtifacts,
  managedMediaGenerationArtifactName,
  removeOwnedManagedMediaGenerationTree,
  type ManagedMediaGenerationLockOwner
} from './managedMediaGenerationLock'

vi.unmock('node:fs')
vi.unmock('node:fs/promises')

const stalePid = 2_000_000_000
const hostname = 'test-host'
const alive = (pid: number): boolean => pid !== stalePid
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('managed media generation recovery lock on real filesystem', () => {
  let temporaryDirectory = ''
  const children: ChildProcess[] = []

  afterEach(async () => {
    vi.restoreAllMocks()
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill()
    }
    if (temporaryDirectory) {
      const resolved = path.resolve(temporaryDirectory)
      if (!path.basename(resolved).startsWith('run-')) throw new Error('Unsafe test cleanup path')
      await fs.rm(resolved, { recursive: true, force: true })
    }
  })

  async function root(): Promise<string> {
    temporaryDirectory = await createNodeTestArtifactDir('managed-media-generation-lock')
    const directory = path.join(temporaryDirectory, 'identity')
    await fs.mkdir(directory)
    return fs.realpath(directory)
  }

  async function deadLock(identityRoot: string) {
    return acquireManagedMediaGenerationLock(identityRoot, {
      pid: stalePid,
      hostname,
      now: () => Date.now() - 100_000
    })
  }

  it('serializes concurrent owners and leaves an idle protocol anchor blocking legacy mkdir', async () => {
    const identityRoot = await root()
    const first = await acquireManagedMediaGenerationLock(identityRoot)
    await expect(fs.mkdir(path.join(identityRoot, '.generation-lock'))).rejects.toMatchObject({
      code: 'EEXIST'
    })
    let acquired = false
    const secondPromise = acquireManagedMediaGenerationLock(identityRoot, {
      waitTimeoutMs: 1_000,
      retryDelayMs: 1
    }).then((lock) => {
      acquired = true
      return lock
    })
    await pause(20)
    expect(acquired).toBe(false)
    await first.release()
    const second = await secondPromise
    await second.release()
    await expect(fs.lstat(first.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(path.join(identityRoot, '.generation-lock'))).toEqual([
      'protocol-v2.json'
    ])
  })

  it('retries a changed owner snapshot without retiring a live owner or accepting partial data', async () => {
    const identityRoot = await root()
    const first = await acquireManagedMediaGenerationLock(identityRoot)
    const ownerPath = path.join(first.path, `${first.owner.token}.json`)
    const originalOpen = fs.open.bind(fs)
    let injected = false
    let waited = false
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === ownerPath && !injected) {
        injected = true
        const snapshot = await handle.stat()
        // A concurrent unlink/rename changes inode metadata while an already
        // opened descriptor remains readable. Simulate that deterministically
        // on Windows too; no stale snapshot may authorize recovery.
        const changed = Object.assign(Object.create(Object.getPrototypeOf(snapshot)), snapshot, {
          ctimeMs: snapshot.ctimeMs + 1
        })
        vi.spyOn(handle, 'stat').mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed)
      }
      return handle
    })
    const second = await acquireManagedMediaGenerationLock(identityRoot, {
      waitTimeoutMs: 2_000,
      retryDelayMs: 1,
      sleep: async () => {
        waited = true
        expect(injected).toBe(true)
        expect(await fs.readdir(first.path)).toEqual([`${first.owner.token}.json`])
        await first.release()
      }
    })
    expect(waited).toBe(true)
    expect(second.owner.token).not.toBe(first.owner.token)
    await second.release()
  })

  it('retains the wait deadline when an owner record changes during a read', async () => {
    const identityRoot = await root()
    const first = await acquireManagedMediaGenerationLock(identityRoot)
    const ownerPath = path.join(first.path, `${first.owner.token}.json`)
    const originalOpen = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args)
      if (String(args[0]) === ownerPath) {
        const snapshot = await handle.stat()
        const changed = Object.assign(Object.create(Object.getPrototypeOf(snapshot)), snapshot, {
          ctimeMs: snapshot.ctimeMs + 1
        })
        vi.spyOn(handle, 'stat').mockResolvedValueOnce(snapshot).mockResolvedValueOnce(changed)
      }
      return handle
    })
    await expect(
      acquireManagedMediaGenerationLock(identityRoot, { waitTimeoutMs: 0 })
    ).rejects.toThrow(/Timed out/)
    expect(await fs.readdir(first.path)).toEqual([`${first.owner.token}.json`])
    await first.release()
  })

  it('never replaces a live owner solely because its timestamp is old', async () => {
    const identityRoot = await root()
    const first = await acquireManagedMediaGenerationLock(identityRoot, {
      hostname,
      now: () => Date.now() - 100_000
    })
    await expect(
      acquireManagedMediaGenerationLock(identityRoot, {
        hostname,
        staleAfterMs: 0,
        waitTimeoutMs: 20,
        retryDelayMs: 1
      })
    ).rejects.toThrow(/Timed out/)
    expect(await fs.readdir(first.path)).toEqual([`${first.owner.token}.json`])
    await first.release()
  })

  it('recovers a dead owner and a crash between owner unlink and empty-rmdir', async () => {
    const identityRoot = await root()
    const old = await deadLock(identityRoot)
    const next = await acquireManagedMediaGenerationLock(identityRoot, {
      hostname,
      staleAfterMs: 0,
      isProcessAlive: alive,
      retryDelayMs: 1
    })
    expect(next.owner.token).not.toBe(old.owner.token)
    await fs.unlink(path.join(next.path, `${next.owner.token}.json`))
    const recovered = await acquireManagedMediaGenerationLock(identityRoot, { retryDelayMs: 1 })
    expect(recovered.owner.token).not.toBe(next.owner.token)
    await recovered.release()
    await old.release()
  })

  it('does not let a delayed stale recoverer unlink a newly acquired live owner', async () => {
    const identityRoot = await root()
    const old = await deadLock(identityRoot)
    const observed = deferred()
    const resume = deferred()
    const originalUnlink = fs.unlink.bind(fs)
    const oldOwnerPath = path.join(old.path, `${old.owner.token}.json`)
    let blocked = false
    vi.spyOn(fs, 'unlink').mockImplementation(async (target) => {
      if (String(target) === oldOwnerPath && !blocked) {
        blocked = true
        observed.resolve()
        await resume.promise
      }
      return originalUnlink(target)
    })
    const options = {
      hostname,
      staleAfterMs: 0,
      isProcessAlive: alive,
      waitTimeoutMs: 2_000,
      retryDelayMs: 1
    }
    let delayedAcquired = false
    const delayed = acquireManagedMediaGenerationLock(identityRoot, options).then((lock) => {
      delayedAcquired = true
      return lock
    })
    await observed.promise
    const winner = await acquireManagedMediaGenerationLock(identityRoot, options)
    resume.resolve()
    await pause(25)
    expect(delayedAcquired).toBe(false)
    expect(await fs.readdir(winner.path)).toEqual([`${winner.owner.token}.json`])
    await winner.release()
    await (await delayed).release()
  })

  it('recovers a real crashed process without stealing its lock while it is alive', async () => {
    const identityRoot = await root()
    const moduleUrl = pathToFileURL(
      path.resolve('packages/app/src/main/llmProxy/managedMediaGenerationLock.ts')
    ).href
    const script = `import { acquireManagedMediaGenerationLock } from ${JSON.stringify(moduleUrl)};
      const lock = await acquireManagedMediaGenerationLock(${JSON.stringify(identityRoot)}, {now: () => Date.now() - 100000});
      console.log(JSON.stringify({ token: lock.owner.token })); setInterval(() => {}, 1000);`
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--input-type=module', '-e', script],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    children.push(child)
    let stderr = ''
    child.stderr!.on('data', (data) => {
      stderr += String(data)
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Child lock timed out: ${stderr}`)), 5_000)
      child.stdout!.once('data', () => {
        clearTimeout(timer)
        resolve()
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (code) reject(new Error(`Child exited ${code}: ${stderr}`))
      })
    })
    await expect(
      acquireManagedMediaGenerationLock(identityRoot, {
        staleAfterMs: 0,
        waitTimeoutMs: 20,
        retryDelayMs: 1
      })
    ).rejects.toThrow(/Timed out/)
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
    })
    const recovered = await acquireManagedMediaGenerationLock(identityRoot, {
      staleAfterMs: 0,
      retryDelayMs: 1
    })
    await recovered.release()
  }, 10_000)

  it.each(['directory', 'file', 'link'])(
    'preserves an unsupported legacy %s lock instead of force-unlocking it',
    async (kind) => {
      const identityRoot = await root()
      const legacy = path.join(identityRoot, '.generation-lock')
      if (kind === 'directory') await fs.mkdir(legacy)
      if (kind === 'file') await fs.writeFile(legacy, 'legacy')
      if (kind === 'link') await fs.symlink(temporaryDirectory, legacy, 'junction')
      await expect(
        acquireManagedMediaGenerationLock(identityRoot, { waitTimeoutMs: 0 })
      ).rejects.toThrow()
      expect(await fs.lstat(legacy)).toBeDefined()
    }
  )

  it('bounds owner reads and refuses malformed or oversized owner metadata', async () => {
    const identityRoot = await root()
    const old = await deadLock(identityRoot)
    const ownerPath = path.join(old.path, `${old.owner.token}.json`)
    await fs.writeFile(ownerPath, 'x'.repeat(2_049))
    const readFile = vi.spyOn(fs, 'readFile')
    await expect(
      acquireManagedMediaGenerationLock(identityRoot, {
        hostname,
        staleAfterMs: 0,
        isProcessAlive: alive,
        waitTimeoutMs: 0
      })
    ).rejects.toThrow(/Unsafe generation owner record/)
    expect(readFile).not.toHaveBeenCalled()
    expect((await fs.stat(ownerPath)).size).toBe(2_049)
  })

  it('reclaims only stale same-host empty dirs/links, preserving nonempty, live and foreign artifacts', async () => {
    const identityRoot = await root()
    const dead = (await deadLock(identityRoot)).owner
    const names = {
      empty: managedMediaGenerationArtifactName('work', dead),
      nonempty: managedMediaGenerationArtifactName('commit', dead),
      link: managedMediaGenerationArtifactName('quarantine', dead),
      live: managedMediaGenerationArtifactName('work', { ...dead, pid: process.pid }),
      foreign: managedMediaGenerationArtifactName('work', { ...dead, hostname: 'other-host' })
    }
    for (const name of [names.empty, names.nonempty, names.live, names.foreign])
      await fs.mkdir(path.join(identityRoot, name))
    await fs.writeFile(path.join(identityRoot, names.nonempty, 'keep'), 'keep')
    const outside = path.join(temporaryDirectory, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'keep'), 'keep')
    await fs.symlink(outside, path.join(identityRoot, names.link), 'junction')
    await cleanupManagedMediaGenerationArtifacts(identityRoot, {
      hostname,
      now: () => Date.now() + 100_000,
      staleAfterMs: 10,
      isProcessAlive: alive
    })
    await expect(fs.lstat(path.join(identityRoot, names.empty))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    await expect(fs.lstat(path.join(identityRoot, names.link))).rejects.toMatchObject({
      code: 'ENOENT'
    })
    for (const name of [names.nonempty, names.live, names.foreign])
      expect((await fs.stat(path.join(identityRoot, name))).isDirectory()).toBe(true)
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep')
  })

  it('leaves nonempty crash artifacts without recursively enumerating their contents', async () => {
    const identityRoot = await root()
    const owner = (await deadLock(identityRoot)).owner
    const target = path.join(identityRoot, managedMediaGenerationArtifactName('work', owner))
    await fs.mkdir(target)
    await fs.writeFile(path.join(target, 'keep'), 'keep')
    const opendir = vi.spyOn(fs, 'opendir')
    await cleanupManagedMediaGenerationArtifacts(identityRoot, {
      hostname,
      staleAfterMs: 0,
      isProcessAlive: alive
    })
    expect(opendir.mock.calls.every(([directory]) => String(directory) === identityRoot)).toBe(true)
    expect(await fs.readFile(path.join(target, 'keep'), 'utf8')).toBe('keep')
  })

  it('stops owned cleanup if a parent becomes a junction after a child lstat', async () => {
    const identityRoot = await root()
    const lock = await acquireManagedMediaGenerationLock(identityRoot)
    const target = path.join(identityRoot, managedMediaGenerationArtifactName('work', lock.owner))
    const outside = path.join(temporaryDirectory, 'outside')
    await fs.mkdir(target)
    await fs.mkdir(outside)
    await fs.writeFile(path.join(target, 'keep'), 'private')
    await fs.writeFile(path.join(outside, 'keep'), 'external')
    const originalLstat = fs.lstat.bind(fs)
    let swapped = false
    vi.spyOn(fs, 'lstat').mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
      const result = await originalLstat(...args)
      if (String(args[0]) === path.join(target, 'keep') && !swapped) {
        swapped = true
        await fs.rename(target, `${target}-saved`)
        await fs.symlink(outside, target, 'junction')
      }
      return result
    })
    await expect(
      removeOwnedManagedMediaGenerationTree(identityRoot, target, lock.owner)
    ).rejects.toThrow(/Unsafe/)
    expect(swapped).toBe(true)
    expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('external')
    await lock.release()
  })
})
