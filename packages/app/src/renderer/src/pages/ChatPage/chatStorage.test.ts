import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const managedMediaApiMock = vi.hoisted(() => ({
  migrateLegacyDataUrl: vi.fn(),
  reclaimLegacyMigration: vi.fn()
}))

vi.mock('../../utils/windowUtils', () => ({
  api: () => ({ svcManagedMedia: managedMediaApiMock })
}))

type StoreMap = Map<string, Map<string, unknown>>

function cloneValue<T>(value: T): T {
  if (value !== undefined && typeof structuredClone === 'function') {
    return structuredClone(value)
  }
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

class FakeIDBObjectStore {
  constructor(
    private stores: StoreMap,
    private storeName: string,
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
  ) {}

  get(key: string): {
    result?: unknown
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      this.state.getCount += 1
      const value = this.stores.get(this.storeName)?.get(key)
      request.result = value === undefined ? undefined : cloneValue(value)
      request.onsuccess?.()
    }, 0)

    return request
  }

  getAll(): {
    result?: unknown[]
    error?: DOMException
    onsuccess?: () => void
    onerror?: () => void
  } {
    const request: {
      result?: unknown[]
      error?: DOMException
      onsuccess?: () => void
      onerror?: () => void
    } = {}

    setTimeout(() => {
      this.state.getAllCount += 1
      if (this.state.failGetAllOnce) {
        this.state.failGetAllOnce = false
        const error = new Error(
          'Data lost due to missing file. Affected record should be considered irrecoverable'
        )
        error.name = 'NotReadableError'
        request.error = error as DOMException
        request.onerror?.()
        return
      }

      request.result = [...(this.stores.get(this.storeName)?.values() || [])].map((value) =>
        cloneValue(value)
      )
      request.onsuccess?.()
    }, 0)

    return request
  }

  private pendingError: DOMException | null = null

  consumeError(): DOMException | null {
    const error = this.pendingError
    this.pendingError = null
    return error
  }

  put(value: unknown): void {
    if (this.state.failPutOnce) {
      this.state.failPutOnce = false
      this.pendingError = new DOMException('Injected IndexedDB put failure', 'UnknownError')
      return
    }
    const record = value as { storageKey?: string; id?: string }
    const key = record.storageKey || record.id
    if (!key) {
      throw new Error('Missing fake IndexedDB keyPath value')
    }
    this.state.putCount += 1
    this.stores.get(this.storeName)?.set(key, cloneValue(value))
  }

  clear(): void {
    this.state.clearCount += 1
    this.stores.get(this.storeName)?.clear()
  }

  delete(key: string): void {
    this.stores.get(this.storeName)?.delete(key)
  }
}

class FakeIDBTransaction {
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  aborted = false
  abort(): void {
    this.aborted = true
    setTimeout(() => this.onabort?.(), 0)
  }

  constructor(
    private stores: StoreMap,
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
  ) {
    setTimeout(() => {
      if (!this.error && !this.aborted) this.oncomplete?.()
    }, 5)
  }

  objectStore(name: string): FakeIDBObjectStore {
    const store = this.stores.get(name)
    if (!store) {
      throw new Error(`Missing fake object store: ${name}`)
    }
    return new FakeIDBObjectStore(this.stores, name, this.state)
  }
}

class FakeIDBDatabase {
  onclose: (() => void) | null = null
  onversionchange: (() => void) | null = null
  objectStoreNames: { contains: (name: string) => boolean }

  constructor(
    private stores: StoreMap,
    private state: {
      failGetAllOnce: boolean
      failPutOnce: boolean
      getAllCount: number
      getCount: number
      putCount: number
      clearCount: number
    }
  ) {
    this.objectStoreNames = {
      contains: (name: string) => this.stores.has(name)
    }
  }

  createObjectStore(name: string): FakeIDBObjectStore {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map())
    }
    return new FakeIDBObjectStore(this.stores, name, this.state)
  }

  transaction(_name: string, _mode: string): FakeIDBTransaction {
    const tx = new FakeIDBTransaction(this.stores, this.state)
    const originalObjectStore = tx.objectStore.bind(tx)
    tx.objectStore = (name: string) => {
      const store = originalObjectStore(name)
      const originalPut = store.put.bind(store)
      store.put = (value: unknown) => {
        originalPut(value)
        const error = store.consumeError()
        if (error) {
          tx.error = error
          setTimeout(() => tx.onerror?.(), 0)
        }
      }
      return store
    }
    return tx
  }

  close(): void {
    this.onclose?.()
  }
}

function createFakeIndexedDb() {
  const state = {
    failGetAllOnce: true,
    failPutOnce: false,
    getAllCount: 0,
    getCount: 0,
    putCount: 0,
    clearCount: 0
  }
  const deletedNames: string[] = []
  let stores: StoreMap = new Map()
  let database: FakeIDBDatabase | null = null

  return {
    deletedNames,
    state,
    api: {
      open: (_name: string, _version: number) => {
        const request: {
          result?: FakeIDBDatabase
          error?: DOMException
          onupgradeneeded?: (event: { target: { result: FakeIDBDatabase } }) => void
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          if (!database) {
            database = new FakeIDBDatabase(stores, state)
            request.result = database
            request.onupgradeneeded?.({ target: { result: database } })
          }

          request.result = database
          request.onsuccess?.()
        }, 0)

        return request
      },
      deleteDatabase: (name: string) => {
        const request: {
          error?: DOMException
          onsuccess?: () => void
          onerror?: () => void
          onblocked?: () => void
        } = {}

        setTimeout(() => {
          deletedNames.push(name)
          stores = new Map()
          database = null
          request.onsuccess?.()
        }, 0)

        return request
      }
    }
  }
}

