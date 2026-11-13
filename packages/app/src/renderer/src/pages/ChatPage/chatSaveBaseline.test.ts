import { beforeEach, describe, expect, it, vi } from 'vitest'

const saveSessionToDBMock = vi.hoisted(() => vi.fn())

vi.mock('./chatStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./chatStorage')>(),
  // Observe the complete options object passed by the implementation, including owner semantics.
  saveSessionToDB: saveSessionToDBMock
}))

import type { ChatSession } from './chatStorage'
import { ChatSessionSaveBaseline } from './chatSaveBaseline'

const session = (id: string, content: string): ChatSession => ({
  id,
  title: id,
  messages: [{ role: 'user', content }]
})

describe('ChatSessionSaveBaseline', () => {
  beforeEach(() => {
    saveSessionToDBMock.mockReset()
    saveSessionToDBMock.mockResolvedValue(undefined)
  })

  it('freezes the baseline once and passes it as expectedSession', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const resolve = vi.fn(() => v0)

    await baseline.persist('scope-a', v1, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(saveSessionToDBMock).toHaveBeenCalledWith(v1, 'scope-a', { expectedSession: v0, pendingSaveOwner: null })
  })

  it('does not replace an already frozen baseline', () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')

    expect(baseline.freeze('scope-a', 's1', v0)).toEqual(v0)
    // A later (external) refresh attempting to freeze again is ignored.
    expect(baseline.freeze('scope-a', 's1', v1)).toEqual(v0)
  })

  it('freezes baseline values against caller mutation, including its return value', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old=session('baseline-clone','old')
    const returned=baseline.freeze('scope',old.id,old)!
    old.messages[0].content='mutated source'
    returned.messages[0].content='mutated return'
    const next=session('baseline-clone','next')
    await baseline.persist('scope',next,()=>old)
    expect(saveSessionToDBMock).toHaveBeenCalledWith(next,'scope',{expectedSession:session('baseline-clone','old'), pendingSaveOwner:null})
  })

  it('revokes an earlier acknowledgement when its CAS revalidation fails', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old=session('revoked','old')
    const saved=session('revoked','saved')
    await baseline.persist('scope',saved,()=>old)
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(true)
    saveSessionToDBMock.mockRejectedValueOnce(new Error('remote conflict'))
    await expect(baseline.persist('scope',saved,()=>old)).rejects.toThrow('remote conflict')
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
  })

  it('revokes a previous acknowledgement when another object observes a conflict for the same key', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old=session('concurrent-revalidation','old')
    const saved=session('concurrent-revalidation','saved')
    await baseline.persist('scope',saved,()=>old)
    let releaseSuccess!:()=>void
    let releaseFailure!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{releaseSuccess=resolve}))
      .mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{releaseFailure=()=>reject(new Error('conflict'))}))
    const first=baseline.persist('scope',saved,()=>old)
    // An identical in-flight object joins the same promise: use a distinct clone to model a second path.
    const clone=structuredClone(saved)
    const second=baseline.persist('scope',clone,()=>old)
    const observed=second.catch(error=>error)
    await vi.waitFor(()=>expect(releaseSuccess).toBeDefined())
    releaseSuccess()
    await first
    await vi.waitFor(()=>expect(releaseFailure).toBeDefined())
    releaseFailure()
    expect(await observed).toBeInstanceOf(Error)
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
    expect(baseline.isAcknowledgementCurrent('scope',clone)).toBe(false)
  })

  it('serializes concurrent own saves and advances the baseline between them', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const v2 = session('s1', 'v2')
    let current = v1
    let release!: () => void
    let started!: () => void
    const begun = new Promise<void>(resolve => { started = resolve })
    const order: string[] = []
    saveSessionToDBMock.mockImplementationOnce(async (saved: ChatSession) => {
      order.push(`start:${saved.messages[0].content}`)
      started()
      await new Promise<void>(resolve => { release = resolve })
      order.push(`end:${saved.messages[0].content}`)
    }).mockImplementationOnce(async (saved: ChatSession) => {
      order.push(`start:${saved.messages[0].content}`)
      order.push(`end:${saved.messages[0].content}`)
    })
    const first = baseline.persistLatest('scope-a', v1.id, () => current, () => v0)
    await begun
    current = v2
    const second = baseline.persistLatest('scope-a', v2.id, () => current, () => v0)
    release()
    await Promise.all([first, second])
    expect(saveSessionToDBMock.mock.calls).toEqual([
      [v1, 'scope-a', expect.objectContaining({expectedSession:v0, shouldUpdate:expect.any(Function), pendingSaveOwner:null})],
      [v2, 'scope-a', expect.objectContaining({expectedSession:v1, shouldUpdate:expect.any(Function), pendingSaveOwner:null})]
    ])
    expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2'])
  })

  it('notifies on live-save acknowledgement before resolving and not on conflict or skipped work', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('ack-order', 'old')
    const saved = session('ack-order', 'saved')
    const order: string[] = []
    const pending = baseline.persistLatest('scope', saved.id, () => saved, () => old, () => {
      expect(baseline.freeze('scope', saved.id, null)).toEqual(saved)
      order.push('acknowledged')
    })
    await pending.then(() => order.push('resolved'))
    expect(order).toEqual(['acknowledged', 'resolved'])

    const notify = vi.fn()
    saveSessionToDBMock.mockRejectedValueOnce(new Error('conflict'))
    await expect(baseline.persistLatest('scope', saved.id, () => saved, () => old, notify)).rejects.toThrow('conflict')
    expect(notify).not.toHaveBeenCalled()
    await expect(baseline.persistLatest('scope', saved.id, () => null, () => old, notify)).resolves.toBeNull()
    expect(notify).not.toHaveBeenCalled()
  })

  it('fences queued pre-transition saves without seeding them with the new baseline', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('member','old')
    const active = session('member','active')
    const stale = session('member','stale')
    const archived = {...session('member','ended'),archived:true}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const running=baseline.persist('scope',active,()=>old)
    const queued=baseline.persist('scope',stale,()=>old)
    await vi.waitFor(()=>expect(release).toBeDefined())
    baseline.fenceAndAdvance('scope','member',archived)
    release()
    await running
    await expect(queued).rejects.toThrow('lifecycle changed')
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(1)
    const next={...archived,title:'updated'}
    await baseline.persist('scope',next,()=>old)
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(next,'scope',{expectedSession:archived, pendingSaveOwner:null})
  })

  it('rejects a stale timer snapshot after a new lifecycle baseline is installed', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = {...session('lead','old'),teamGeneration:0,teamLifecycleRevision:0}
    const stale = {...old,title:'old pending edit'}
    const ended = {...old,teamGeneration:1,teamLifecycleRevision:1}
    baseline.freeze('scope','lead',old)
    baseline.fenceAndAdvance('scope','lead',ended)
    await expect(baseline.persist('scope',stale,()=>old)).rejects.toThrow('lifecycle changed')
    expect(saveSessionToDBMock).not.toHaveBeenCalled()
    await baseline.persist('scope',{...ended,title:'new edit'},()=>ended)
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(1)
  })

  it('rebases a dirty member only when End is the sole stored change', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = {...session('member','original'),teamLeadId:'lead',teamMemberName:'writer',teamMemberGeneration:0}
    const local = {...original,title:'local edit'}
    const ended = {...original,teamLifecycleRevision:1,archived:true}
    baseline.freeze('scope','member',original)
    const rebased=baseline.reconcileTeamEnd('scope',local,ended)
    expect(rebased).toMatchObject({title:'local edit',archived:true,teamLifecycleRevision:1})
    await baseline.persist('scope',rebased!,()=>original)
    expect(saveSessionToDBMock).toHaveBeenCalledWith(rebased,'scope',{expectedSession:ended, pendingSaveOwner:null})

    const conflicting = new ChatSessionSaveBaseline()
    conflicting.freeze('scope','member',original)
    const changed = {...ended,messages:[{role:'user' as const,content:'newer remote history'}]}
    expect(conflicting.reconcileTeamEnd('scope',local,changed)).toBeNull()
    await conflicting.persist('scope',local,()=>original)
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(local,'scope',{expectedSession:original, pendingSaveOwner:null})
  })

  it('joins a pending save of the identical snapshot before later snapshots', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('same','old')
    const first = session('same','first')
    const newer = session('same','newer')
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',first,()=>old)
    const duplicate=baseline.persist('scope',first,()=>old)
    const current = newer
    const later=baseline.persistLatest('scope',newer.id,()=>current,()=>old)
    await vi.waitFor(()=>expect(release).toBeDefined())
    release()
    await Promise.all([pending,later,duplicate])
    await baseline.persist('scope',first,()=>old)
    expect(saveSessionToDBMock.mock.calls).toEqual([
      [first,'scope',{expectedSession:old, pendingSaveOwner:null}],
      [newer,'scope',expect.objectContaining({expectedSession:first,shouldUpdate:expect.any(Function),pendingSaveOwner:null})],
      [first,'scope',{expectedSession:first,pendingSaveOwner:null}]
    ])
  })

  it('does not accept a previously saved object as clean after another writer changes storage', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('same', 'old')
    const first = session('same', 'first')
    const external = session('same', 'external')
    let stored = old
    saveSessionToDBMock.mockImplementation(async (payload: ChatSession, _scope: string, options: {expectedSession: ChatSession | null}) => {
      if (JSON.stringify(stored) !== JSON.stringify(options.expectedSession)) throw new Error('conflict')
      stored = payload
    })
    await baseline.persist('scope', first, () => old)
    stored = external
    await expect(baseline.persist('scope', first, () => old)).rejects.toThrow('conflict')
    expect(stored).toEqual(external)
  })

  it('fences both unreserved queued writes when a separate attachment CAS advances the baseline', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('attachment', 'before')
    const one = session('attachment', 'old one')
    const two = session('attachment', 'old two')
    const attached = {...original, title: 'file committed'}
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(() => new Promise<void>(resolve => {release = resolve}))
    const first = baseline.persist('scope', one, () => original)
    const second = baseline.persist('scope', two, () => original)
    await vi.waitFor(() => expect(release).toBeDefined())
    baseline.advance('scope', original.id, attached)
    release()
    await first
    await expect(second).rejects.toThrow('lifecycle changed')
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(1)
  })

  it('cannot infer predecessor ownership from an equivalent independently built payload', () => {
    const original: ChatSession = {...session('contradiction', 'original'), messages:[]}
    const first: ChatSession = {...original, messages:[{role:'user', content:'question'}]}
    const latest: ChatSession = {...first, messages:[...first.messages, {role:'assistant', content:'later'}]}
    // This independent branch does not share a session or message array with the writer's first.
    const independent: ChatSession = {...original, messages:[{role:'user', content:'question'}, {role:'assistant', content:'later'}]}
    expect(latest).not.toBe(independent)
    expect(latest.messages[0]).not.toBe(independent.messages[0])
    expect(structuredClone(latest)).toEqual(structuredClone(independent))
  })

  it('rebases a strict append reservation only on the exact completed own predecessor', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('append', 'original')
    const first = {...original, messages:[...original.messages, {role:'assistant' as const, content:'first'}]}
    const later = {...first, messages:[...first.messages, {role:'user' as const, content:'later'}]}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',first,()=>original)
    baseline.reserve('scope',later,()=>original)
    const queued=baseline.persist('scope',later,()=>original)
    await vi.waitFor(()=>expect(release).toBeDefined())
    release()
    await Promise.all([pending,queued])
    expect(saveSessionToDBMock.mock.calls).toEqual([
      [first,'scope',{expectedSession:original, pendingSaveOwner:null}],
      [later,'scope',{expectedSession:first,pendingSaveOwner:null}]
    ])
  })

  it.each(['history','metadata'])('does not follow an own predecessor when %s changed', async change => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('nonappend', 'original')
    const first = {...original, messages:[...original.messages,{role:'assistant' as const,content:'first'}]}
    const later = change === 'history'
      ? {...first, messages:[{role:'user' as const,content:'altered'},...first.messages.slice(1),{role:'user' as const,content:'new'}]}
      : {...first,title:'changed metadata',messages:[...first.messages,{role:'user' as const,content:'new'}]}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',first,()=>original)
    baseline.reserve('scope',later,()=>original)
    const queued=baseline.persist('scope',later,()=>original)
    await vi.waitFor(()=>expect(release).toBeDefined())
    release()
    await Promise.all([pending,queued])
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(later,'scope',{expectedSession:original, pendingSaveOwner:null})
  })

  it('keeps the original CAS baseline after a failed or unknown predecessor', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('unknown', 'original')
    const first = {...original, messages:[...original.messages,{role:'assistant' as const,content:'first'}]}
    const later = {...first, messages:[...first.messages,{role:'user' as const,content:'later'}]}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>((_resolve,reject)=>{release=()=>reject(new Error('unknown outcome'))}))
    const pending=baseline.persist('scope',first,()=>original)
    const observed=pending.catch(error=>error)
    baseline.reserve('scope',later,()=>original)
    const queued=baseline.persist('scope',later,()=>original)
    await vi.waitFor(()=>expect(release).toBeDefined())
    release()
    expect(await observed).toBeInstanceOf(Error)
    await queued
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(later,'scope',{expectedSession:original, pendingSaveOwner:null})
  })

  it('does not roll an older successful baseline back after an external End was adopted', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old={...session('external-race','old'),teamGeneration:0,teamLifecycleRevision:0}
    const pendingSession={...old,title:'pending'}
    const ended={...old,teamGeneration:1,teamLifecycleRevision:1}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',pendingSession,()=>old)
    await vi.waitFor(()=>expect(release).toBeDefined())
    baseline.fenceAndAdvance('scope',old.id,ended)
    release()
    await pending
    expect(baseline.isAcknowledgementCurrent('scope',pendingSession)).toBe(false)
    expect(baseline.freeze('scope',old.id,null)).toEqual(ended)
  })

  it('does not rebase a strict append across an epoch fence', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('fenced-append', 'original')
    const first = {...original, messages:[...original.messages,{role:'assistant' as const,content:'first'}]}
    const later = {...first, messages:[...first.messages,{role:'user' as const,content:'later'}]}
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',first,()=>original)
    baseline.reserve('scope',later,()=>original)
    const queued=baseline.persist('scope',later,()=>original)
    const observed=queued.catch(error=>error)
    await vi.waitFor(()=>expect(release).toBeDefined())
    baseline.fenceAndAdvance('scope',original.id,original)
    release()
    await pending
    expect(await observed).toBeInstanceOf(Error)
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(1)
  })

  it('preserves the current draft when a reserved snapshot conflicts with an earlier own commit', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const original = session('durability', 'before')
    const first = session('durability', 'first')
    const latest = session('durability', 'latest')
    let stored = original
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(async (payload: ChatSession) => {
      await new Promise<void>(resolve => {release = resolve})
      stored = payload
    }).mockImplementation(async (payload: ChatSession, _scope: string, options: {expectedSession: ChatSession | null}) => {
      if (JSON.stringify(stored) !== JSON.stringify(options.expectedSession)) throw new Error('conflict')
      stored = payload
    })
    const pending = baseline.persist('scope', first, () => original)
    await vi.waitFor(() => expect(release).toBeDefined())
    baseline.reserve('scope', latest, () => original)
    release()
    await pending
    await expect(baseline.persist('scope', latest, () => original)).rejects.toThrow('conflict')
    await expect(baseline.persist('scope', latest, () => original)).rejects.toThrow('conflict')
    expect(stored).toEqual(first)
    expect(latest.messages[0].content).toBe('latest')
  })

  it('does not advance the baseline when a save fails', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')
    const v2 = session('s1', 'v2')

    saveSessionToDBMock.mockRejectedValueOnce(new Error('conflict'))

    await expect(baseline.persist('scope-a', v1, () => v0)).rejects.toThrow('conflict')
    // Baseline stays at the frozen v0, so a retry still compares against v0.
    await baseline.persist('scope-a', v2, () => v0)

    expect(saveSessionToDBMock.mock.calls).toEqual([
      [v1, 'scope-a', { expectedSession: v0, pendingSaveOwner: null }],
      [v2, 'scope-a', { expectedSession: v0, pendingSaveOwner: null }]
    ])
  })

  it('rejects a delayed acknowledgement if the current object mutated while the write was in flight', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old=session('mutable-ack','old')
    const saved=session('mutable-ack','before')
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const pending=baseline.persist('scope',saved,()=>old)
    await vi.waitFor(()=>expect(release).toBeDefined())
    saved.messages[0].content='after mutation'
    release()
    await pending
    expect(saveSessionToDBMock.mock.calls[0][0].messages[0].content).toBe('before')
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
  })

  it('rejects a successful batch item after a later End conflict before batch completion', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old={...session('late-batch','old'),teamGeneration:0,teamLifecycleRevision:0}
    const saved={...old,messages:[{role:'assistant' as const,content:'local'}]}
    let releaseSecond!:()=>void
    const second=new Promise<void>(resolve=>{releaseSecond=resolve})
    await baseline.persist('scope',saved,()=>old)
    const batch=Promise.all([Promise.resolve(),second])
    const external={...old,teamGeneration:1,teamLifecycleRevision:1,messages:[{role:'user' as const,content:'external'}]}
    expect(baseline.reconcileTeamEnd('scope',saved,external)).toBeNull()
    releaseSecond()
    await batch
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
  })

  it('rejects late acknowledgements after reconciliation or in-place mutation', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = {...session('ack', 'old'),teamGeneration:0,teamLifecycleRevision:0}
    const saved = {...old,messages:[{role:'user' as const,content:'saved'}]}
    await baseline.persist('scope',saved,()=>old)
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(true)
    saved.messages[0].content='mutated while saving'
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
    saved.messages[0].content='saved'
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(true)
    expect(baseline.reconcileTeamEnd('scope',saved,{...old,teamGeneration:1,teamLifecycleRevision:1,messages:[{role:'user',content:'external'}]})).toBeNull()
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
  })

  it('does not revalidate a previously saved object after an End conflict fences its epoch', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old={...session('fenced-ack','old'),teamGeneration:0,teamLifecycleRevision:0}
    const saved={...old,messages:[{role:'assistant' as const,content:'local'}]}
    await baseline.persist('scope',saved,()=>old)
    expect(baseline.reconcileTeamEnd('scope',saved,{...old,teamGeneration:1,teamLifecycleRevision:1,messages:[{role:'user',content:'external'}]})).toBeNull()
    await expect(baseline.persist('scope',saved,()=>old)).rejects.toThrow('acknowledgement is no longer current')
    expect(baseline.isAcknowledgementCurrent('scope',saved)).toBe(false)
    expect(saveSessionToDBMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an unreserved older clone submitted after a newer own write completes', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('late-clone','old')
    const newer = {...old,messages:[...old.messages,{role:'assistant' as const,content:'new reply'}]}
    const stale = structuredClone(old)
    let stored=old
    saveSessionToDBMock.mockImplementation(async (payload:ChatSession,_scope:string,options:{expectedSession:ChatSession|null})=>{
      if (JSON.stringify(stored)!==JSON.stringify(options.expectedSession)) throw new Error('conflict')
      stored=payload
    })
    await baseline.persist('scope',newer,()=>old)
    await expect(baseline.persist('scope',stale,()=>old)).rejects.toThrow()
    expect(stored).toEqual(newer)
  })

  it('does not silently overwrite a newer own commit with an unreserved non-prefix stale clone', async () => {
    const baseline=new ChatSessionSaveBaseline()
    const old=session('nonprefix-clone','old')
    const stale={...old,title:'late stale clone'}
    const newer={...old,messages:[...old.messages,{role:'assistant' as const,content:'new reply'}]}
    let stored=old
    saveSessionToDBMock.mockImplementation(async (payload:ChatSession,_scope:string,options:{expectedSession:ChatSession|null})=>{
      if (JSON.stringify(stored)!==JSON.stringify(options.expectedSession)) throw new Error('conflict')
      stored=payload
    })
    await baseline.persist('scope',newer,()=>old)
    await expect(baseline.persist('scope',stale,()=>old)).rejects.toThrow()
    expect(stored).toEqual(newer)
  })

  it('rejects an unreserved older clone queued behind a newer own write', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const old = session('clone', 'old')
    const newer = {...old,messages:[...old.messages,{role:'assistant' as const,content:'new reply'}]}
    const stale = structuredClone(old)
    let stored = old
    let release!:()=>void
    saveSessionToDBMock.mockImplementationOnce(async (payload: ChatSession) => {
      await new Promise<void>(resolve=>{release=resolve})
      stored=payload
    }).mockImplementation(async (payload: ChatSession, _scope: string, options: {expectedSession: ChatSession | null}) => {
      if (JSON.stringify(stored)!==JSON.stringify(options.expectedSession)) throw new Error('conflict')
      stored=payload
    })
    const pending=baseline.persist('scope',newer,()=>old)
    const queued=baseline.persist('scope',stale,()=>old)
    const observed=queued.catch(error=>error)
    await vi.waitFor(()=>expect(release).toBeDefined())
    release()
    await pending
    expect(await observed).toBeInstanceOf(Error)
    expect(stored).toEqual(newer)
  })

  it('keeps baselines isolated per scope', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const a = session('s1', 'scope a')
    const b = session('s1', 'scope b')

    await baseline.persist('scope-a', a, () => null)
    await baseline.persist('scope-b', b, () => null)

    expect(saveSessionToDBMock.mock.calls).toEqual([
      [a, 'scope-a', { expectedSession: null, pendingSaveOwner: null }],
      [b, 'scope-b', { expectedSession: null, pendingSaveOwner: null }]
    ])
  })

  it('releases a baseline so a later persist re-freezes', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const v1 = session('s1', 'v1')

    await baseline.persist('scope-a', v0, () => null)
    baseline.release('scope-a', 's1')
    const resolve = vi.fn(() => v1)
    await baseline.persist('scope-a', v1, resolve)

    expect(resolve).toHaveBeenCalledTimes(1)
    expect(saveSessionToDBMock).toHaveBeenLastCalledWith(v1, 'scope-a', { expectedSession: v1, pendingSaveOwner: null })
  })

  it('freezes synchronously before enqueue so a later resolver value cannot move the baseline', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const vX = session('s1', 'vX')
    const toSave = session('s1', 'save')
    let current = v0

    const pending = baseline.persist('scope-a', toSave, () => current)
    // Mutate the resolved source AFTER the persist call but BEFORE the queued task runs.
    current = vX
    await pending

    expect(saveSessionToDBMock).toHaveBeenCalledWith(toSave, 'scope-a', { expectedSession: v0, pendingSaveOwner: null })
  })

  it('does not advance a stale in-flight baseline back after reset', async () => {
    const baseline = new ChatSessionSaveBaseline()
    let release!: () => void
    saveSessionToDBMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', session('s1', 'v1'), () => session('s1', 'v0'))
    // Let the queued task start and block inside saveSessionToDB.
    await Promise.resolve()
    baseline.reset()
    release()
    await pending

    // Epoch guard: the pre-reset write must not re-seed a baseline for the stale snapshot.
    expect(baseline.hasBaseline('scope-a', 's1')).toBe(false)
  })

  it('does not let a stale queued save use a baseline frozen by a newer load after reset', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const vOld = session('s1', 'old')
    const vNewLoad = session('s1', 'new-load')
    const staleSave = session('s1', 'stale-write')
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', staleSave, () => vOld)
    await Promise.resolve()
    baseline.reset() // lifecycle reset (e.g. scope switch / reload)
    baseline.freeze('scope-a', 's1', vNewLoad) // new load freezes a new baseline for the same key
    release()
    await pending

    // The stale task must compare against the OLD captured snapshot, never the new-load baseline.
    expect(saveSessionToDBMock).toHaveBeenCalledWith(staleSave, 'scope-a', {
      expectedSession: vOld,
      pendingSaveOwner: null
    })
    // The new-load baseline is left intact for future clean saves.
    expect(baseline.freeze('scope-a', 's1', session('s1', 'ignored'))).toEqual(vNewLoad)
  })

  it('adopts loaded baselines for clean sessions but preserves dirty baselines across a reload', () => {
    const baseline = new ChatSessionSaveBaseline()
    const dirtyV0 = session('dirty', 'unsaved v0')
    const cleanV0 = session('clean', 'clean v0')
    baseline.freeze('scope-a', 'dirty', dirtyV0)
    baseline.freeze('scope-a', 'clean', cleanV0)

    const dirtyDb = session('dirty', 'newer db dirty')
    const cleanDb = session('clean', 'newer db clean')
    baseline.adoptLoaded('scope-a', [dirtyDb, cleanDb], new Set(['dirty']))

    // Dirty session keeps its frozen (unsaved) baseline — no overwrite authority from newer DB.
    expect(baseline.freeze('scope-a', 'dirty', session('dirty', 'x'))).toEqual(dirtyV0)
    // Clean session adopts the freshly loaded snapshot.
    expect(baseline.freeze('scope-a', 'clean', session('clean', 'x'))).toEqual(cleanDb)
  })

  it('skips adoption for a session with an in-flight write', async () => {
    const baseline = new ChatSessionSaveBaseline()
    const v0 = session('s1', 'v0')
    const edit = session('s1', 'edit')
    let release!: () => void
    saveSessionToDBMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )

    const pending = baseline.persist('scope-a', edit, () => v0)
    await Promise.resolve()
    baseline.adoptLoaded('scope-a', [session('s1', 'newer db')], new Set())
    release()
    await pending

    // Adoption must not have replaced the in-flight baseline; CAS compares against the frozen v0.
    expect(saveSessionToDBMock).toHaveBeenCalledWith(edit, 'scope-a', { expectedSession: v0, pendingSaveOwner: null })
    expect(baseline.freeze('scope-a', 's1', session('s1', 'x'))).toEqual(edit)
  })

  const useCasStore = (): Map<string, ChatSession> => {
    const store = new Map<string, ChatSession>()
    saveSessionToDBMock.mockImplementation(
      async (
        saved: ChatSession,
        scope: string,
        options?: { expectedSession: ChatSession | null }
      ) => {
        const key = `${scope}\u0000${saved.id}`
        const current = store.get(key) ?? null
        const expected = options?.expectedSession ?? null
        if (expected === null) {
          if (current) throw new Error('conflict')
        } else if (!current || JSON.stringify(current) !== JSON.stringify(expected)) {
          throw new Error('conflict')
        }
        store.set(key, saved)
      }
    )
    return store
  }

  it('lets a clean window that adopted a newer external snapshot save a legit follow-up without self-conflict', async () => {
    const store = useCasStore()
    const baseline = new ChatSessionSaveBaseline()
    const external = session('s1', 'external new reply')
    store.set('scope-a\u0000s1', external)
    // Clean window adopts the freshly installed external snapshot on refresh.
    baseline.adoptLoaded('scope-a', [external], new Set())

    const follow = session('s1', 'legit follow-up')
    await expect(
      baseline.persist('scope-a', follow, () => session('s1', 'stale'))
    ).resolves.toBeUndefined()
    expect(store.get('scope-a\u0000s1')).toEqual(follow)
  })

  it('keeps a dirty window on its stale baseline so a save after refresh still conflicts', async () => {
    const store = useCasStore()
    const baseline = new ChatSessionSaveBaseline()
    const old = session('s1', 'old local')
    const external = session('s1', 'external new reply')
    store.set('scope-a\u0000s1', external)
    // Frozen while dirty, before the external advance.
    baseline.freeze('scope-a', 's1', old)
    // Refresh must NOT adopt because the key is dirty.
    baseline.adoptLoaded('scope-a', [external], new Set(['s1']))

    await expect(
      baseline.persist('scope-a', session('s1', 'dirty edit'), () => old)
    ).rejects.toThrow('conflict')
    // The external record is preserved (no overwrite).
    expect(store.get('scope-a\u0000s1')).toBe(external)
  })
})