describe('chatStorage', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    managedMediaApiMock.migrateLegacyDataUrl.mockReset()
    managedMediaApiMock.reclaimLegacyMigration.mockReset()
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('round-trips versioned team model settings and unknown nested fields while preserving CAS conflicts', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-settings-roundtrip'
    const teamSettings = {
      maxMembers: 4,
      defaultModel: null,
      autoCleanup: false,
      memberModelSelection: { version: 1 as const, profileId: 'fixture-model' },
      futureSettings: { nested: { values: ['alpha', { enabled: true }] }, revision: 7 }
    }
    const original = { id: 'fixture-lead', title: 'original', messages: [], teamSettings }
    await storage.saveSessionToDB(original, scope, { expectedSession: null })
    const loaded = await storage.loadSessionFromDB(original.id, scope)
    expect(loaded).not.toBeNull()
    expect(loaded?.teamSettings).toEqual(teamSettings)

    const edited = { ...loaded!, title: 'unrelated edit' }
    await storage.saveSessionToDB(edited, scope, { expectedSession: loaded })
    const afterEdit = await storage.loadSessionFromDB(original.id, scope)
    expect(afterEdit?.title).toBe('unrelated edit')
    expect(afterEdit?.teamSettings).toEqual(teamSettings)

    const thirdParty = { ...afterEdit!, title: 'third party edit' }
    await storage.saveSessionToDB(thirdParty, scope, { expectedSession: afterEdit })
    await expect(storage.saveSessionToDB({ ...afterEdit!, title: 'stale edit' }, scope, { expectedSession: afterEdit }))
      .rejects.toBeInstanceOf(storage.ChatSessionSaveConflictError)
    const final = await storage.loadSessionFromDB(original.id, scope)
    expect(final?.title).toBe('third party edit')
    expect(final?.teamSettings).toEqual(teamSettings)
  })

  it('marks queued channel receipts unknown and persists recovery on load', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-receipt-recovery'
    const lead: import('./chatStorage').ChatSession = {
      id: 'receipt-recovery-lead',
      title: 'Lead',
      messages: [],
      teamMessageReceipts: [
        {
          version: 1,
          id: 'message-1',
          recipientId: 'member-1',
          teamKey: 'team-key',
          text: 'hello',
          state: 'queued',
          createdAt: 1,
          updatedAt: 1
        },
        {
          version: 1,
          id: 'message-2',
          recipientId: 'member-1',
          teamKey: 'team-key',
          text: 'already confirmed',
          state: 'acknowledged',
          createdAt: 2,
          updatedAt: 2
        }
      ]
    }

    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    expect(fakeIndexedDb.state.putCount).toBe(1)

    const recovered = await storage.loadSessionFromDB(lead.id, scope)
    expect(recovered?.teamMessageReceipts).toEqual([
      expect.objectContaining({ id: 'message-1', state: 'unknown' }),
      expect.objectContaining({ id: 'message-2', state: 'acknowledged' })
    ])
    expect(fakeIndexedDb.state.putCount).toBe(2)

    const secondLoad = await storage.loadSessionFromDB(lead.id, scope)
    expect(secondLoad?.teamMessageReceipts).toEqual(recovered?.teamMessageReceipts)
    expect(fakeIndexedDb.state.putCount).toBe(2)
  })

  it('recovers queued channel receipts when listing all sessions', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-receipt-list-recovery'
    const lead: import('./chatStorage').ChatSession = {
      id: 'receipt-list-recovery-lead',
      title: 'Lead',
      messages: [],
      teamMessageReceipts: [{
        version: 1,
        id: 'message-list-1',
        recipientId: 'member-1',
        teamKey: 'team-key',
        text: 'hello from list',
        state: 'queued',
        createdAt: 1,
        updatedAt: 1
      }]
    }

    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    const loaded = await storage.loadAllSessions(scope)

    expect(loaded).toEqual([
      expect.objectContaining({
        id: lead.id,
        teamMessageReceipts: [expect.objectContaining({ id: 'message-list-1', state: 'unknown' })]
      })
    ])
    expect(fakeIndexedDb.state.putCount).toBe(2)
  })

  it.each([
    { name: 'present undefined marker', after: { memberModelSelection: undefined } },
    { name: 'future version marker', after: { memberModelSelection: { version: 7, profileId: 'fixture' } } }
  ])('rejects a stale CAS instead of erasing a $name', async ({ after }) => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-undefined-marker'
    const base = { id: 'fixture-marker-lead', title: 'Lead', messages: [], teamSettings: { maxMembers: 4, defaultModel: null, autoCleanup: false } }
    await storage.saveSessionToDB(base, scope, { expectedSession: null })
    const old = await storage.loadSessionFromDB(base.id, scope)
    expect(old).not.toBeNull()
    const thirdParty = { ...old!, teamSettings: { ...old!.teamSettings!, ...after } } as unknown as import('./chatStorage').ChatSession
    // The current client intentionally forbids marker transitions. Simulate an independent
    // historical/other-version writer, without using the API whose guard is under test.
    const dbRequest = fakeIndexedDb.api.open('fixture', 2)
    const db = await new Promise<FakeIDBDatabase>(resolve => { dbRequest.onsuccess = () => resolve(dbRequest.result!) })
    db.transaction('sessions-v2', 'readwrite').objectStore('sessions-v2').put({ ...thirdParty, storageKey: `${scope}\u0000${base.id}` })
    const saved = await storage.loadSessionFromDB(base.id, scope)
    expect(Object.hasOwn(saved!.teamSettings!, 'memberModelSelection')).toBe(true)
    expect(storage.normalizedSessionsEqual(saved!, old!, scope)).toBe(false)
    const unrelatedEdit = { ...old!, teamSettings: { ...old!.teamSettings!, maxMembers: 5 } }
    await expect(storage.saveSessionToDB(unrelatedEdit, scope, { expectedSession: old })).rejects.toBeInstanceOf(storage.ChatSessionSaveConflictError)
    const final = await storage.loadSessionFromDB(base.id, scope)
    expect(Object.hasOwn(final!.teamSettings!, 'memberModelSelection')).toBe(true)
    expect(final!.teamSettings?.maxMembers).toBe(4)
    expect(final!.teamSettings!.memberModelSelection).toEqual(after.memberModelSelection)
  })

  it('keeps the marker if an in-place updater mutates a detached candidate', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-marker-updater'
    const lead: import('./chatStorage').ChatSession = {
      id: 'marker-updater-lead', title: 'Lead', messages: [],
      teamSettings: { maxMembers: 4, defaultModel: null, autoCleanup: false, memberModelSelection: { version: 1, profileId: 'fixture' } }
    }
    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    const snapshot = await storage.loadSessionFromDB(lead.id, scope)
    const result = await storage.compareAndUpdateSessionInDB(lead.id, scope, {
      expectedSession: snapshot!,
      update: current => {
        delete current.teamSettings!.memberModelSelection
        return current
      }
    })
    expect(result).toBeNull()
    const saved = await storage.loadSessionFromDB(lead.id, scope)
    expect(saved?.teamSettings?.memberModelSelection).toEqual({ version: 1, profileId: 'fixture' })
  })

  it('rejects in-place mutation of an unknown nested marker field and permits unrelated updates', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-marker-opaque'
    const marker: { version: 1; profileId: string; future: { guarded?: undefined } } = { version: 1, profileId: 'fixture', future: { guarded: undefined } }
    const lead: import('./chatStorage').ChatSession = {
      id: 'marker-opaque-lead', title: 'Lead', messages: [],
      teamSettings: { maxMembers: 4, defaultModel: null, autoCleanup: false, memberModelSelection: marker }
    }
    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    const snapshot = (await storage.loadSessionFromDB(lead.id, scope))!
    const rejected = await storage.compareAndUpdateSessionInDB(lead.id, scope, {
      expectedSession: snapshot,
      update: current => {
        const value = current.teamSettings!.memberModelSelection as typeof marker
        delete value.future.guarded
        return current
      }
    })
    expect(rejected).toBeNull()
    const afterReject = (await storage.loadSessionFromDB(lead.id, scope))!
    expect(Object.hasOwn((afterReject.teamSettings!.memberModelSelection as typeof marker).future, 'guarded')).toBe(true)
    const accepted = await storage.compareAndUpdateSessionInDB(lead.id, scope, {
      expectedSession: afterReject,
      update: current => ({ ...current, title: 'Updated' })
    })
    expect(accepted?.title).toBe('Updated')
    expect(Object.hasOwn((accepted!.teamSettings!.memberModelSelection as typeof marker).future, 'guarded')).toBe(true)
  })

  it('rejects a stale snapshot that drops an undefined nested future marker field', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-marker-stale-nested'
    const marker: { version: 1; profileId: string; future: { guarded?: undefined } } = { version: 1, profileId: 'fixture', future: { guarded: undefined } }
    const lead: import('./chatStorage').ChatSession = {
      id: 'marker-stale-nested', title: 'Lead', messages: [],
      teamSettings: { maxMembers: 4, defaultModel: null, autoCleanup: false,
        memberModelSelection: marker }
    }
    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    const saved = (await storage.loadSessionFromDB(lead.id, scope))!
    const stale = structuredClone(saved)
    delete (stale.teamSettings!.memberModelSelection as typeof marker).future.guarded
    expect(storage.normalizedSessionsEqual(saved, stale, scope)).toBe(false)
    await expect(storage.saveSessionToDB({ ...stale, title: 'stale edit' }, scope, { expectedSession: stale })).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    const after = (await storage.loadSessionFromDB(lead.id, scope))!
    const persistedMarker = after.teamSettings!.memberModelSelection as typeof marker
    expect(after.title).toBe('Lead')
    expect(Object.hasOwn(persistedMarker.future, 'guarded')).toBe(true)
  })

  it('rejects a whole-session save that removes a stored marker even with a matched baseline', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const scope = 'fixture-marker-removal'
    const lead: import('./chatStorage').ChatSession = {
      id: 'marker-removal', title: 'Lead', messages: [],
      teamSettings: { maxMembers: 4, defaultModel: null, autoCleanup: false,
        memberModelSelection: { version: 1, profileId: 'fixture' } }
    }
    await storage.saveSessionToDB(lead, scope, { expectedSession: null })
    const saved = (await storage.loadSessionFromDB(lead.id, scope))!
    const removing = structuredClone(saved)
    delete removing.teamSettings!.memberModelSelection
    await expect(storage.saveSessionToDB(removing, scope, { expectedSession: saved })).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    await expect(storage.saveSessionToDB(removing, scope)).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    expect((await storage.loadSessionFromDB(lead.id, scope))?.teamSettings?.memberModelSelection).toEqual({ version: 1, profileId: 'fixture' })
  })

  it('persists only explicit member choice and rejects ordinary writes and stale snapshots', async () => {
    const fakeIndexedDb = createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce = false; vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const lead = { id: 'lead', title: 'Lead', messages: [], profileId: 'leader' }
    const member = { id: 'member', title: 'Member', messages: [], teamLeadId: 'lead', teamMemberName: 'writer', profileId: 'leader', sessionUrl: 'old', sessionProfileId: 'leader', sessionRouteFingerprint: 'old' }
    await storage.saveSessionToDB(lead, 'scope')
    const admitted = (await storage.createTeamMemberInDB({ scope: 'scope', expectedLead: lead, member })).member
    const selected = await storage.setTeamMemberModelChoiceInDB({ scope: 'scope', expectedLead: lead, expectedMember: admitted, profileId: 'explicit' })
    expect(selected.member.memberModelChoice).toEqual({ version: 1, profileId: 'explicit' })
    expect(selected.member.sessionUrl).toBeUndefined()
    expect(selected.member.sessionProfileId).toBeUndefined()
    expect(selected.member.sessionRouteFingerprint).toBeUndefined()
    expect((await storage.loadSessionFromDB('member', 'scope'))?.profileId).toBe('leader')
    await expect(storage.saveSessionToDB(admitted, 'scope')).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    await expect(storage.saveSessionToDB({ ...selected.member, memberModelChoice: { version: 1, profileId: 'other' } }, 'scope', { expectedSession: selected.member })).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    await expect(storage.compareAndUpdateSessionInDB('member', 'scope', { expectedSession: selected.member, update: s => ({ ...s, memberModelChoice: undefined }) })).resolves.toBeNull()
    await expect(storage.setTeamMemberModelChoiceInDB({ scope: 'scope', expectedLead: lead, expectedMember: admitted, profileId: 'other' })).rejects.toThrow()
    await expect(storage.saveSessionToDB({ ...member, id: 'forged', memberModelChoice: { version: 1, profileId: 'x' } }, 'scope')).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    const ended = await storage.endTeamInDB({ scope: 'scope', expectedLead: lead })
    await expect(storage.setTeamMemberModelChoiceInDB({ scope: 'scope', expectedLead: ended.lead, expectedMember: ended.members[0], profileId: 'other' })).rejects.toThrow()
  })

  it('fences repeated selection, changed lead generation, identity and third-party marker writes', async () => {
    const fakeIndexedDb = createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce = false; vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const lead = { id: 'lead', title: 'Lead', messages: [], teamGeneration: 2 }
    const member = { id: 'member', title: 'Member', messages: [], teamLeadId: 'lead', teamMemberName: 'writer' }
    await storage.saveSessionToDB(lead, 'scope')
    const admitted = (await storage.createTeamMemberInDB({ scope: 'scope', expectedLead: lead, member })).member
    const select = (expectedLead: typeof lead, expectedMember: typeof admitted, profileId: string, shouldUpdate?: () => boolean) => storage.setTeamMemberModelChoiceInDB({ scope: 'scope', expectedLead, expectedMember, profileId, shouldUpdate })
    const original = await storage.loadSessionFromDB('member', 'scope')
    await expect(select({ ...lead, teamGeneration: 1 }, admitted, 'wrong')).rejects.toThrow()
    await expect(select(lead, { ...admitted, teamLeadId: 'other' }, 'wrong')).rejects.toThrow()
    await expect(select(lead, admitted, 'wrong', () => false)).rejects.toThrow()
    expect(await storage.loadSessionFromDB('member', 'scope')).toEqual(original)
    const chosen = (await select(lead, admitted, 'chosen')).member
    await expect(select(lead, admitted, 'duplicate')).rejects.toThrow()
    await expect(storage.saveSessionToDB({ ...chosen, memberModelChoice: { version: 1, profileId: 'external' } }, 'scope')).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
    await expect(storage.compareAndUpdateSessionInDB('member', 'scope', { expectedSession: chosen, update: current => ({ ...current, memberModelChoice: { version: 1, profileId: 'external' } }) })).resolves.toBeNull()
    expect((await storage.loadSessionFromDB('member', 'scope'))?.memberModelChoice).toEqual({ version: 1, profileId: 'chosen' })
  })

  it('commits a team generation and enforces stored name, capacity, scope and stale-lead checks', async () => {
    const fakeIndexedDb = createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce = false; vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const lead = {id:'lead',title:'Lead',messages:[],profileId:'base',teamSettings:{maxMembers:1,defaultModel:null,autoCleanup:true}}
    const member = {id:'member',title:'Writer',messages:[],teamLeadId:'lead',teamMemberName:'writer'}
    await storage.saveSessionToDB(lead,'team-scope')
    await storage.saveSessionToDB({...member,id:'other-scope'},'other-scope')
    const admitted = await storage.createTeamMemberInDB({scope:'team-scope',expectedLead:lead,member})
    expect(admitted.member.teamMemberGeneration).toBe(0)
    await expect(storage.createTeamMemberInDB({scope:'team-scope',expectedLead:lead,member:{...member,id:'member-2',teamMemberName:'other'}})).rejects.toThrow('full')
    const ended = await storage.endTeamInDB({scope:'team-scope',expectedLead:lead})
    expect(ended.lead).toMatchObject({teamGeneration:1,teamEnded:true})
    expect(ended.members).toEqual([expect.objectContaining({id:'member',archived:true})])
    expect(await storage.loadSessionFromDB('member','team-scope')).toMatchObject({archived:true})
    expect(await storage.loadSessionFromDB('other-scope','other-scope')).not.toHaveProperty('archived',true)
    await expect(storage.createTeamMemberInDB({scope:'team-scope',expectedLead:lead,member:{...member,id:'stale'}})).rejects.toThrow('changed')
    await expect(storage.createTeamMemberInDB({scope:'team-scope',expectedLead:ended.lead,member:{...member,id:'fresh'}})).rejects.toThrow('changed')
    expect(await storage.loadSessionFromDB('lead','team-scope')).toMatchObject({teamEnded:true})
  })

  it('keeps retained members but advances their lifecycle revision when cleanup is disabled', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const lead={id:'lead',title:'Lead',messages:[],teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}}
    const member={id:'member',title:'Member',messages:[],teamLeadId:'lead',teamMemberName:'writer'}
    await storage.saveSessionToDB(lead,'scope')
    await storage.createTeamMemberInDB({scope:'scope',expectedLead:lead,member})
    const ended=await storage.endTeamInDB({scope:'scope',expectedLead:lead})
    expect(ended.lead).toMatchObject({teamGeneration:1,teamLifecycleRevision:1})
    expect(ended.members[0]).toMatchObject({teamMemberGeneration:0,teamLifecycleRevision:1})
    expect(ended.members[0].archived).not.toBe(true)
    await expect(storage.saveSessionToDB({...member,teamMemberGeneration:0},'scope',{expectedSession:{...member,teamMemberGeneration:0}})).rejects.toThrow('changed')
  })

  it.each([false,true])('rejects stale lifecycle payloads after End (autoCleanup=%s)', async (autoCleanup) => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const lead={id:'lead',title:'Lead',messages:[],teamSettings:{maxMembers:6,defaultModel:null,autoCleanup}}
    const member={id:'member',title:'Member',messages:[],teamLeadId:'lead',teamMemberName:'writer'}
    await storage.saveSessionToDB(lead,'scope')
    const admitted=(await storage.createTeamMemberInDB({scope:'scope',expectedLead:lead,member})).member
    const ended=await storage.endTeamInDB({scope:'scope',expectedLead:lead})
    await expect(storage.saveSessionToDB({...lead,title:'late timer'},'scope',{expectedSession:ended.lead})).rejects.toThrow('changed')
    await expect(storage.saveSessionToDB({...admitted,title:'late timer'},'scope')).rejects.toThrow('changed')
    expect(await storage.loadSessionFromDB('lead','scope')).toMatchObject({teamGeneration:1,teamLifecycleRevision:1})
    expect(await storage.loadSessionFromDB('member','scope')).toMatchObject({teamLifecycleRevision:1, ...(autoCleanup?{archived:true}:{})})
    const bypass=await storage.compareAndUpdateSessionInDB('lead','scope',{expectedSession:ended.lead,update:current=>({...current,teamGeneration:0})})
    expect(bypass).toBeNull()
    await expect(storage.saveAllSessions([lead,member],'scope')).rejects.toThrow('Bulk replacement')
  })

  it('retries only a CAS-matched superseded live snapshot and acknowledges the actual latest object', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    const base = { id: 'retry-live', title: 'base', messages: [] }
    const first = { ...base, title: 'first' }
    const latest = { ...base, title: 'latest' }
    await storage.saveSessionToDB(base, 'scope')
    const writer = new ChatSessionSaveBaseline()
    writer.freeze('scope', base.id, base)
    let live = first
    let reads = 0
    const saved = await writer.persistLatest('scope', base.id, () => {
      if (++reads === 2) live = latest
      return live
    }, () => base, undefined, true)
    expect(saved).toBe(latest)
    expect(writer.isAcknowledgementCurrent('scope', latest)).toBe(true)
    expect(writer.isAcknowledgementCurrent('scope', first)).toBe(false)
    expect((await storage.loadSessionFromDB(base.id, 'scope'))?.title).toBe('latest')
  })

  it('runs queued lead transformation once while pure lookup is rechecked during supersession', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    const base = { id: 'prepared-lead', title: 'lead', messages: [] as { role: 'user'; content: string }[] }
    await storage.saveSessionToDB(base, 'scope')
    const writer = new ChatSessionSaveBaseline()
    writer.freeze('scope', base.id, base)
    let live = base
    let reads = 0
    const prepare = vi.fn(() => { live = { ...live, title: 'task done' }; return live })
    const result = await writer.persistLatest('scope', base.id, () => {
      if (++reads === 1) live = { ...live, messages: [{ role: 'user', content: 'new lead message' }] }
      return live
    }, () => base, undefined, true, prepare)
    expect(prepare).toHaveBeenCalledOnce()
    expect(result).toBe(live)
    expect(await storage.loadSessionFromDB(base.id, 'scope')).toMatchObject(live)
  })

  it('bounds repeated local supersession without advancing the frozen baseline', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const { ChatSessionSaveBaseline } = await import('./chatSaveBaseline')
    const base = { id: 'retry-limit', title: 'base', messages: [] }
    await storage.saveSessionToDB(base, 'scope')
    const writer = new ChatSessionSaveBaseline()
    writer.freeze('scope', base.id, base)
    let count = 0
    await expect(writer.persistLatest('scope', base.id, () => ({ ...base, title: `v${++count}` }), () => base, undefined, true))
      .rejects.toBeInstanceOf(storage.ChatSessionSaveSupersededError)
    expect(count).toBe(6)
    expect((await storage.loadSessionFromDB(base.id, 'scope'))?.title).toBe('base')
  })

  it('runs the real debounce callback through a fenced baseline after End', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const lead={id:'lead',title:'Lead',messages:[],teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}}
    await storage.saveSessionToDB(lead,'scope')
    const writer=new ChatSessionSaveBaseline()
    writer.freeze('scope','lead',lead)
    let finish!: (error:unknown)=>void
    const outcome=new Promise<unknown>(resolve=>{finish=resolve})
    // A second module instance represents another renderer's independent debounce queue.
    storage.debouncedSaveSessions([{...lead,title:'stale delayed edit'}],250,'scope',{
      saveOne: session=>writer.persist('scope',session,()=>lead),
      onError:error=>finish(error), onSuccess:()=>finish(null)
    })
    vi.resetModules()
    const otherWindow=await import('./chatStorage')
    const ended=await otherWindow.endTeamInDB({scope:'scope',expectedLead:lead})
    writer.fenceAndAdvance('scope','lead',ended.lead)
    expect(await outcome).toBeInstanceOf(Error)
    expect(await storage.loadSessionFromDB('lead','scope')).toMatchObject({title:'Lead',teamGeneration:1,teamLifecycleRevision:1})
  })

  it.each([false, true])('prevents a reserved old debounce payload from overwriting a newer immediate save (timerStarts=%s)', async (timerStarts) => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const writer=new ChatSessionSaveBaseline()
    const original={id:'lineage',title:'original',messages:[]}
    const older={...original,title:'older pending'}
    const newer={...original,title:'newer immediate'}
    await storage.saveSessionToDB(original,'scope')
    writer.reserve('scope',older,()=>original)
    let finish!: (error:unknown)=>void
    let begin!: () => void
    const begun=new Promise<void>(resolve=>{begin=resolve})
    let release!:()=>void
    const barrier=new Promise<void>(resolve=>{release=resolve})
    const result=new Promise<unknown>(resolve=>{finish=resolve})
    storage.debouncedSaveSessions([older],1,'scope',{
      owner:writer,
      onDiscard:session=>writer.discardReservation('scope',session),
      saveOne:async session=>{begin(); if(timerStarts) await barrier; return writer.persist('scope',session,()=>original)},
      onSuccess:()=>finish(null),onError:error=>finish(error)
    })
    if(timerStarts) await begun
    writer.supersedeReservations('scope',older.id,newer)
    await writer.persist('scope',newer,()=>original)
    release()
    expect(await result).toBeInstanceOf(Error)
    expect(await storage.loadSessionFromDB('lineage','scope')).toMatchObject({title:'newer immediate'})
  })

  it('does not give a newly reserved stale clone a completed own write as its baseline', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const {ChatSessionSaveBaseline} = await import('./chatSaveBaseline')
    const writer = new ChatSessionSaveBaseline()
    const original = {id:'reserved-stale',title:'original',messages:[{role:'user' as const,content:'question'}]}
    const newer = {...original,messages:[...original.messages,{role:'assistant' as const,content:'new reply'}]}
    const stale = {...structuredClone(original),title:'independent stale edit'}
    await storage.saveSessionToDB(original,'scope')
    await writer.persist('scope',newer,()=>original)
    let failure: unknown
    try {
      writer.reserve('scope',stale,()=>original)
      await writer.persist('scope',stale,()=>original)
    } catch (error) {
      failure = error
    }
    expect(await storage.loadSessionFromDB('reserved-stale','scope')).toMatchObject({title:'original',messages:newer.messages})
    expect(failure).toBeInstanceOf(Error)
  })

  it('does not treat an independent value-prefix branch as a proven in-flight descendant', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const {ChatSessionSaveBaseline} = await import('./chatSaveBaseline')
    const writer = new ChatSessionSaveBaseline()
    const original = {id:'independent-branch',title:'thread',messages:[]}
    const first = {...original,messages:[{role:'user' as const,content:'question'}]}
    // Constructed independently from original, not from first, even though the values share a prefix.
    const independent = {...original,messages:[{role:'user' as const,content:'question'},{role:'assistant' as const,content:'other branch'}]}
    await storage.saveSessionToDB(original,'scope')
    const pending = writer.persist('scope',first,()=>original)
    let failure: unknown
    try {
      writer.reserve('scope',independent,()=>original)
      await pending
      await writer.persist('scope',independent,()=>original)
    } catch (error) {
      failure = error
      await pending
    }
    expect(await storage.loadSessionFromDB('independent-branch','scope')).toMatchObject({messages:first.messages})
    expect(failure).toBeInstanceOf(Error)
  })

  it('persists a descendant registered while its own predecessor is still in flight', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const writer=new ChatSessionSaveBaseline()
    const original={id:'own-chain',title:'original',messages:[]}
    const first={...original,messages:[{role:'user' as const,content:'first'}]}
    const latest={...first,messages:[...first.messages,{role:'assistant' as const,content:'latest'}]}
    await storage.saveSessionToDB(original,'scope')
    const pending=writer.persist('scope',first,()=>original)
    writer.reserve('scope',latest,()=>original)
    await pending
    await writer.persist('scope',latest,()=>original)
    expect(await storage.loadSessionFromDB('own-chain','scope')).toMatchObject({messages:latest.messages})
  })

  it('rejects a guarded save when a delete tombstone prevents any commit', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const original={id:'guarded-deleted',title:'original',messages:[]}
    await storage.saveSessionToDB(original,'scope')
    storage.setSessionDeleteTombstone(original.id,'scope')
    try {
      await expect(storage.saveSessionToDB({...original,title:'unsaved'},'scope',{expectedSession:original})).rejects.toThrow()
      expect(await storage.loadSessionFromDB(original.id,'scope')).toMatchObject({title:'original'})
    } finally { storage.setSessionDeleteTombstone(original.id,'scope',false) }
  })

  it('resolves debounced state at execution time and does not restore the registered old object', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const writer=new ChatSessionSaveBaseline()
    const original={id:'latest-debounce',title:'original',messages:[]}
    const stale={...original,title:'old timer'}
    const latest={...original,title:'new immediate',messages:[{role:'assistant' as const,content:'reply'}]}
    let current: import('./chatStorage').ChatSession = stale
    await storage.saveSessionToDB(original,'scope')
    writer.freeze('scope',original.id,original)
    let finish!:(value:unknown)=>void
    const outcome=new Promise<unknown>(resolve=>{finish=resolve})
    storage.debouncedSaveSessions([stale],40,'scope',{
      owner:writer,
      saveLatest:(id,scope)=>writer.persistLatest(scope,id,()=>current,()=>original),
      onSuccess:saved=>finish(saved),onError:error=>finish(error)
    })
    current=latest
    await writer.persistLatest('scope',original.id,()=>current,()=>original)
    expect(await outcome).toEqual([latest])
    expect(await storage.loadSessionFromDB(original.id,'scope')).toMatchObject({title:'new immediate',messages:latest.messages})
  })

  it('serializes non-append updates and resolves the current state after the previous write', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const writer=new ChatSessionSaveBaseline()
    const original={id:'latest-queue',title:'original',messages:[]}
    const placeholder={...original,messages:[{role:'assistant' as const,content:''}]}
    const finished={...original,title:'renamed',messages:[{role:'assistant' as const,content:'finished'}]}
    await storage.saveSessionToDB(original,'scope')
    writer.freeze('scope',original.id,original)
    let current=placeholder
    let started!:()=>void
    const begun=new Promise<void>(resolve=>{started=resolve})
    const first=writer.persistLatest('scope',original.id,()=>{started();return current},()=>original)
    await begun
    current=finished
    const second=writer.persistLatest('scope',original.id,()=>current,()=>original)
    const [firstOutcome,secondOutcome]=await Promise.allSettled([first,second])
    expect(firstOutcome.status).toBe('rejected')
    expect(secondOutcome.status).toBe('fulfilled')
    expect(await storage.loadSessionFromDB(original.id,'scope')).toMatchObject({title:'renamed',messages:finished.messages})
  })

  it('reports each debounced batch item independently when one writer rejects', async () => {
    const storage=await import('./chatStorage')
    const succeeded={id:'batch-ok',title:'ok',messages:[]}
    const conflicted={id:'batch-conflict',title:'conflict',messages:[]}
    const onSuccess=vi.fn()
    const onError=vi.fn()
    const log=vi.spyOn(console,'error').mockImplementation(()=>{})
    try {
      storage.debouncedSaveSessions([succeeded,conflicted],1,'batch-scope',{
        owner:{},
        saveOne:async session=>{if(session.id===conflicted.id)throw new Error('conflict')},
        onSuccess,onError
      })
      await vi.waitFor(()=>{
        expect(onSuccess).toHaveBeenCalledWith([succeeded])
        expect(onError).toHaveBeenCalledWith(expect.any(Error),[conflicted])
      })
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onError).toHaveBeenCalledTimes(1)
    } finally {log.mockRestore()}
  })

  it('isolates coalesced writers in the same scope and preserves each owner callback', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const ownerA={}, ownerB={}
    const callsA: string[]=[], callsB: string[]=[]
    const doneA=new Promise<void>((resolve,reject)=>storage.debouncedSaveSessions(
      [{id:'session-a',title:'A',messages:[]}],1,'scope',
      {owner:ownerA,saveOne:async session=>{callsA.push(session.id)},onSuccess:()=>resolve(),onError:reject}))
    const doneB=new Promise<void>((resolve,reject)=>storage.debouncedSaveSessions(
      [{id:'session-b',title:'B',messages:[]}],1,'scope',
      {owner:ownerB,saveOne:async session=>{callsB.push(session.id)},onSuccess:()=>resolve(),onError:reject}))
    await Promise.all([doneA,doneB])
    expect(callsA).toEqual(['session-a'])
    expect(callsB).toEqual(['session-b'])
  })

  it('rejects a stale pane write instead of borrowing another pane baseline', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const {ChatSessionSaveBaseline}=await import('./chatSaveBaseline')
    const writerA=new ChatSessionSaveBaseline(), writerB=new ChatSessionSaveBaseline()
    const first={id:'shared',title:'old',messages:[]}
    const newer={...first,title:'newer saved history'}
    await storage.saveSessionToDB(newer,'scope')
    writerA.freeze('scope',first.id,first)
    writerB.freeze('scope',newer.id,newer)
    const other={id:'other',title:'other',messages:[]}
    await storage.saveSessionToDB(other,'scope')
    const outcomes: unknown[]=[]
    const doneA=new Promise<void>(resolve=>storage.debouncedSaveSessions([{...first,title:'stale edit'}],1,'scope',{
      owner:writerA,saveOne:session=>writerA.persist('scope',session,()=>first),
      onSuccess:()=>{outcomes.push('unexpected success');resolve()},onError:error=>{outcomes.push(error);resolve()}
    }))
    const doneB=new Promise<void>(resolve=>storage.debouncedSaveSessions([{...other,title:'other edit'}],1,'scope',{
      owner:writerB,saveOne:session=>writerB.persist('scope',session,()=>other),
      onSuccess:()=>{outcomes.push('other success');resolve()},onError:error=>{outcomes.push(error);resolve()}
    }))
    await Promise.all([doneA,doneB])
    expect(outcomes.filter(value=>value instanceof Error)).toHaveLength(1)
    expect(outcomes).toContain('other success')
    expect(await storage.loadSessionFromDB('shared','scope')).toMatchObject({title:'newer saved history'})
  })

  it('does not allow compare-and-update to mutate a lifecycle or ID in place', async () => {
    const fakeIndexedDb=createFakeIndexedDb(); fakeIndexedDb.state.failGetAllOnce=false; vi.stubGlobal('indexedDB',fakeIndexedDb.api)
    const storage=await import('./chatStorage')
    const lead={id:'lead',title:'Lead',messages:[],teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}}
    await storage.saveSessionToDB(lead,'scope')
    const ended=await storage.endTeamInDB({scope:'scope',expectedLead:lead})
    const result=await storage.compareAndUpdateSessionInDB('lead','scope',{
      expectedSession:ended.lead,update:current=>{current.teamGeneration=0;current.teamLifecycleRevision=0;current.id='forged';return current}
    })
    expect(result).toBeNull()
    expect(await storage.loadSessionFromDB('lead','scope')).toMatchObject({id:'lead',teamGeneration:1,teamLifecycleRevision:1})
    expect(await storage.loadSessionFromDB('forged','scope')).toBeNull()
  })

  it('isolates predicate mutations from the stored session and updater', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const lead = { id: 'lead', title: 'Lead', messages: [{role: 'user' as const, content: 'original'}], teamSettings: {maxMembers: 6, defaultModel: null, autoCleanup: false} }
    await storage.saveSessionToDB(lead, 'scope')
    const ended = await storage.endTeamInDB({scope: 'scope', expectedLead: lead})
    const result = await storage.compareAndUpdateSessionInDB('lead', 'scope', {
      expectedSession: ended.lead,
      shouldUpdate: current => {
        current.teamGeneration = 0
        current.teamLifecycleRevision = 0
        current.id = 'forged'
        current.messages[0].content = 'forged history'
        return true
      },
      update: current => current
    })
    expect(result).toMatchObject({id: 'lead', teamGeneration: 1, teamLifecycleRevision: 1, messages: [{content: 'original'}]})
    expect(await storage.loadSessionFromDB('lead', 'scope')).toMatchObject({id: 'lead', teamGeneration: 1, teamLifecycleRevision: 1, messages: [{content: 'original'}]})
    expect(await storage.loadSessionFromDB('forged', 'scope')).toBeNull()
  })

  it('loads a single normalized session by id without reading every session', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Target session',
        messages: [],
        pendingSessionUrl: 'https://example.test/session-1'
      } as import('./chatStorage').ChatSession & { pendingSessionUrl: string },
      'default'
    )
    await storage.saveSessionToDB(
      {
        id: 'session-2',
        title: 'Other session',
        messages: []
      },
      'default'
    )

    const readsBeforeLoad = fakeIndexedDb.state.getCount
    await expect(storage.loadSessionFromDB('session-1', 'default')).resolves.toMatchObject({
      id: 'session-1',
      title: 'Target session',
      messages: [],
      sessionUrl: 'https://example.test/session-1',
      storageScope: 'default'
    })
    expect(fakeIndexedDb.state.getCount - readsBeforeLoad).toBe(1)
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
    expect(fakeIndexedDb.deletedNames).toEqual([])
  })

  it('retains tool results through scoped IndexedDB save/reopen and searches only the requested loaded session', async () => {
    const fakeIndexedDb = createFakeIndexedDb(); vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const { searchAgentSessionArchive } = await import('./agentArchiveSearch')
    const receipt = { runId: 'r', toolCallId: 'c', toolName: 'files.read', status: 'completed' as const, args: { hidden: 'ARGS_SECRET' }, content: 'saved blue receipt', metadata: { hidden: 'META_SECRET' } }
    await storage.saveSessionToDB({ id: 'same-id', title: 'First', messages: [{ role: 'assistant', content: '', toolHistory: [receipt] }] }, 'scope-a')
    await storage.saveSessionToDB({ id: 'same-id', title: 'Second', messages: [{ role: 'assistant', content: '', toolHistory: [{ ...receipt, content: 'other blue receipt' }] }] }, 'scope-b')
    const session = await storage.loadSessionFromDB('same-id', 'scope-a')
    expect(session?.messages[0].toolHistory).toEqual([receipt])
    const output = await searchAgentSessionArchive(session!.messages, { query: 'blue', source: 'tools' })
    expect(output.matches).toEqual([expect.objectContaining({ excerpt: 'saved blue receipt', toolName: 'files.read' })])
    expect(JSON.stringify(output)).not.toMatch(/other blue|ARGS_SECRET|META_SECRET/)
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
  })

  it('returns null for missing sessions and sessions in another storage scope', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Scoped session',
        messages: []
      },
      'workspace-a'
    )

    const readsBeforeLoad = fakeIndexedDb.state.getCount
    await expect(storage.loadSessionFromDB('session-1', 'default')).resolves.toBeNull()
    await expect(storage.loadSessionFromDB('missing-session', 'workspace-a')).resolves.toBeNull()
    expect(fakeIndexedDb.state.getCount - readsBeforeLoad).toBe(2)
    expect(fakeIndexedDb.state.getAllCount).toBe(0)
  })

  it('persists scoped delete tombstones across remounts', async () => {
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('session-a', 'workspace-a')
    storage.setSessionDeleteTombstone('session-b', 'workspace-b')
    localStorage.setItem('magicpot-chat-delete-tombstone:%E0%A4%A:broken', '1')

    expect(storage.readSessionDeleteTombstones()).toEqual(
      expect.arrayContaining([
        { scope: 'workspace-a', sessionId: 'session-a' },
        { scope: 'workspace-b', sessionId: 'session-b' }
      ])
    )

    storage.setSessionDeleteTombstone('session-a', 'workspace-a', false)
    expect(storage.readSessionDeleteTombstones()).toEqual([
      { scope: 'workspace-b', sessionId: 'session-b' }
    ])
    storage.setSessionDeleteTombstone('session-b', 'workspace-b', false)
    localStorage.removeItem('magicpot-chat-delete-tombstone:%E0%A4%A:broken')
    expect(storage.readSessionDeleteTombstones()).toEqual([])
  })

  it('debounces targeted session upserts without scanning or clearing the store', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    await storage.saveSessionToDB({ id: 'session-a', title: 'A', messages: [] }, 'workspace-a')
    await storage.saveSessionToDB({ id: 'session-b', title: 'B', messages: [] }, 'workspace-a')
    await storage.saveSessionToDB(
      { id: 'session-other', title: 'Other', messages: [] },
      'workspace-b'
    )
    const baselinePutCount = fakeIndexedDb.state.putCount

    await new Promise<void>((resolve, reject) => storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'A updated', messages: [] }],
      1,
      'workspace-a',
      { onSuccess: () => resolve(), onError: reject }
    ))

    expect(fakeIndexedDb.state.getAllCount).toBe(0)
    expect(fakeIndexedDb.state.clearCount).toBe(0)
    expect(fakeIndexedDb.state.putCount - baselinePutCount).toBe(1)
    await expect(storage.loadSessionFromDB('session-a', 'workspace-a')).resolves.toMatchObject({
      title: 'A updated'
    })
    await expect(storage.loadSessionFromDB('session-b', 'workspace-a')).resolves.toMatchObject({
      title: 'B'
    })
    await expect(storage.loadSessionFromDB('session-other', 'workspace-b')).resolves.toMatchObject({
      title: 'Other'
    })
  })

  it('does not resurrect a session deleted before its debounced save fires', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.debouncedSaveSessions(
      [{ id: 'session-delete', title: 'pending', messages: [] }],
      10,
      'workspace-a'
    )
    await storage.deleteSessionFromDB('session-delete', 'workspace-a')
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(storage.loadSessionFromDB('session-delete', 'workspace-a')).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('does not resurrect tombstoned sessions during localStorage migration', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('legacy-deleted', 'default')
    localStorage.setItem(
      'chat.sessions',
      JSON.stringify([{ id: 'legacy-deleted', title: 'Legacy deleted', messages: [] }])
    )

    await storage.migrateFromLocalStorage()

    await expect(storage.loadSessionFromDB('legacy-deleted', 'default')).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('does not resurrect a deleted session through a later immediate save', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.setSessionDeleteTombstone('session-delete-immediate', 'workspace-a')
    await storage.deleteSessionFromDB('session-delete-immediate', 'workspace-a')
    await storage.saveSessionToDB(
      { id: 'session-delete-immediate', title: 'stale writer', messages: [] },
      'workspace-a'
    )

    await expect(
      storage.loadSessionFromDB('session-delete-immediate', 'workspace-a')
    ).resolves.toBeNull()
    expect(fakeIndexedDb.state.putCount).toBe(0)
  })

  it('lets an immediate save supersede an older debounced snapshot', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    storage.debouncedSaveSessions(
      [{ id: 'session-order', title: 'stale', messages: [] }],
      10,
      'workspace-a'
    )
    await storage.saveSessionToDB(
      { id: 'session-order', title: 'current', messages: [] },
      'workspace-a'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    await expect(storage.loadSessionFromDB('session-order', 'workspace-a')).resolves.toMatchObject({
      title: 'current'
    })
    expect(fakeIndexedDb.state.putCount).toBe(1)
  })

  it('single-flights concurrent legacy media migration reads', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    const reference = {
      version: 1 as const,
      kind: 'managed' as const,
      id: 'a'.repeat(64),
      relativePath: `originals/${'a'.repeat(64)}.png`,
      mimeType: 'image/png',
      originalFileName: 'legacy.png'
    }
    const checkpoint = {
      version: 1 as const,
      reclaim: { reference }
    }
    let releaseMigration: (() => void) | undefined
    managedMediaApiMock.migrateLegacyDataUrl.mockReturnValue(
      new Promise((resolve) => {
        releaseMigration = () =>
          resolve({
            reference,
            localMediaUrl: 'local-media:///originals/legacy.png',
            checkpoint
          })
      })
    )

    await storage.saveSessionToDB(
      {
        id: 'legacy-single-flight',
        title: 'Legacy',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )
    const baselinePutCount = fakeIndexedDb.state.putCount

    const firstRead = storage.loadSessionFromDB('legacy-single-flight', 'workspace-a')
    const secondRead = storage.loadSessionFromDB('legacy-single-flight', 'workspace-a')
    await vi.waitFor(() => expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce())
    releaseMigration?.()

    const [first, second] = await Promise.all([firstRead, secondRead])
    expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce()
    expect(first?.messages[0]?.attachments?.[0]).toMatchObject({
      url: 'local-media:///originals/legacy.png',
      media: reference
    })
    expect(second).toEqual(first)
    expect(second?.messages[0]?.attachments?.[0]?.media).toEqual(reference)
    expect(fakeIndexedDb.state.putCount - baselinePutCount).toBe(1)
    expect(managedMediaApiMock.reclaimLegacyMigration).not.toHaveBeenCalled()

    await expect(storage.loadSessionFromDB('legacy-single-flight', 'workspace-a')).resolves.toEqual(
      first
    )
    expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce()
    expect(fakeIndexedDb.state.putCount - baselinePutCount).toBe(1)
  })

  it('migrates compacted replay image attachments to managed media on reload', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    const reference = {
      version: 1 as const,
      kind: 'managed' as const,
      id: 'b'.repeat(64),
      relativePath: `originals/${'b'.repeat(64)}.png`,
      mimeType: 'image/png',
      originalFileName: 'compacted.png'
    }
    managedMediaApiMock.migrateLegacyDataUrl.mockResolvedValue({
      reference,
      localMediaUrl: 'local-media:///originals/compacted.png',
      checkpoint: { version: 1 as const, reclaim: { reference } }
    })

    await storage.saveSessionToDB(
      {
        id: 'legacy-compacted-replay',
        title: 'Legacy compacted replay',
        messages: [],
        contextCompression: {
          summary: 'compacted',
          coveredMessageCount: 2,
          sourceHash: 'source',
          estimatedSourceTokens: 10,
          estimatedSummaryTokens: 2,
          updatedAt: 1,
          replayImageMessages: [
            {
              role: 'user',
              content: 'Historical image replay.',
              attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'compacted.png' }]
            }
          ]
        }
      },
      'workspace-a'
    )

    const loaded = await storage.loadSessionFromDB('legacy-compacted-replay', 'workspace-a')

    expect(loaded?.contextCompression?.replayImageMessages?.[0]?.attachments?.[0]).toMatchObject({
      url: 'local-media:///originals/compacted.png',
      media: reference
    })
  })

  it('migrates retained compacted-only legacy images with the same CAS/owner rules without rewriting original text', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const reference = { version: 1 as const, kind: 'managed' as const, sha256: 'e'.repeat(64), relativePath: `originals/ee/${'e'.repeat(64)}.png`, sizeBytes: 4, mimeType: 'image/png', originalFileName: 'retained.png' }
    managedMediaApiMock.migrateLegacyDataUrl.mockResolvedValue({ reference, localMediaUrl: 'local-media:///originals/retained.png', checkpoint: { version: 1, reclaim: { reference } } })
    const legacy = { role: 'user' as const, content: 'Original compacted text', attachments: [{ type: 'image' as const, url: 'data:image/png;base64,AAAA', fileName: 'retained.png' }] }
    await storage.saveSessionToDB({ id: 'retained-image', title: 'Owned', compactedMessages: [legacy], messages: [] }, 'workspace-retained')
    const loaded = await storage.loadSessionFromDB('retained-image', 'workspace-retained')
    expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce()
    expect(loaded?.compactedMessages).toEqual([{ ...legacy, attachments: [{ ...legacy.attachments[0], url: 'local-media:///originals/retained.png', media: reference }] }])
    expect(loaded?.messages).toEqual([])
    expect(managedMediaApiMock.reclaimLegacyMigration).not.toHaveBeenCalled()
    await expect(storage.loadSessionFromDB('retained-image', 'workspace-retained')).resolves.toEqual(loaded)
    expect(managedMediaApiMock.migrateLegacyDataUrl).toHaveBeenCalledOnce()
  })

  it('reclaims newly migrated media when persistence replacement fails', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    const reference = {
      version: 1 as const,
      kind: 'managed' as const,
      sha256: 'd'.repeat(64),
      relativePath: `originals/dd/${'d'.repeat(64)}.png`,
      sizeBytes: 1024,
      mimeType: 'image/png',
      originalFileName: 'legacy.png'
    }
    const checkpoint = {
      version: 1 as const,
      reclaim: { reference }
    }
    managedMediaApiMock.migrateLegacyDataUrl.mockResolvedValue({
      reference,
      localMediaUrl: 'local-media:///originals/dd/legacy.png',
      checkpoint
    })

    await storage.saveSessionToDB(
      {
        id: 'legacy-persist-failure',
        title: 'Legacy persistence failure',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )
    fakeIndexedDb.state.failPutOnce = true

    const loaded = await storage.loadSessionFromDB('legacy-persist-failure', 'workspace-a')

    expect(loaded?.messages[0]?.attachments?.[0]).toMatchObject({ url: legacyDataUrl })
    expect(managedMediaApiMock.reclaimLegacyMigration).toHaveBeenCalledWith(checkpoint)
  })

  it('keeps legacy inline media unchanged when managed migration fails', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,AAAA'
    managedMediaApiMock.migrateLegacyDataUrl.mockRejectedValue(new Error('migration unavailable'))

    await storage.saveSessionToDB(
      {
        id: 'legacy-migration-failure',
        title: 'Legacy failure',
        messages: [
          {
            role: 'user',
            content: '',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )

    const loaded = await storage.loadSessionFromDB('legacy-migration-failure', 'workspace-a')

    expect(loaded?.messages[0]?.attachments?.[0]).toMatchObject({ url: legacyDataUrl })
    expect(managedMediaApiMock.reclaimLegacyMigration).not.toHaveBeenCalled()
  })

  it('keeps sessions with the same id isolated by storage scope', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')

    await storage.saveSessionToDB(
      { id: 'shared-session', title: 'Workspace A', messages: [] },
      'workspace-a'
    )
    await storage.saveSessionToDB(
      { id: 'shared-session', title: 'Workspace B', messages: [] },
      'workspace-b'
    )

    await expect(storage.loadSessionFromDB('shared-session', 'workspace-a')).resolves.toMatchObject(
      {
        title: 'Workspace A'
      }
    )
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-b')).resolves.toMatchObject(
      {
        title: 'Workspace B'
      }
    )

    await storage.deleteSessionFromDB('shared-session', 'workspace-b')
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-a')).resolves.toMatchObject(
      {
        title: 'Workspace A'
      }
    )
    await expect(storage.loadSessionFromDB('shared-session', 'workspace-b')).resolves.toBeNull()
  })

  it('coalesces repeated debounced updates and keeps only the latest callback', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)
    const storage = await import('./chatStorage')
    const firstCallback = vi.fn()
    const latestCallback = vi.fn()

    storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'first', messages: [] }],
      5,
      'workspace-a',
      { onSuccess: firstCallback }
    )
    storage.debouncedSaveSessions(
      [{ id: 'session-a', title: 'latest', messages: [] }],
      5,
      'workspace-a',
      { onSuccess: latestCallback }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(fakeIndexedDb.state.putCount).toBe(1)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(latestCallback).toHaveBeenCalledTimes(1)
    await expect(storage.loadSessionFromDB('session-a', 'workspace-a')).resolves.toMatchObject({
      title: 'latest'
    })
  })

  it('preserves context compression metadata and drops legacy compact activity logs when saving and loading sessions', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')
    const contextCompression = {
      summary: '[Previous context summary]\n\n### Current Goal\nKeep working.',
      coveredMessageCount: 8,
      sourceHash: 'source-hash',
      estimatedSourceTokens: 4096,
      estimatedSummaryTokens: 256,
      updatedAt: 1_700_000,
      manual: true,
      compactRound: 3,
      lastCompactAttemptAt: 1_699_900,
      lastCompactSuccessAt: 1_700_000,
      lastCompactFailureAt: 1_699_000,
      lastCompactSkipReason: 'cooldown',
      lastPromptTokens: 16_000,
      lastTotalTokens: 16_500,
      metadata: {
        generatedBy: 'llm',
        profileId: 'compact-model',
        maxOutputTokens: 2_000,
        realUsage: {
          promptTokens: 16_000,
          totalTokens: 16_500
        }
      }
    }
    await storage.saveSessionToDB(
      {
        id: 'compressed-session',
        title: 'Compressed session',
        messages: [{ role: 'user', content: 'recent live message' }],
        sessionUrl: 'continuation-url',
        sessionProfileId: 'base-model',
        contextCompression,
        contextCompressionActivity: [
          {
            type: 'compact_complete',
            timestamp: 1_700_000,
            summaryPreview: '[Previous context summary]'
          }
        ]
      } as import('./chatStorage').ChatSession & {
        contextCompressionActivity: Array<Record<string, unknown>>
      },
      'workspace-a'
    )

    const loadedSession = await storage.loadSessionFromDB('compressed-session', 'workspace-a')
    expect(loadedSession).toMatchObject({
      id: 'compressed-session',
      storageScope: 'workspace-a',
      sessionUrl: 'continuation-url',
      sessionProfileId: 'base-model',
      contextCompression
    })
    expect(loadedSession).not.toHaveProperty('contextCompressionActivity')

    const loadedSessions = await storage.loadAllSessions('workspace-a')
    expect(loadedSessions).toEqual([
      expect.objectContaining({
        id: 'compressed-session',
        sessionUrl: 'continuation-url',
        sessionProfileId: 'base-model',
        contextCompression
      })
    ])
    expect(loadedSessions[0]).not.toHaveProperty('contextCompressionActivity')
  })

  it('keeps successfully loaded sessions unchanged when managed media migration is unavailable', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    fakeIndexedDb.state.failGetAllOnce = false
    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')
    const legacyDataUrl = 'data:image/png;base64,YQ=='
    await storage.saveSessionToDB(
      {
        id: 'legacy-without-service',
        title: 'Legacy image session',
        messages: [
          {
            role: 'user',
            content: 'legacy image',
            attachments: [{ type: 'image', url: legacyDataUrl, fileName: 'legacy.png' }]
          }
        ]
      },
      'workspace-a'
    )

    await expect(storage.loadAllSessions('workspace-a')).resolves.toEqual([
      expect.objectContaining({
        id: 'legacy-without-service',
        storageScope: 'workspace-a',
        messages: [
          expect.objectContaining({
            attachments: [expect.objectContaining({ url: legacyDataUrl })]
          })
        ]
      })
    ])
    expect(fakeIndexedDb.deletedNames).toEqual([])
  })

  it('preserves corrupted IndexedDB data and surfaces read errors for a later retry', async () => {
    const fakeIndexedDb = createFakeIndexedDb()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.stubGlobal('indexedDB', fakeIndexedDb.api)

    const storage = await import('./chatStorage')

    await expect(storage.loadAllSessions('default')).rejects.toThrow(/missing file|irrecoverable/i)
    expect(fakeIndexedDb.deletedNames).toEqual([])

    await storage.saveSessionToDB(
      {
        id: 'session-1',
        title: 'Recovered session',
        messages: []
      },
      'default'
    )

    await expect(storage.loadAllSessions('default')).resolves.toMatchObject([
      {
        id: 'session-1',
        title: 'Recovered session',
        storageScope: 'default'
      }
    ])

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ChatStorage] loadAllSessions failed: NotReadableError:')
    )
  })

  describe('guarded saveSessionToDB (expectedSession)', () => {
    const session = (id: string, content: string): import('./chatStorage').ChatSession => ({
      id,
      title: id,
      messages: [{ role: 'user', content }]
    })

    it('rejects a stale whole-snapshot save instead of overwriting a newer reply', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      const v0 = session('cross-writer', 'old draft')
      await storage.saveSessionToDB(v0, 'workspace-a')
      // Writer A advances the record with a new reply.
      const vNewReply = session('cross-writer', 'new reply from A')
      await storage.saveSessionToDB(vNewReply, 'workspace-a')

      // Writer B still holds the old snapshot and must not clobber A's reply.
      const vB = session('cross-writer', 'stale draft from B')
      await expect(
        storage.saveSessionToDB(vB, 'workspace-a', { expectedSession: v0 })
      ).rejects.toMatchObject({
        name: 'ChatSessionSaveConflictError',
        code: 'CHAT_SESSION_SAVE_CONFLICT'
      })

      await expect(storage.loadSessionFromDB('cross-writer', 'workspace-a')).resolves.toMatchObject(
        {
          messages: [{ role: 'user', content: 'new reply from A' }]
        }
      )
    })

    it('does not classify an external change plus local supersede as a harmless supersede', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')
      const v0 = session('external-and-local', 'baseline')
      const external = session('external-and-local', 'external edit')
      await storage.saveSessionToDB(v0, 'workspace-a')
      await storage.saveSessionToDB(external, 'workspace-a')
      const shouldUpdate = vi.fn(() => false)
      await expect(storage.saveSessionToDB(session('external-and-local', 'local edit'), 'workspace-a', {
        expectedSession: v0, shouldUpdate
      })).rejects.toMatchObject({ code: 'CHAT_SESSION_SAVE_CONFLICT' })
      expect(shouldUpdate).not.toHaveBeenCalled()
      await expect(storage.loadSessionFromDB('external-and-local', 'workspace-a')).resolves.toMatchObject(external)
    })

    it('applies the guarded save when the stored record still equals the expected snapshot', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      const v0 = session('guarded-ok', 'v0')
      await storage.saveSessionToDB(v0, 'workspace-a')
      const v1 = session('guarded-ok', 'v1 reply')
      await storage.saveSessionToDB(v1, 'workspace-a', { expectedSession: v0 })

      await expect(storage.loadSessionFromDB('guarded-ok', 'workspace-a')).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'v1 reply' }]
      })
    })

    it('rejects a guarded create when a record already exists', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      await storage.saveSessionToDB(session('create-guard', 'existing'), 'workspace-a')
      await expect(
        storage.saveSessionToDB(session('create-guard', 'duplicate'), 'workspace-a', {
          expectedSession: null
        })
      ).rejects.toMatchObject({ name: 'ChatSessionSaveConflictError' })
      await expect(storage.loadSessionFromDB('create-guard', 'workspace-a')).resolves.toMatchObject(
        {
          messages: [{ role: 'user', content: 'existing' }]
        }
      )
    })

    it('keeps the same id isolated across storage scopes during a guarded create', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      await storage.saveSessionToDB(session('shared-id', 'scope B'), 'workspace-b')
      // Creating the same id in workspace-a must not conflict with workspace-b.
      await storage.saveSessionToDB(session('shared-id', 'scope A'), 'workspace-a', {
        expectedSession: null
      })

      await expect(storage.loadSessionFromDB('shared-id', 'workspace-a')).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'scope A' }]
      })
      await expect(storage.loadSessionFromDB('shared-id', 'workspace-b')).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'scope B' }]
      })
    })

    it('does not resurrect a deleted session through a guarded save', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      const v0 = session('deleted-guard', 'before delete')
      await storage.saveSessionToDB(v0, 'workspace-a')
      storage.setSessionDeleteTombstone('deleted-guard', 'workspace-a')
      await storage.deleteSessionFromDB('deleted-guard', 'workspace-a')

      await expect(storage.saveSessionToDB(session('deleted-guard', 'stale replay'), 'workspace-a', {
        expectedSession: v0
      })).rejects.toBeInstanceOf(storage.ChatSessionSaveConflictError)
      await expect(storage.loadSessionFromDB('deleted-guard', 'workspace-a')).resolves.toBeNull()
    })

    it('treats an identical snapshot retry as idempotent', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      const v0 = session('idempotent', 'v0')
      await storage.saveSessionToDB(v0, 'workspace-a')
      const v1 = session('idempotent', 'v1')
      await storage.saveSessionToDB(v1, 'workspace-a', { expectedSession: v0 })
      // Retrying the exact snapshot that is now stored must succeed, not conflict.
      await storage.saveSessionToDB(v1, 'workspace-a', { expectedSession: v1 })

      await expect(storage.loadSessionFromDB('idempotent', 'workspace-a')).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'v1' }]
      })
    })

    it('treats a lost-ack retry of an already-persisted snapshot as idempotent without a new put', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      await storage.saveSessionToDB(session('lost-ack', 'v1'), 'workspace-a')
      const putCountBefore = fakeIndexedDb.state.putCount
      // Caller still thinks it started from v0 (ack lost); stored already equals the incoming v1.
      await storage.saveSessionToDB(session('lost-ack', 'v1'), 'workspace-a', {
        expectedSession: session('lost-ack', 'v0')
      })
      expect(fakeIndexedDb.state.putCount).toBe(putCountBefore)
      await expect(storage.loadSessionFromDB('lost-ack', 'workspace-a')).resolves.toMatchObject({
        messages: [{ role: 'user', content: 'v1' }]
      })
    })

    it('treats a guarded create retry of an already-persisted snapshot as idempotent without a new put', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')

      await storage.saveSessionToDB(session('create-retry', 'v1'), 'workspace-a', {
        expectedSession: null
      })
      const putCountBefore = fakeIndexedDb.state.putCount
      await storage.saveSessionToDB(session('create-retry', 'v1'), 'workspace-a', {
        expectedSession: null
      })
      expect(fakeIndexedDb.state.putCount).toBe(putCountBefore)
      await expect(storage.loadSessionFromDB('create-retry', 'workspace-a')).resolves.toMatchObject(
        { messages: [{ role: 'user', content: 'v1' }] }
      )
    })

    it('treats equal sessions with different object key order / incomplete raw fields as equal (no self-conflict)', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')
      type S = import('./chatStorage').ChatSession

      const base = {
        id: 'key-order',
        title: 'key-order',
        messages: [{ role: 'user', content: 'hi' }],
        sessionUrl: 'https://x.test/s',
        sessionProfileId: 'base-model',
        profileId: 'base-model',
        draft: { inputValue: 'd', pendingAttachments: [], pendingHiddenContext: '', updatedAt: 5 }
      } as unknown as S
      await storage.saveSessionToDB(base, 'workspace-a')

      // Same semantic content, different object key insertion order and missing storageScope.
      const expected = {
        draft: { updatedAt: 5, pendingHiddenContext: '', pendingAttachments: [], inputValue: 'd' },
        profileId: 'base-model',
        sessionProfileId: 'base-model',
        messages: [{ content: 'hi', role: 'user' }],
        title: 'key-order',
        id: 'key-order',
        sessionUrl: 'https://x.test/s'
      } as unknown as S
      const incoming = {
        ...base,
        messages: [{ content: 'hi', role: 'user' }]
      } as unknown as S
      await expect(
        storage.saveSessionToDB(incoming, 'workspace-a', { expectedSession: expected })
      ).resolves.toBeUndefined()
    })

    it('supports consecutive raw saves and clearing the draft without self-conflict', async () => {
      const fakeIndexedDb = createFakeIndexedDb()
      vi.stubGlobal('indexedDB', fakeIndexedDb.api)
      const storage = await import('./chatStorage')
      type S = import('./chatStorage').ChatSession

      const draft = {
        inputValue: 'draft',
        pendingAttachments: [],
        pendingHiddenContext: '',
        updatedAt: 1
      }
      const raw0 = {
        id: 'raw-seq',
        title: 'raw-seq',
        messages: [{ role: 'user', content: 'q' }],
        draft
      } as unknown as S
      await storage.saveSessionToDB(raw0, 'workspace-a', { expectedSession: null })

      const raw1 = {
        id: 'raw-seq',
        title: 'raw-seq',
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' }
        ],
        draft
      } as unknown as S
      await storage.saveSessionToDB(raw1, 'workspace-a', { expectedSession: raw0 })

      // Clearing the draft (no draft field) against the raw snapshot that still had one.
      const raw2 = {
        id: 'raw-seq',
        title: 'raw-seq',
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a' }
        ]
      } as unknown as S
      await storage.saveSessionToDB(raw2, 'workspace-a', { expectedSession: raw1 })

      const loaded = await storage.loadSessionFromDB('raw-seq', 'workspace-a')
      expect(loaded?.messages).toHaveLength(2)
      expect(loaded?.draft).toBeUndefined()
    })
  })
})
