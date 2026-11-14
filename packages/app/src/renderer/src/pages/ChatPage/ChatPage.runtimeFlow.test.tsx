import React from 'react'
import MagicAgentApprovalCenter from '../../components/MagicAgentApprovalCenter'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG, type Config, type SkillReferenceAttachment } from '@shared/config/config'
import { DEFAULT_BUILD_ENV } from '@shared/config/buildEnv'
import type {
  ChatAttachment,
  ChatMessage
} from '../QuickAppPage/QAppExecutePanel/qAppExecuteInputs/api/LLM'
import { createTeamMemberInDB, saveSessionToDB, type ChatSession, type ChatSessionDraft } from './chatStorage'
import type { ChatLoadingStatus } from './chatLoadingStatus'
import ChatPage from './ChatPage'
import {
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  BUILT_IN_TAGGING_SKILL_ID
} from './builtInSkills'
import {
  buildChatWorkspaceControlsPortalId,
  CHAT_SESSION_LOADING_STATE_EVENT,
  readScopedActiveLoadingSessionIds,
  readScopedChatRun,
  scopedStorageKey,
  STORAGE_KEY_CURRENT_SESSION_ID,
  STORAGE_KEY_LOADING_IDS,
  STORAGE_KEY_SELECTED_PROFILE
} from './chatPageShared'

const hoisted = vi.hoisted(() => ({
  currentConfig: { value: null as Config | null },
  runtimeMcpStatus: { value: null as Record<string, unknown> | null },
  buildDataDir: { value: 'C:/MagicPot/Data' },
  availableProfiles: {
    value: [
      { id: 'base-model', model_name: 'GPT-4o', model_use: 'chat' as const },
      {
        id: 'vision-model',
        model_name: 'Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true
      },
      { id: 'translation-model', model_name: 'Translation Model', model_use: 'chat' as const }
    ] as Array<{
      id: string
      model_name: string
      model_use?: 'chat' | 'agent' | 'multimodal' | 'vision' | 'ocr' | 'image'
      is_vision_model?: boolean
      is_ocr_model?: boolean
      auth_mode?: string
      call_type?: string
      provider?: string
      deployment?: string
      api_mode?: 'auto' | 'responses' | 'chat-completions' | 'images'
      context_window_tokens?: number
      context_budget_tokens?: number
      supports_session_continuation?: boolean
    }>
  },
  fileExistsBatchMock: vi.fn(async (paths: string[]) => paths.map(() => true)),
  storedSessions: { value: [] as ChatSession[] },
  scopedTestSessions: { value: null as Record<string, ChatSession[]> | null },
  draftBackups: {
    value: {} as Record<string, { updatedAt: number; draft?: ChatSessionDraft }>
  },
  saveSessionToDBGate: { value: null as Promise<void> | null },
  saveSessionToDBGateStarted: { value: null as string | null },
  selectiveSaveGate: { value: null as null | { id: string; gate: Promise<void>; started: boolean } },
  failTaskResponseSave: { value: null as string | null },
  listPendingApprovalsMock: vi.fn(),
  resolvePendingApprovalMock: vi.fn(),
  teamPostCommitGate: { value: null as Promise<void> | null },
  teamPostCommitSnapshot: { value: null as ChatSession | null },
  latestSaveCallback: { value: null as null | ((id: string, scope: string) => Promise<ChatSession | null>) },
  saveSuccessCount: { value: 0 },
  saveCallbackGate: { value: null as Promise<void> | null },
  saveCallbackGateStarted: { value: null as string | null },
  migrationCommitGate: { value: null as Promise<void> | null },
  compareCommitResultGate: { value: null as Promise<void> | null },
  compareCommitted: { value: null as ChatSession | null },
  migrationStarted: { value: false },
  skipMigrationOnce: { value: false },
  deleteTombstones: { value: new Set<string>() },
  debouncedSaveAllSessionsGate: { value: null as Promise<void> | null },
  loadAllSessionsMock: vi.fn(),
  saveAllSessionsMock: vi.fn(),
  teamPreprocessingFails: { value: false },
  teamBeforeDispatchGate: { value: null as null | { gate: Promise<void>; entered: boolean } },
  teamPreflightReadGate: { value: null as null | { gate: Promise<void>; entered: boolean } },
  requestChatCompletionMock: vi.fn(),
  requestChatCompletionStreamMock: vi.fn(),
  listAgentInteractionsMock: vi.fn(),
  listAgentTeamMessagesMock: vi.fn(),
  claimAgentTeamMessageMock: vi.fn(),
  resolveAgentInteractionMock: vi.fn(),
  saveAgentHtmlAppMock: vi.fn(),
  listSavedAgentHtmlAppsMock: vi.fn(),
  restoreAgentHtmlAppMock: vi.fn(),
  deleteSavedAgentHtmlAppMock: vi.fn(),
  setAgentHtmlScopeMock: vi.fn(),
  agentHtmlStorageStatusMock: vi.fn(),
  initializeAgentHtmlStorageMock: vi.fn(),
  listAgentHtmlAppsMock: vi.fn(),
  openAgentHtmlAppMock: vi.fn(),
  closeAgentHtmlAppMock: vi.fn(),
  listAgentSidesMock: vi.fn(),
  openAgentSideMock: vi.fn(),
  startAgentSideMock: vi.fn(),
  continueAgentSideMock: vi.fn(),
  stopAgentSideMock: vi.fn(),
  deleteAgentSideMock: vi.fn(),
  listAgentProcessesMock: vi.fn(),
  readAgentProcessMock: vi.fn(),
  stopAgentProcessMock: vi.fn(),
  endTeamMock: vi.fn(async () => ({ ended: true })),
  listAgentJobsMock: vi.fn(),
  readAgentJobMock: vi.fn(),
  stopAgentJobMock: vi.fn(),
  listAgentArchiveQueriesMock: vi.fn(),
  resolveAgentArchiveQueryMock: vi.fn(),
  prepareAgentGoalProgressMock: vi.fn(),
  agentGoalScopeRevisionMock: vi.fn(),
  setAgentGoalScopeMock: vi.fn(),
  listAgentGoalDispatchesMock: vi.fn(),
  listAgentGoalsMock: vi.fn(),
  mutateAgentGoalMock: vi.fn(),
  managedFirstRunPaneRevisionMock: vi.fn(),
  setManagedFirstRunPaneScopeMock: vi.fn(),
  agentSkillScopeRevisionMock: vi.fn(),
  setAgentSkillScopeMock: vi.fn(),
  listAgentSessionSkillsMock: vi.fn(),
  showAgentSessionSkillMock: vi.fn(),
  setAgentSkillPreferenceMock: vi.fn(),
  getAgentNotesMock: vi.fn(),
  mutateAgentNoteMock: vi.fn(),
  resolveSkillRuntimeResourceEntriesMock: vi.fn(),
  resolveAttachmentBatchCapabilityMock: vi.fn(),
  supportsStreamingChatCompletionMock: vi.fn(),
  preflightFailure: { value: false },
  selectFileMock: vi.fn(),
  agentLocalFilesService: {
    setScope: vi.fn(),
    choose: vi.fn(),
    read: vi.fn(),
    list: vi.fn(),
    revoke: vi.fn(),
    cancel: vi.fn()
  },
  fileToBlobUrlMock: vi.fn(() => 'blob:chat-draft'),
  fileToDataUrlMock: vi.fn(async () => 'data:application/octet-stream;base64,QUJD'),
  importManagedFileMock: vi.fn(),
  importManagedDataUrlMock: vi.fn(),
  importManagedUrlMock: vi.fn(),
  readTextFileMock: vi.fn(),
  saveImageToDirMock: vi.fn(),
  chatMessageListMock: vi.fn(),
  notifySuccessMock: vi.fn(),
  notifyErrorMock: vi.fn(),
  notifyWarningMock: vi.fn(),
  notifyInfoMock: vi.fn()
}))

const cloneValue = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const createConfig = (): Config => ({
  ...DEFAULT_CONFIG,
  use_remote_llm: false,
  llm_config: {
    ...DEFAULT_CONFIG.llm_config,
    api_profiles: [],
    customSkills: [],
    customSkillCategories: [],
    useImageInterrogation: true,
    imageInterrogationProfileId: 'vision-model',
    usePromptTranslation: true,
    promptTranslationProfileId: 'translation-model'
  },
  plugin_config: {
    ...DEFAULT_CONFIG.plugin_config!,
    api_profiles: [],
    light_adjustment_prompt: DEFAULT_CONFIG.plugin_config?.light_adjustment_prompt || '',
    useImageInterrogation: true,
    imageInterrogationSystemPrompt: 'qapp vision system',
    imageInterrogationUserPrompt: 'qapp vision user',
    imageInterrogationProfileId: 'vision-model',
    usePromptTranslation: true,
    promptTranslationSystemPrompt: 'qapp translate system',
    promptTranslationUserPrompt: 'qapp translate user',
    promptTranslationProfileId: 'translation-model'
  },
  local_llm_server_config: {
    ...DEFAULT_CONFIG.local_llm_server_config
  },
  remote_llm_server_config: {
    ...DEFAULT_CONFIG.remote_llm_server_config
  },
  mcp_config: {
    ...DEFAULT_CONFIG.mcp_config,
    client: {
      ...DEFAULT_CONFIG.mcp_config?.client,
      servers: []
    }
  },
  aigc3d_config: {
    ...DEFAULT_CONFIG.aigc3d_config!
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options?: { defaultValue?: string; error?: string }) =>
      options?.defaultValue || options?.error || key
  })
}))

vi.mock('@renderer/hooks/useConfig', () => ({
  useConfig: () => ({
    config: hoisted.currentConfig.value,
    isReady: true,
    buildEnv: {
      ...cloneValue(DEFAULT_BUILD_ENV),
      pathMap: {
        ...cloneValue(DEFAULT_BUILD_ENV.pathMap),
        data: hoisted.buildDataDir.value
      }
    },
    configUtils: {},
    updateConfig: vi.fn()
  })
}))

vi.mock('@renderer/hooks/useRuntimeMcpStatus', () => ({
  useRuntimeMcpStatus: () => ({
    runtimeMcpStatus: hoisted.runtimeMcpStatus.value
  })
}))

vi.mock('@renderer/hooks/useMessage', () => ({
  useMessage: () => ({
    notifySuccess: hoisted.notifySuccessMock,
    notifyError: hoisted.notifyErrorMock,
    notifyWarning: hoisted.notifyWarningMock,
    notifyInfo: hoisted.notifyInfoMock
  })
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({
    svcMagicAgentPlatform: { listPendingApprovals: hoisted.listPendingApprovalsMock, resolvePendingApproval: hoisted.resolvePendingApprovalMock },
    svcShell: { fileExistsBatch: hoisted.fileExistsBatchMock },
    svcAgentLocalFiles: hoisted.agentLocalFilesService,
    svcFs: {
      readTextFile: hoisted.readTextFileMock
    },
    svcLLMProxy: {
      endTeam: hoisted.endTeamMock,
      signHy3DModel: vi.fn(),
      listAgentInteractions: hoisted.listAgentInteractionsMock,
      listAgentTeamMessages: hoisted.listAgentTeamMessagesMock,
      claimAgentTeamMessage: hoisted.claimAgentTeamMessageMock,
      resolveAgentInteraction: hoisted.resolveAgentInteractionMock,
      saveAgentHtmlApp: hoisted.saveAgentHtmlAppMock,
      listSavedAgentHtmlApps: hoisted.listSavedAgentHtmlAppsMock,
      restoreAgentHtmlApp: hoisted.restoreAgentHtmlAppMock,
      deleteSavedAgentHtmlApp: hoisted.deleteSavedAgentHtmlAppMock,
      setAgentHtmlScope: hoisted.setAgentHtmlScopeMock,
      agentHtmlStorageStatus: hoisted.agentHtmlStorageStatusMock,
      initializeAgentHtmlStorage: hoisted.initializeAgentHtmlStorageMock,
      listAgentHtmlApps: hoisted.listAgentHtmlAppsMock,
      openAgentHtmlApp: hoisted.openAgentHtmlAppMock,
      closeAgentHtmlApp: hoisted.closeAgentHtmlAppMock,
      listAgentSides: hoisted.listAgentSidesMock,
      openAgentSide: hoisted.openAgentSideMock,
      startAgentSide: hoisted.startAgentSideMock,
      continueAgentSide: hoisted.continueAgentSideMock,
      stopAgentSide: hoisted.stopAgentSideMock,
      deleteAgentSide: hoisted.deleteAgentSideMock,
      listAgentProcesses: hoisted.listAgentProcessesMock,
      readAgentProcess: hoisted.readAgentProcessMock,
      stopAgentProcess: hoisted.stopAgentProcessMock,
      listAgentJobs: hoisted.listAgentJobsMock,
      readAgentJob: hoisted.readAgentJobMock,
      stopAgentJob: hoisted.stopAgentJobMock,
      listAgentArchiveQueries: hoisted.listAgentArchiveQueriesMock,
      resolveAgentArchiveQuery: hoisted.resolveAgentArchiveQueryMock,
      prepareAgentGoalProgress: hoisted.prepareAgentGoalProgressMock,
      agentGoalScopeRevision: hoisted.agentGoalScopeRevisionMock,
      setAgentGoalScope: hoisted.setAgentGoalScopeMock,
      listAgentGoalDispatches: hoisted.listAgentGoalDispatchesMock,
      listAgentGoals: hoisted.listAgentGoalsMock,
      mutateAgentGoal: hoisted.mutateAgentGoalMock,
      managedFirstRunPaneRevision: hoisted.managedFirstRunPaneRevisionMock,
      setManagedFirstRunPaneScope: hoisted.setManagedFirstRunPaneScopeMock,
      agentSkillScopeRevision: hoisted.agentSkillScopeRevisionMock,
      setAgentSkillScope: hoisted.setAgentSkillScopeMock,
      listAgentSessionSkills: hoisted.listAgentSessionSkillsMock,
      showAgentSessionSkill: hoisted.showAgentSessionSkillMock,
      setAgentSkillPreference: hoisted.setAgentSkillPreferenceMock,
      getAgentNotes: hoisted.getAgentNotesMock,
      mutateAgentNote: hoisted.mutateAgentNoteMock
    },
    svcHyper: {
      saveImageToDir: hoisted.saveImageToDirMock
    },
    svcManagedMedia: {
      importFile: hoisted.importManagedFileMock,
      importDataUrl: hoisted.importManagedDataUrlMock,
      importUrl: hoisted.importManagedUrlMock
    }
  })
}))

vi.mock('@renderer/utils/fileUtils', () => ({
  selectFile: (_extensions?: string[]) => hoisted.selectFileMock(),
  fileToBlobUrl: (_file: File) => hoisted.fileToBlobUrlMock(),
  fileToDataUrl: (_file: File) => hoisted.fileToDataUrlMock(),
  checkFileSize: () => true,
  formatFileSize: (bytes: number) => `${bytes} B`
}))

vi.mock('./hooks/useChatProfiles', () => ({
  useChatProfiles: () => ({
    availableProfiles: hoisted.availableProfiles.value,
    remoteProfiles: []
  })
}))

vi.mock('./hooks/useImagePreview', () => ({
  useImagePreview: () => ({
    previewImage: null,
    imageScale: 1,
    imagePosition: { x: 0, y: 0 },
    isPreviewDragging: false,
    currentImageIndex: 0,
    setPreviewImage: vi.fn(),
    closePreview: vi.fn(),
    handlePreviewClick: vi.fn(),
    handlePreviewWheel: vi.fn(),
    handlePreviewMouseMove: vi.fn(),
    handlePreviewMouseUp: vi.fn(),
    handlePreviewMouseDown: vi.fn()
  })
}))

vi.mock('./hooks/useSpeechRecognition', () => ({
  useSpeechRecognition: () => ({
    isListening: false,
    isSupported: false,
    startListening: vi.fn(),
    stopListening: vi.fn()
  })
}))

vi.mock('./chatStorage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatStorage')>()
  return {
  ...actual,
  createTeamMemberInDB: vi.fn(async (input: {scope:string;expectedLead:ChatSession;member:ChatSession;shouldUpdate?:()=>boolean}) => {
    if (hoisted.saveSessionToDBGate.value) await hoisted.saveSessionToDBGate.value
    const lead=hoisted.storedSessions.value.find(session=>session.id===input.expectedLead.id)
    if (!lead || lead.teamEnded || input.shouldUpdate?.()===false || JSON.stringify(lead)!==JSON.stringify(input.expectedLead)) throw new Error('Team changed')
    const members=hoisted.storedSessions.value.filter(session=>session.teamLeadId===lead.id&&!session.archived&&(session.teamMemberGeneration??0)===(lead.teamGeneration??0))
    if(members.length >= (lead.teamSettings?.maxMembers??6) || members.some(session=>session.teamMemberName===input.member.teamMemberName)) throw new Error('Team full')
    const member={...input.member,teamMemberGeneration:lead.teamGeneration??0}
    hoisted.storedSessions.value=[...hoisted.storedSessions.value,cloneValue(member)]
    return {lead:cloneValue(lead),member:cloneValue(member)}
  }),
  setTeamMemberModelChoiceInDB: vi.fn(async (input: {scope:string;expectedLead:ChatSession;expectedMember:ChatSession;profileId:string;shouldUpdate?:()=>boolean}) => {
    const records = hoisted.scopedTestSessions.value?.[input.scope] ?? hoisted.storedSessions.value
    const lead = records.find(session => session.id === input.expectedLead.id)
    const member = records.find(session => session.id === input.expectedMember.id)
    if (!lead || !member || lead.teamEnded || lead.archived || member.archived || member.teamLeadId !== lead.id ||
      (member.teamMemberGeneration ?? 0) !== (lead.teamGeneration ?? 0) || input.shouldUpdate?.() === false ||
      !actual.normalizedSessionsEqual(lead, input.expectedLead, input.scope) || !actual.normalizedSessionsEqual(member, input.expectedMember, input.scope)) throw new Error('Team changed')
    const updated = {...member, memberModelChoice: {version: 1 as const, profileId: input.profileId}, sessionUrl: undefined, sessionProfileId: undefined, sessionRouteFingerprint: undefined}
    const next = records.map(session => session.id === member.id ? cloneValue(updated) : session)
    if (hoisted.scopedTestSessions.value) hoisted.scopedTestSessions.value[input.scope] = next
    else hoisted.storedSessions.value = next
    return {lead: cloneValue(lead), member: cloneValue(updated)}
  }),
  endTeamInDB: vi.fn(async(input:{scope:string;expectedLead:ChatSession;shouldUpdate?:()=>boolean})=>{
    const lead=hoisted.storedSessions.value.find(session=>session.id===input.expectedLead.id)
    if(!lead || input.shouldUpdate?.()===false)throw new Error('Team changed')
    const updatedLead={...lead,teamEnded:true,teamGeneration:(lead.teamGeneration??0)+1,teamLifecycleRevision:(lead.teamLifecycleRevision??0)+1}
    const members=hoisted.storedSessions.value.filter(session=>session.teamLeadId===lead.id&&!session.archived).map(session=>({...session,teamLifecycleRevision:(session.teamLifecycleRevision??0)+1,...(lead.teamSettings?.autoCleanup?{archived:true}:{})}))
    hoisted.storedSessions.value=hoisted.storedSessions.value.map(session=>session.id===lead.id?updatedLead:members.find(member=>member.id===session.id)??session)
    return {lead:updatedLead,members}
  }),
  loadSessionFromDB: vi.fn(async(id:string)=>{
    const gate = hoisted.teamPreflightReadGate.value
    if (gate) { gate.entered = true; await gate.gate }
    return cloneValue(hoisted.storedSessions.value.find(session=>session.id===id)??null)
  }),
  loadAllSessions: (...args: unknown[]) => hoisted.loadAllSessionsMock(...args),
  saveAllSessions: (...args: unknown[]) => hoisted.saveAllSessionsMock(...args),
  compareAndUpdateSessionInDB: vi.fn(
    async (
      sessionId: string,
      scope: string,
      options: {
        expectedSession: ChatSession
        shouldUpdate?: (currentSession: ChatSession) => boolean
        update: (currentSession: ChatSession) => ChatSession
      }
    ) => {
      hoisted.migrationStarted.value = true
      if (hoisted.skipMigrationOnce.value) {
        hoisted.skipMigrationOnce.value = false
        return null
      }
      const gate = hoisted.migrationCommitGate.value
      if (gate) {
        await gate
      }
      const stored = hoisted.scopedTestSessions.value?.[scope] ?? hoisted.storedSessions.value
      const existingIndex = stored.findIndex((item) => item.id === sessionId)
      if (existingIndex < 0 || hoisted.deleteTombstones.value.has(`${scope}:${sessionId}`))
        return null
      const currentSession = cloneValue(stored[existingIndex])
      if (
        JSON.stringify(currentSession) !== JSON.stringify(options.expectedSession) ||
        (options.shouldUpdate && !options.shouldUpdate(currentSession))
      ) {
        return null
      }
      const updatedSession = cloneValue(options.update(currentSession))
      const nextSessions = cloneValue(stored)
      nextSessions[existingIndex] = updatedSession
      if (hoisted.scopedTestSessions.value) hoisted.scopedTestSessions.value[scope] = nextSessions
      else hoisted.storedSessions.value = nextSessions
      const resultGate = hoisted.compareCommitResultGate.value
      if (resultGate) {
        hoisted.compareCommitted.value = cloneValue(updatedSession)
        await resultGate
      }
      return updatedSession
    }
  ),
  saveSessionToDB: vi.fn(async (session: ChatSession, scope = 'default', options?: {expectedSession?: ChatSession | null; shouldUpdate?: () => boolean}) => {
    const selective = hoisted.selectiveSaveGate.value
    if (selective?.id === session.id) { selective.started = true; await selective.gate }
    if (hoisted.saveSessionToDBGate.value) {
      hoisted.saveSessionToDBGateStarted.value = session.id
      await hoisted.saveSessionToDBGate.value
    }
    if (hoisted.failTaskResponseSave.value === session.id && session.messages.some(message => message.role === 'assistant' && message.content === '结果已返回但未保存')) throw new Error('fixture response save failure')
    const nextSessions = cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? hoisted.storedSessions.value)
    const existingIndex = nextSessions.findIndex((item) => item.id === session.id)
    const existing = nextSessions[existingIndex]
    if (existing && !actual.sameTeamLifecycle(existing, session)) throw new Error('Session lifecycle changed')
    let matchesExpected = false
    if (options && Object.prototype.hasOwnProperty.call(options, 'expectedSession')) {
      matchesExpected = options.expectedSession === null ? !existing : !!existing && !!options.expectedSession && actual.normalizedSessionsEqual(existing, options.expectedSession, scope)
      const alreadySaved = !!existing && actual.normalizedSessionsEqual(existing, session, scope)
      if (!matchesExpected && !alreadySaved) throw new Error('Session save conflict')
      if (options.shouldUpdate && !options.shouldUpdate()) {
        if (matchesExpected) throw new actual.ChatSessionSaveSupersededError()
        throw new Error('Session save conflict')
      }
      if (alreadySaved) return
    } else if (options?.shouldUpdate && !options.shouldUpdate()) throw new Error('Session changed before save')
    if (existingIndex >= 0) {
      nextSessions[existingIndex] = cloneValue(session)
    } else {
      nextSessions.unshift(cloneValue(session))
    }
    if (hoisted.scopedTestSessions.value) hoisted.scopedTestSessions.value[scope] = nextSessions
    else hoisted.storedSessions.value = nextSessions
    if (hoisted.teamPostCommitGate.value && session.teamTasks?.some(task => task.title === 'scope A task')) {
      hoisted.teamPostCommitSnapshot.value = cloneValue(session)
      await hoisted.teamPostCommitGate.value
    }
  }),
  deleteSessionFromDB: vi.fn(async (sessionId: string) => {
    hoisted.storedSessions.value = hoisted.storedSessions.value.filter(
      (session) => session.id !== sessionId
    )
  }),
  readSessionDraftBackup: vi.fn((sessionId: string, scope = 'default') => {
    const record = hoisted.draftBackups.value[`${scope}:${sessionId}`]
    return record ? cloneValue(record) : undefined
  }),
  writeSessionDraftBackup: vi.fn(
    (
      sessionId: string,
      updatedAt: number,
      draft: ChatSessionDraft | undefined,
      scope = 'default'
    ) => {
      const key = `${scope}:${sessionId}`
      const existingRecord = hoisted.draftBackups.value[key]
      if (existingRecord && existingRecord.updatedAt > updatedAt) {
        return
      }

      hoisted.draftBackups.value = {
        ...hoisted.draftBackups.value,
        [key]: draft ? { updatedAt, draft: cloneValue(draft) } : { updatedAt }
      }
    }
  ),
  deleteSessionDraftBackup: vi.fn((sessionId: string, scope = 'default') => {
    const key = `${scope}:${sessionId}`
    const nextBackups = { ...hoisted.draftBackups.value }
    delete nextBackups[key]
    hoisted.draftBackups.value = nextBackups
  }),
  migrateFromLocalStorage: vi.fn(async () => null),
  hasSessionDeleteTombstone: vi.fn((sessionId: string, scope = 'default') =>
    hoisted.deleteTombstones.value.has(`${scope}:${sessionId}`)
  ),
  readSessionDeleteTombstones: vi.fn(() =>
    [...hoisted.deleteTombstones.value].map((key) => {
      const separatorIndex = key.indexOf(':')
      return { scope: key.slice(0, separatorIndex), sessionId: key.slice(separatorIndex + 1) }
    })
  ),
  setSessionDeleteTombstone: vi.fn((sessionId: string, scope = 'default', deleted = true) => {
    const next = new Set(hoisted.deleteTombstones.value)
    const key = `${scope}:${sessionId}`
    if (deleted) next.add(key)
    else next.delete(key)
    hoisted.deleteTombstones.value = next
  }),
  cancelDebouncedSessionSave: vi.fn(),
  debouncedSaveSessions: vi.fn(
    (
      sessions: ChatSession[],
      _delayMs: number,
      _scope: string,
      options?: { onSuccess?: (sessions: ChatSession[]) => void; onError?: (error: unknown, sessions: ChatSession[]) => void; saveLatest?: (id: string, scope: string) => Promise<ChatSession | null> }
    ) => {
      // Exercise the same execution-time resolver as production; an old scheduled batch must not
      // bypass the current-state writer by directly copying its registration-time snapshots.
      if (options?.saveLatest) hoisted.latestSaveCallback.value = options.saveLatest
      const persistChangedSessions = async () => {
        for (const session of sessions) {
          try {
            if (!options?.saveLatest) continue
            const saved = await options.saveLatest(session.id, _scope)
            if (saved) {
              const callbackGate = hoisted.saveCallbackGate.value
              if (callbackGate) {
                hoisted.saveCallbackGateStarted.value = session.id
                await callbackGate
              }
              options.onSuccess?.([saved]); hoisted.saveSuccessCount.value += 1
            }
          } catch (error) {
            options?.onError?.(error, [session])
          }
        }
      }
      if (hoisted.debouncedSaveAllSessionsGate.value) {
        void hoisted.debouncedSaveAllSessionsGate.value.then(persistChangedSessions)
        return
      }
      void persistChangedSessions()
    }
  )
}})

vi.mock('./chatRequestUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chatRequestUtils')>()
  return {
    ...actual,
    requestChatCompletion: async (input: { beforeLocalDispatch?: () => void | Promise<void>; onLocalDispatch?: () => void; signal?: AbortSignal }) => {
      if (hoisted.teamPreprocessingFails.value && input.onLocalDispatch) throw new Error('fixture preprocessing failed')
      const dispatchGate = hoisted.teamBeforeDispatchGate.value
      if (dispatchGate && input.beforeLocalDispatch) { dispatchGate.entered = true; await dispatchGate.gate }
      if (input.beforeLocalDispatch) await input.beforeLocalDispatch()
      if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = hoisted.requestChatCompletionMock(input)
      input.onLocalDispatch?.()
      return result
    },
    requestChatCompletionStream: async (input: { beforeLocalDispatch?: () => void | Promise<void>; onLocalDispatch?: () => void; signal?: AbortSignal }) => {
      if (hoisted.teamPreprocessingFails.value && input.onLocalDispatch) throw new Error('fixture preprocessing failed')
      const dispatchGate = hoisted.teamBeforeDispatchGate.value
      if (dispatchGate && input.beforeLocalDispatch) { dispatchGate.entered = true; await dispatchGate.gate }
      if (input.beforeLocalDispatch) await input.beforeLocalDispatch()
      if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      const result = hoisted.requestChatCompletionStreamMock(input)
      input.onLocalDispatch?.()
      return result
    },
    preflightChatRequestImages: (...args: Parameters<typeof actual.preflightChatRequestImages>) => {
      if (hoisted.preflightFailure.value) throw new Error('fixture preflight failed')
      return actual.preflightChatRequestImages(...args)
    },
    resolveAttachmentBatchCapability: hoisted.resolveAttachmentBatchCapabilityMock,
    supportsStreamingChatCompletion: hoisted.supportsStreamingChatCompletionMock
  }
})

vi.mock('./components/SessionSidebar', () => ({
  default: ({
    visibleSessions,
    currentSessionId,
    onCreateSession,
    onSelectSession
  }: {
    visibleSessions: ChatSession[]
    currentSessionId: string | null
    onCreateSession: () => void
    onSelectSession: (sessionId: string) => void
  }) => (
    <div data-testid="session-sidebar-mock">
      <button type="button" data-testid="session-create-mock" onClick={onCreateSession}>
        create-session
      </button>
      <div data-testid="session-current-id">{currentSessionId || 'none'}</div>
      {visibleSessions.map((session) => (
        <button
          key={session.id}
          type="button"
          data-testid={`session-select-${session.id}`}
          onClick={() => onSelectSession(session.id)}
        >
          {session.title}
        </button>
      ))}
    </div>
  )
}))

vi.mock('./components/SessionHistoryDialog', () => ({
  default: () => <div data-testid="session-history-dialog-mock" />
}))

vi.mock('./chatSkillRuntimeResources', async importOriginal => {
  const original = await importOriginal<typeof import('./chatSkillRuntimeResources')>()
  hoisted.resolveSkillRuntimeResourceEntriesMock.mockImplementation(original.resolveSkillRuntimeResourceEntries)
  return { ...original, resolveSkillRuntimeResourceEntries: hoisted.resolveSkillRuntimeResourceEntriesMock }
})

vi.mock('./components/ChatPrimarySelection', () => ({
  default: ({
    selectedProfileId,
    selectedReasoningEffort,
    memberModel,
    memberReasoningEffort,
    onSelectMemberReasoningEffort,
    onSelectProfile,
    onSelectReasoningEffort
  }: {
    selectedProfileId?: string | null
    selectedReasoningEffort?: string | null
    memberModel?: { state: 'inherited' | 'selected'; label: string; onSelectProfile?: (id: string) => void; selectableProfileIds?: readonly string[] } | { state: 'unavailable' }
    memberReasoningEffort?: string | null
    onSelectMemberReasoningEffort?: (effort: 'medium' | 'high' | 'xhigh') => void
    onSelectProfile: (profileId: string | null) => void
    onSelectReasoningEffort?: (effort: 'medium' | 'high' | 'xhigh') => void
  }) => memberModel ? (
    <div data-testid="chat-member-model-mock">
      <span>{memberModel.state === 'unavailable' ? 'unavailable' : `${memberModel.state}:${memberModel.label}`}</span>
      {memberModel.state !== 'unavailable' && <><span data-testid="selectable-member-profile-ids">{JSON.stringify(memberModel.selectableProfileIds)}</span><button type="button" data-testid="forge-member-3d-model" onClick={() => memberModel.onSelectProfile?.('hunyuan3d-pro')}>Attempt unsupported member model</button></>}
      {memberModel.state !== 'unavailable' && memberModel.onSelectProfile ? <button type="button" data-testid="select-member-vision-model" onClick={() => memberModel.onSelectProfile?.('vision-model')}>Select member model</button> : null}
      {onSelectMemberReasoningEffort ? <><span data-testid="member-reasoning-value">{memberReasoningEffort || 'none'}</span><button type="button" data-testid="select-member-reasoning-high" onClick={() => onSelectMemberReasoningEffort('high')}>Select member reasoning</button></> : null}
    </div>
  ) : (
    <div data-testid="chat-primary-selection-mock">
      <button
        type="button"
        data-testid="select-base-model"
        onClick={() => onSelectProfile('base-model')}
      >
        select-base-model
      </button>
      <button
        type="button"
        data-testid="select-vision-model"
        onClick={() => onSelectProfile('vision-model')}
      >
        select-vision-model
      </button>
      <span data-testid="chat-primary-selection-value">{selectedProfileId || 'none'}</span>
      <button
        type="button"
        data-testid="select-reasoning-medium"
        onClick={() => onSelectReasoningEffort?.('medium')}
      >
        select-reasoning-medium
      </button>
      <button
        type="button"
        data-testid="select-reasoning-high"
        onClick={() => onSelectReasoningEffort?.('high')}
      >
        select-reasoning-high
      </button>
      <button
        type="button"
        data-testid="select-reasoning-xhigh"
        onClick={() => onSelectReasoningEffort?.('xhigh')}
      >
        select-reasoning-xhigh
      </button>
      <span data-testid="chat-reasoning-value">{selectedReasoningEffort || 'none'}</span>
    </div>
  )
}))

vi.mock('./components/ChatSkillPicker', () => ({
  default: () => <div data-testid="chat-skill-picker-mock" />
}))

vi.mock('./components/ImagePreviewOverlay', () => ({
  default: () => null
}))

vi.mock('./components/ImageContextMenu', () => ({
  default: () => null
}))

vi.mock('./components/ChatComposer', () => ({
  default: function ChatComposerMock({
    inputValue,
    onInputChange,
    onSend,
    onUploadFile,
    pendingAttachments,
    onRemoveAttachment,
    selectedSkillName,
    addMenuSlot,
    modelSelectorSlot,
    statusSlot,
    inputSyncKey,
    isLoading,
    onStopGenerating,
    onCompressContext,
    onClearContext,
    disableCompressContext,
    disableClearContext
  }: {
    inputValue: string
    onInputChange: (value: string) => void
    onSend: () => void
    onUploadFile: () => void
    pendingAttachments: ChatAttachment[]
    onRemoveAttachment: (index: number) => void
    selectedSkillName?: string
    addMenuSlot?: (closeMenu: () => void) => React.ReactNode
    modelSelectorSlot?: React.ReactNode
    statusSlot?: React.ReactNode
    inputSyncKey?: string
    isLoading: boolean
    onStopGenerating: () => void
    onCompressContext?: () => void
    onClearContext?: () => void
    disableCompressContext?: boolean
    disableClearContext?: boolean
  }) {
    const [draftValue, setDraftValue] = React.useState(inputValue)
    const [addMenuOpen, setAddMenuOpen] = React.useState(false)
    const lastInputSyncRef = React.useRef({ key: inputSyncKey, value: inputValue })

    React.useEffect(() => {
      // Match the real composer's controlled synchronization. An initial effect
      // with unchanged props must not overwrite a user edit queued before it.
      if (
        inputSyncKey === lastInputSyncRef.current.key &&
        inputValue === lastInputSyncRef.current.value
      )
        return
      lastInputSyncRef.current = { key: inputSyncKey, value: inputValue }
      setDraftValue(inputValue)
    }, [inputSyncKey, inputValue])

    return (
      <div data-testid="chat-composer-mock">
        <button type="button" onClick={() => setAddMenuOpen(true)}>open-add-menu</button>
        {addMenuOpen && <div data-testid="test-add-menu">{addMenuSlot?.(() => setAddMenuOpen(false))}</div>}
        <div>{selectedSkillName || 'no-skill'}</div>
        <input
          data-testid="chat-composer-input-mock"
          value={draftValue}
          onChange={(event) => {
            setDraftValue(event.target.value)
            onInputChange(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <button type="button" data-testid="chat-composer-upload-mock" onClick={onUploadFile}>
          upload
        </button>
        <button
          type="button"
          data-testid="chat-composer-compress-context-mock"
          onClick={onCompressContext}
          disabled={disableCompressContext}
        >
          compress-context
        </button>
        <button
          type="button"
          data-testid="chat-composer-clear-context-mock"
          onClick={onClearContext}
          disabled={disableClearContext}
        >
          clear-context
        </button>
        <button type="button" data-testid="chat-composer-send-mock" onClick={onSend}>
          send
        </button>
        {isLoading ? (
          <button type="button" data-testid="chat-composer-stop-mock" onClick={onStopGenerating}>
            stop
          </button>
        ) : null}
        <div data-testid="chat-composer-attachment-count">{pendingAttachments.length}</div>
        {pendingAttachments.map((attachment, index) => (
          <button type="button" key={`${attachment.url}-${index}`} data-testid={`chat-composer-remove-${index}`} onClick={() => onRemoveAttachment(index)}>remove</button>
        ))}
        <div data-testid="chat-composer-attachment-names">
          {pendingAttachments.map((attachment) => attachment.fileName || attachment.url).join('|')}
        </div>
        {modelSelectorSlot}
        {statusSlot}
      </div>
    )
  }
}))

vi.mock('./components/ChatMessageList', () => ({
  default: (props: {
    currentSession?: ChatSession
    isLoading?: boolean
    loadingStatus?: ChatLoadingStatus
    pendingConfirmation?: {
      requestId: string
      prompt: string
      confirmLabel: string
      cancelLabel: string
    } | null
    onResolvePendingConfirmation?: (requestId: string, confirmed: boolean) => void
  }) => {
    hoisted.chatMessageListMock(props)
    return (
      <>
        <pre data-testid="chat-session-state">
          {JSON.stringify(props.currentSession ?? null, null, 2)}
        </pre>
        {props.pendingConfirmation ? (
          <div data-testid="chat-pending-confirmation-mock">
            <span>{props.pendingConfirmation.prompt}</span>
            <button
              type="button"
              data-testid="chat-pending-confirm"
              onClick={() =>
                props.onResolvePendingConfirmation?.(props.pendingConfirmation!.requestId, true)
              }
            >
              {props.pendingConfirmation.confirmLabel}
            </button>
            <button
              type="button"
              data-testid="chat-pending-cancel"
              onClick={() =>
                props.onResolvePendingConfirmation?.(props.pendingConfirmation!.requestId, false)
              }
            >
              {props.pendingConfirmation.cancelLabel}
            </button>
          </div>
        ) : null}
      </>
    )
  }
}))

const theme = createTheme()

const createImageAttachment = (fileName: string): ChatAttachment => ({
  type: 'image',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType: 'image/png',
  sizeBytes: 1024
})

const createFileAttachment = (fileName: string, mimeType = 'application/pdf'): ChatAttachment => ({
  type: 'file',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType,
  sizeBytes: 2048
})

const createSkillReferenceImageAttachment = (fileName: string): SkillReferenceAttachment => ({
  type: 'image',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType: 'image/png',
  sizeBytes: 1024
})

const createSkillReferenceFileAttachment = (
  fileName: string,
  mimeType = 'application/pdf'
): SkillReferenceAttachment => ({
  type: 'file',
  url: `file:///C:/magicpot/${fileName}`,
  fileName,
  mimeType,
  sizeBytes: 2048
})

const renderWithProviders = (ui: React.ReactElement) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={theme}>{ui}</ThemeProvider>
    </MemoryRouter>
  )

const createExpiredContinuationError = (): Error & { status: number; body: string } => {
  const error = new Error('410 expired session continuation') as Error & {
    status: number
    body: string
  }
  error.status = 410
  error.body = JSON.stringify({ error: { code: 'session_expired' } })
  return error
}

/** Picks one entry of the composer "+" menu; the mock composer renders the real addMenuSlot. */
const chooseAddMenuEntry = (
  testId: 'chat-composer-menu-add-member' | 'chat-composer-menu-team'
): void => {
  fireEvent.click(screen.getByRole('button', { name: 'open-add-menu' }))
  fireEvent.click(screen.getByTestId(testId))
}

/**
 * The Agent column has no skills button: a bare "/skills" typed into the composer opens the
 * picker's take-over view. The command replaces whatever draft the composer held, and it is
 * only accepted once the thread's skill scope is bound, hence the retry.
 */
const openSkillTakeover = async (root: HTMLElement = document.body): Promise<void> => {
  await waitFor(() => {
    fireEvent.change(within(root).getByTestId('chat-composer-input-mock'), {
      target: { value: '/skills' }
    })
    fireEvent.click(within(root).getByTestId('chat-composer-send-mock'))
    expect(within(root).getByTestId('chat-skill-picker-mock')).toBeInTheDocument()
  })
}

/**
 * Stands in for AgentWorkspace's open thread list: gives ChatPage the host that its sub-rows
 * (main + side conversations) render into.
 */
function WithThreadSubRows({
  children
}: {
  children: (host: HTMLElement | null) => React.ReactNode
}): React.ReactElement {
  const [host, setHost] = React.useState<HTMLElement | null>(null)
  return (
    <>
      <div data-testid="thread-sub-rows" ref={setHost} />
      {children(host)}
    </>
  )
}

/** The column has no "+" for side conversations: a bare "/btw" opens the new-side form. */
const openNewSideForm = (): void => {
  fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw' } })
  fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
}

const renderChatPage = (
  storageScopeOrProps: string | { acceptExternalInput?: boolean; active?: boolean; team?: boolean } = 'runtime-flow'
) => {
  const storageScope =
    typeof storageScopeOrProps === 'string' ? storageScopeOrProps : 'runtime-flow'
  const acceptExternalInput =
    typeof storageScopeOrProps === 'string' ? undefined : storageScopeOrProps.acceptExternalInput
  const active = typeof storageScopeOrProps === 'string' ? undefined : storageScopeOrProps.active

  return renderWithProviders(
    <ChatPage
      compact
      storageScope={storageScope}
      acceptExternalInput={acceptExternalInput}
      active={active}
      route={typeof storageScopeOrProps!=='string' && storageScopeOrProps.team ? {channel:'canvas',scopeType:'thread',scopeId:'runtime-project',threadId:'runtime-pane'} : undefined}
    />
  )
}

const dispatchNewSession = async (
  detail: {
    requestId?: string
    title?: string
    skillId?: string
    profileId?: string
    initialMessage?: string
    initialAttachments?: ChatAttachment[]
  },
  scope = 'runtime-flow'
) => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('chat:newSession', {
        detail: {
          scope,
          ...detail
        }
      })
    )
  })
}

const dispatchSwitchSession = async (sessionId: string, scope = 'runtime-flow') => {
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent('chat:switchSession', {
        detail: {
          scope,
          sessionId
        }
      })
    )
  })
}

const createLocalFile = (name: string, type: string, path: string): File => {
  const file = new File(['mock-file'], name, { type })
  Object.defineProperty(file, 'path', {
    configurable: true,
    value: path
  })
  return file
}

const readCurrentSessionState = (): ChatSession | null => {
  const serialized = screen.getByTestId('chat-session-state').textContent || 'null'
  return JSON.parse(serialized) as ChatSession | null
}

const readCurrentSessionStateWithin = (container: HTMLElement): ChatSession | null => {
  const serialized = within(container).getByTestId('chat-session-state').textContent || 'null'
  return JSON.parse(serialized) as ChatSession | null
}

const readLatestMessageListProps = (): {
  currentSession?: ChatSession
  isLoading?: boolean
  loadingStatus?: ChatLoadingStatus
} => {
  const calls = hoisted.chatMessageListMock.mock.calls
  return (calls[calls.length - 1]?.[0] || {}) as {
    currentSession?: ChatSession
    isLoading?: boolean
    loadingStatus?: ChatLoadingStatus
  }
}

describe('ChatPage runtime workflow integration', () => {
  beforeEach(async () => {
    hoisted.currentConfig.value = createConfig()
    hoisted.runtimeMcpStatus.value = null
    hoisted.buildDataDir.value = 'C:/MagicPot/Data'
    hoisted.availableProfiles.value = [
      { id: 'base-model', model_name: 'GPT-4o', model_use: 'chat' as const },
      {
        id: 'vision-model',
        model_name: 'Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true
      },
      { id: 'translation-model', model_name: 'Translation Model', model_use: 'chat' as const }
    ]
    hoisted.storedSessions.value = []
    hoisted.scopedTestSessions.value = null
    hoisted.draftBackups.value = {}
    hoisted.saveSessionToDBGate.value = null
    hoisted.saveSessionToDBGateStarted.value = null
    hoisted.selectiveSaveGate.value = null
    hoisted.failTaskResponseSave.value = null
    hoisted.teamPostCommitGate.value = null
    hoisted.teamPostCommitSnapshot.value = null
    hoisted.latestSaveCallback.value = null
    hoisted.saveSuccessCount.value = 0
    hoisted.saveCallbackGate.value = null
    hoisted.saveCallbackGateStarted.value = null
    hoisted.migrationCommitGate.value = null
    hoisted.compareCommitResultGate.value = null
    hoisted.compareCommitted.value = null
    hoisted.migrationStarted.value = false
    hoisted.skipMigrationOnce.value = false
    hoisted.deleteTombstones.value = new Set()
    hoisted.debouncedSaveAllSessionsGate.value = null
    hoisted.loadAllSessionsMock.mockReset()
    hoisted.loadAllSessionsMock.mockImplementation(async () =>
      cloneValue(hoisted.storedSessions.value)
    )
    hoisted.saveAllSessionsMock.mockReset()
    hoisted.saveAllSessionsMock.mockImplementation(async (sessions: ChatSession[]) => {
      hoisted.storedSessions.value = cloneValue(sessions)
    })
    hoisted.readTextFileMock.mockReset()
    Object.values(hoisted.agentLocalFilesService).forEach((method) => method.mockReset())
    hoisted.agentLocalFilesService.setScope.mockResolvedValue(undefined)
    hoisted.agentLocalFilesService.choose.mockResolvedValue(null)
    hoisted.agentLocalFilesService.list.mockResolvedValue({ entries: [], truncated: false })
    hoisted.agentLocalFilesService.revoke.mockResolvedValue(undefined)
    hoisted.agentLocalFilesService.cancel.mockResolvedValue(undefined)
    hoisted.fileExistsBatchMock.mockReset(); hoisted.fileExistsBatchMock.mockImplementation(async (paths: string[]) => paths.map(() => true))
    hoisted.saveImageToDirMock.mockReset()
    hoisted.saveImageToDirMock.mockResolvedValue({
      savedPath: 'C:/MagicPot/AutoSave/Agent/chat_upload.png'
    })
    hoisted.chatMessageListMock.mockClear()
    hoisted.notifySuccessMock.mockReset()
    hoisted.notifyErrorMock.mockReset()
    hoisted.notifyWarningMock.mockReset()
    hoisted.notifyInfoMock.mockReset()
    hoisted.resolveSkillRuntimeResourceEntriesMock.mockReset()
    const resources = await vi.importActual<typeof import('./chatSkillRuntimeResources')>('./chatSkillRuntimeResources')
    hoisted.resolveSkillRuntimeResourceEntriesMock.mockImplementation(resources.resolveSkillRuntimeResourceEntries)
    hoisted.resolveAttachmentBatchCapabilityMock.mockReset()
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(1)
    hoisted.teamPreprocessingFails.value = false
    hoisted.preflightFailure.value = false
    hoisted.teamBeforeDispatchGate.value = null
    hoisted.teamPreflightReadGate.value = null
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionStreamMock.mockReset()
    hoisted.listAgentInteractionsMock.mockReset()
    hoisted.listAgentTeamMessagesMock.mockReset(); hoisted.listAgentTeamMessagesMock.mockResolvedValue({ intents: [] })
    hoisted.claimAgentTeamMessageMock.mockReset(); hoisted.claimAgentTeamMessageMock.mockResolvedValue({})
    hoisted.listAgentInteractionsMock.mockResolvedValue({ interactions: [] })
    hoisted.resolveAgentInteractionMock.mockReset()
    hoisted.resolveAgentInteractionMock.mockResolvedValue(undefined)
    hoisted.saveAgentHtmlAppMock.mockReset(); hoisted.listSavedAgentHtmlAppsMock.mockReset(); hoisted.listSavedAgentHtmlAppsMock.mockResolvedValue({ apps: [] }); hoisted.restoreAgentHtmlAppMock.mockReset(); hoisted.deleteSavedAgentHtmlAppMock.mockReset()
    hoisted.setAgentHtmlScopeMock.mockReset(); hoisted.setAgentHtmlScopeMock.mockResolvedValue({ documentToken: 'document-token' })
    hoisted.agentHtmlStorageStatusMock.mockReset(); hoisted.agentHtmlStorageStatusMock.mockResolvedValue({ enabled: false, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false }); hoisted.initializeAgentHtmlStorageMock.mockReset()
    hoisted.listAgentHtmlAppsMock.mockReset(); hoisted.listAgentHtmlAppsMock.mockResolvedValue({ apps: [] }); hoisted.openAgentHtmlAppMock.mockReset(); hoisted.closeAgentHtmlAppMock.mockReset()
    hoisted.listAgentSidesMock.mockReset(); hoisted.listAgentSidesMock.mockResolvedValue({ branches: [] })
    hoisted.openAgentSideMock.mockReset(); hoisted.startAgentSideMock.mockReset(); hoisted.continueAgentSideMock.mockReset(); hoisted.stopAgentSideMock.mockReset(); hoisted.deleteAgentSideMock.mockReset()
    hoisted.listAgentProcessesMock.mockReset()
    hoisted.listAgentProcessesMock.mockResolvedValue({ jobs: [] })
    hoisted.readAgentProcessMock.mockReset()
    hoisted.stopAgentProcessMock.mockReset()
    hoisted.listAgentJobsMock.mockReset()
    hoisted.listAgentJobsMock.mockResolvedValue({ jobs: [] })
    hoisted.readAgentJobMock.mockReset()
    hoisted.stopAgentJobMock.mockReset()
    hoisted.listAgentArchiveQueriesMock.mockReset()
    hoisted.listAgentArchiveQueriesMock.mockResolvedValue({ queries: [] })
    hoisted.resolveAgentArchiveQueryMock.mockReset()
    hoisted.resolveAgentArchiveQueryMock.mockResolvedValue(undefined)
    hoisted.prepareAgentGoalProgressMock.mockReset(); hoisted.prepareAgentGoalProgressMock.mockImplementation(async req => ({ token: 'goal-once', goalId: req.goalId, generation: req.expectedGeneration, profileId: req.profileId, expiresAt: Date.now() + 120000, mode: 'progress-only', budgetsEnforced: false, grantsPermission: false }))
    hoisted.agentGoalScopeRevisionMock.mockReset(); hoisted.agentGoalScopeRevisionMock.mockResolvedValue({ revision: 0 })
    hoisted.setAgentGoalScopeMock.mockReset(); hoisted.setAgentGoalScopeMock.mockResolvedValue({ documentToken: 'goal-document' })
    hoisted.listAgentGoalDispatchesMock.mockReset(); hoisted.listAgentGoalDispatchesMock.mockResolvedValue({ revision: 0, runs: [], limits: { runs: 4, attemptsPerRun: 32, retainedReceipts: 264 }, scopeBlocked: false, orphaned: false, mutationBlocked: false, mode: 'data-only', budgetsEnforced: false, grantsPermission: false })
    hoisted.listAgentGoalsMock.mockReset(); hoisted.listAgentGoalsMock.mockResolvedValue({ revision: 0, goals: [], grantsPermission: false, untrustedData: true })
    hoisted.mutateAgentGoalMock.mockReset()
    hoisted.managedFirstRunPaneRevisionMock.mockReset(); hoisted.managedFirstRunPaneRevisionMock.mockResolvedValue({ revision: 50 })
    hoisted.setManagedFirstRunPaneScopeMock.mockReset(); hoisted.setManagedFirstRunPaneScopeMock.mockImplementation(async req => req.active ? { documentToken: `pane-${req.lifecycleRevision}` } : {})
    hoisted.agentSkillScopeRevisionMock.mockReset(); hoisted.agentSkillScopeRevisionMock.mockResolvedValue({ revision: 0 })
    hoisted.setAgentSkillScopeMock.mockReset(); hoisted.setAgentSkillScopeMock.mockResolvedValue({ documentToken: 'skill-document' })
    hoisted.listAgentSessionSkillsMock.mockReset(); hoisted.listAgentSessionSkillsMock.mockResolvedValue({ revision: 0, skills: [], staleDisabledIds: [], truncated: false, grantsPermission: false })
    hoisted.showAgentSessionSkillMock.mockReset()
    hoisted.setAgentSkillPreferenceMock.mockReset()
    hoisted.getAgentNotesMock.mockReset()
    hoisted.getAgentNotesMock.mockResolvedValue({ revision: 0, notes: [] })
    hoisted.mutateAgentNoteMock.mockReset()
    hoisted.supportsStreamingChatCompletionMock.mockReset()
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(false)
    hoisted.selectFileMock.mockReset()
    hoisted.selectFileMock.mockResolvedValue(null)
    hoisted.fileToBlobUrlMock.mockClear()
    hoisted.fileToDataUrlMock.mockClear()
    const managedResponse = {
      version: 1 as const,
      reference: {
        version: 1 as const,
        kind: 'managed' as const,
        relativePath: `originals/${'a'.repeat(64)}.png`,
        sha256: 'a'.repeat(64),
        mimeType: 'image/png',
        sizeBytes: 3,
        originalFileName: 'attachment.png'
      },
      localMediaUrl: 'media://managed/original.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      sha256: 'a'.repeat(64)
    }
    hoisted.importManagedFileMock.mockReset()
    hoisted.importManagedFileMock.mockResolvedValue(managedResponse)
    hoisted.importManagedDataUrlMock.mockReset()
    hoisted.importManagedDataUrlMock.mockResolvedValue(managedResponse)
    hoisted.importManagedUrlMock.mockReset()
    hoisted.importManagedUrlMock.mockResolvedValue(managedResponse)
    hoisted.requestChatCompletionMock.mockImplementation(
      async ({
        skillRuntime,
        messages
      }: {
        skillRuntime?: { skillId?: string }
        messages: Array<{ attachments?: ChatAttachment[] }>
      }) => {
        const lastMessage = messages[messages.length - 1]
        const firstAttachment = lastMessage?.attachments?.[0]
        const attachmentBaseName = firstAttachment?.fileName?.replace(/\.[^.]+$/, '') || 'asset'

        switch (skillRuntime?.skillId) {
          case BUILT_IN_IMAGE_INTERROGATION_SKILL_ID:
            return {
              content: `visual analysis for ${attachmentBaseName}`
            }
          case BUILT_IN_PROMPT_TRANSLATION_SKILL_ID:
            return {
              content: 'translated prompt output'
            }
          default:
            return {
              content: 'default reply'
            }
        }
      }
    )

    localStorage.clear()
    sessionStorage.clear()
    document.body.innerHTML = [
      `<div id="${buildChatWorkspaceControlsPortalId('runtime-flow')}"></div>`,
      `<div id="${buildChatWorkspaceControlsPortalId('runtime-flow-a')}"></div>`,
      `<div id="${buildChatWorkspaceControlsPortalId('runtime-flow-b')}"></div>`
    ].join('')

    Object.defineProperty(window.HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn()
    })
  })

  describe('canvas file paths as plain text', () => {
    const route = {
      channel: 'canvas' as const,
      scopeType: 'thread' as const,
      scopeId: 'local-file-project',
      threadId: 'local-file-pane'
    }

    function expectNoLocalFileReadActivity() {
      expect(screen.queryByRole('region', { name: 'Text preview' })).not.toBeInTheDocument()
      expect(
        screen.queryByRole('button', { name: 'Use this text in the conversation' })
      ).not.toBeInTheDocument()
      expect(hoisted.agentLocalFilesService.choose).not.toHaveBeenCalled()
      expect(hoisted.agentLocalFilesService.read).not.toHaveBeenCalled()
      expect(hoisted.agentLocalFilesService.list).not.toHaveBeenCalled()
      expect(hoisted.agentLocalFilesService.cancel).not.toHaveBeenCalled()
      expect(hoisted.readTextFileMock).not.toHaveBeenCalled()
      expect(hoisted.selectFileMock).not.toHaveBeenCalled()
      expect(hoisted.importManagedFileMock).not.toHaveBeenCalled()
      expect(hoisted.importManagedDataUrlMock).not.toHaveBeenCalled()
      expect(hoisted.importManagedUrlMock).not.toHaveBeenCalled()
    }

    it.each([
      { name: 'Windows backslash path', value: String.raw`C:\Users\tester\notes\launch.txt` },
      { name: 'relative path', value: './notes/launch.txt' },
      { name: 'path with spaces', value: String.raw`C:\Project Notes\release brief.pdf` }
    ])('sends $name unchanged without a chooser or attachment', async ({ value }) => {
      const { unmount } = renderWithProviders(
        <ChatPage compact storageScope="runtime-flow" route={route} />
      )
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const sessionId = readCurrentSessionState()!.id
      const input = screen.getByTestId('chat-composer-input-mock')
      fireEvent.change(input, { target: { value } })
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(value))
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expectNoLocalFileReadActivity()

      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      const request = hoisted.requestChatCompletionMock.mock.calls[0][0] as {
        messages: ChatMessage[]
      }
      const sent = request.messages.filter((message) => message.role === 'user').at(-1)!
      expect(sent.content).toBe(value)
      expect(sent.attachments ?? []).toEqual([])
      await waitFor(() => {
        const saved = hoisted.storedSessions.value.find((session) => session.id === sessionId)
        expect(saved?.messages.find((message) => message.role === 'user')?.content).toBe(value)
        expect(saved?.messages.at(-1)?.content).toBe('default reply')
      })
      expectNoLocalFileReadActivity()
      unmount()
      expectNoLocalFileReadActivity()
    })

    it('isolates and restores path drafts across sessions without choosing or reading files', async () => {
      const sessions: ChatSession[] = [
        { id: 'local-file-old', title: 'Old session', messages: [], createdAt: 100 },
        { id: 'local-file-new', title: 'New session', messages: [], createdAt: 200 }
      ]
      hoisted.storedSessions.value = sessions
      localStorage.setItem(
        scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
        sessions[0].id
      )
      const { unmount } = renderWithProviders(
        <ChatPage compact storageScope="runtime-flow" route={route} />
      )
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(sessions[0].id))
      const firstPath = String.raw`C:\Project Notes\first.txt`
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: firstPath }
      })
      expectNoLocalFileReadActivity()

      await dispatchSwitchSession(sessions[1].id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(sessions[1].id))
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
      const secondPath = './notes/second draft.txt'
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: secondPath }
      })
      expectNoLocalFileReadActivity()

      await dispatchSwitchSession(sessions[0].id)
      await waitFor(() =>
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(firstPath)
      )
      await dispatchSwitchSession(sessions[1].id)
      await waitFor(() =>
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(secondPath)
      )
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expectNoLocalFileReadActivity()
      unmount()
      expectNoLocalFileReadActivity()
    })

    it('keeps an unsent path draft without opening a chooser or reading the file', async () => {
      const { unmount } = renderWithProviders(
        <ChatPage compact storageScope="runtime-flow" route={route} />
      )
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const value = String.raw`C:\Users\tester\unsent notes.txt`
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value } })
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(value)
      expectNoLocalFileReadActivity()
      unmount()
      expectNoLocalFileReadActivity()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    })
  })

  it('offline team activity shows the lead profile model name', async () => {
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    try {
      const lead: ChatSession = { id: 'model-lead', title: 'Lead', messages: [], profileId: 'lead-profile' }
      const member: ChatSession = { id: 'model-member', title: 'Member', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
      hoisted.currentConfig.value!.llm_config.api_profiles = [{ id: 'lead-profile', model_name: 'Lead Fixture Model', base_url: 'http://127.0.0.1', api_key: 'fixture' }]
      hoisted.availableProfiles.value = [{ id: 'lead-profile', model_name: 'Lead Fixture Model', model_use: 'chat' }]
      hoisted.storedSessions.value = [lead, member]
      localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
      renderChatPage({ team: true })
      const area = await screen.findByRole('region', { name: '进程区' })
      fireEvent.click(within(area).getByRole('button', { name: '展开 Alice 详情' }))
      expect(within(area).getByText('模型：Lead Fixture Model')).toBeVisible()
      expect(fetchGuard).not.toHaveBeenCalled()
    } finally { fetchGuard.mockRestore() }
  })

  it('shows the explicit member model in expanded member details instead of the lead model', async () => {
    const lead: ChatSession = {id:'detail-choice-lead', title:'Lead', messages:[], profileId:'base-model'}
    const member: ChatSession = {id:'detail-choice-member', title:'Member', messages:[], teamLeadId:lead.id, teamMemberName:'Alice', memberModelChoice:{version:1,profileId:'vision-model'}}
    hoisted.currentConfig.value!.llm_config.api_profiles = [
      {id:'base-model',model_name:'Lead Model',base_url:'http://127.0.0.1',api_key:'fixture'},
      {id:'vision-model',model_name:'Member Model',base_url:'http://127.0.0.1',api_key:'fixture'}
    ]
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({team:true})
    const area = await screen.findByRole('region', {name:'进程区'})
    fireEvent.click(within(area).getByRole('button',{name:'展开 Alice 详情'}))
    expect(within(area).getByText('模型：Member Model')).toBeVisible()
    expect(within(area).queryByText('模型：Lead Model')).not.toBeInTheDocument()
  })
  it('shows unavailable rather than the lead model in member details when a versioned selection is blocked', async () => {
    const lead: ChatSession = { id:'model-blocked-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId:'vision-model'}} }
    const member: ChatSession = { id:'model-blocked-member', title:'Member', messages:[], teamLeadId:lead.id, teamMemberName:'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({team:true})
    const area = await screen.findByRole('region', {name:'进程区'})
    fireEvent.click(within(area).getByRole('button',{name:'展开 Alice 详情'}))
    expect(within(area).getByText('模型：设置不可用')).toBeVisible()
    expect(within(area).queryByText('模型：组长模型')).not.toBeInTheDocument()
  })

  it('offline process area creates members from the conversation header and keeps navigation and management available', async () => {
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    try {
      const lead: ChatSession = { id: 'process-area-lead', title: 'Lead', messages: [], profileId: 'base-model' }
      hoisted.storedSessions.value = [lead]
      localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
      renderChatPage({ team: true })
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      expect(screen.queryByRole('region', { name: '进程区' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '团队管理' })).not.toBeInTheDocument()
      // No banner above the transcript: a lead without a team offers only "add member" in the "+" menu.
      expect(screen.queryByTestId('team-conversation-actions')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'open-add-menu' }))
      expect(screen.getByTestId('chat-composer-menu-add-member')).toBeInTheDocument()
      expect(screen.queryByTestId('chat-composer-menu-team')).not.toBeInTheDocument()
      chooseAddMenuEntry('chat-composer-menu-add-member')
      fireEvent.change(screen.getByLabelText('成员名'), { target: { value: 'Alice' } })
      fireEvent.change(screen.getByLabelText('角色 / 当前任务'), { target: { value: 'Alice' } })
      fireEvent.click(screen.getByRole('button', { name: '确认创建成员' }))
      const area = await screen.findByRole('region', { name: '进程区' })
      const alice = await within(area).findByRole('button', { name: '打开 Alice' })
      expect(alice).toHaveTextContent('Alice')
      expect(alice.textContent?.match(/Alice/g)).toHaveLength(1)
      chooseAddMenuEntry('chat-composer-menu-team')
      fireEvent.click(screen.getByRole('button', { name: '组建团队 / 添加成员' }))
      fireEvent.change(screen.getByLabelText('成员名'), { target: { value: 'Bob' } })
      fireEvent.change(screen.getByLabelText('角色 / 当前任务'), { target: { value: 'Writer' } })
      fireEvent.click(screen.getByRole('button', { name: '确认创建成员' }))
      expect(await within(area).findByRole('button', { name: '打开 Bob' })).toHaveTextContent('Bob · Writer')
      fireEvent.click(alice)
      await waitFor(() => expect(readCurrentSessionState()?.teamMemberName).toBe('Alice'))
      await waitFor(() => expect(within(area).getByRole('button', { name: '打开 Alice' })).toHaveAttribute('aria-current', 'page'))
      fireEvent.click(within(area).getByRole('button', { name: /返回组长/ }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      const collapse = within(area).getByRole('button', { name: /进程 ·/ })
      fireEvent.click(collapse)
      expect(collapse).toHaveAttribute('aria-expanded', 'false')
      expect(within(area).queryByRole('button', { name: '打开 Alice' })).not.toBeInTheDocument()
      fireEvent.click(collapse)
      expect(within(area).getByRole('button', { name: '打开 Alice' })).toBeVisible()
      expect(fetchGuard).not.toHaveBeenCalled()
    } finally { fetchGuard.mockRestore() }
  })

  it('offline process area stops a running member and retains its row', async () => {
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    try {
      const lead: ChatSession = { id: 'process-running-lead', title: 'Lead', messages: [], profileId: 'base-model' }
      const member: ChatSession = { id: 'process-running-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
      hoisted.storedSessions.value = [lead, member]
      localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
      let release!: (value: { content: string }) => void
      hoisted.requestChatCompletionMock.mockImplementation(() => new Promise(resolve => { release = resolve }))
      renderChatPage({ team: true })
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Alice run' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      const area = await screen.findByRole('region', { name: '进程区' })
      await waitFor(() => expect(within(area).getByRole('button', { name: '停止 Alice' })).toBeVisible())
      fireEvent.click(within(area).getByRole('button', { name: '停止 Alice' }))
      await act(async () => release({ content: 'late fixture response' }))
      expect(await within(area).findByRole('button', { name: '打开 Alice' })).toBeVisible()
      expect(fetchGuard).not.toHaveBeenCalled()
    } finally { fetchGuard.mockRestore() }
  })

  it('offline process area retains a completed member after its response', async () => {
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'))
    try {
      const lead: ChatSession = { id: 'process-complete-lead', title: 'Lead', messages: [], profileId: 'base-model' }
      const member: ChatSession = { id: 'process-complete-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
      hoisted.storedSessions.value = [lead, member]
      localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
      hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'fixture completed' })
      renderChatPage({ team: true })
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Alice run' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      const area = await screen.findByRole('region', { name: '进程区' })
      await waitFor(() => expect(within(area).getByRole('button', { name: '打开 Alice' })).toHaveTextContent('已完成'))
      expect(within(area).queryByRole('button', { name: '停止 Alice' })).not.toBeInTheDocument()
      expect(fetchGuard).not.toHaveBeenCalled()
    } finally { fetchGuard.mockRestore() }
  })

  it('shows a process refresh failure when no entries exist and hides it after recovery', async () => {
    const lead: ChatSession = { id: 'empty-process-failure', title: 'Lead', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    let release!: (value: { jobs: [] }) => void
    const recovered = new Promise<{ jobs: [] }>(resolve => { release = resolve })
    hoisted.listAgentProcessesMock.mockRejectedValueOnce(new Error('synthetic list failure')).mockImplementation(() => recovered)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(hoisted.listAgentProcessesMock).toHaveBeenCalled())
      const warning = await screen.findByText('当前对话后台进程状态刷新失败')
      expect(warning).toBeVisible()
      const area = screen.getByRole('region', { name: '进程区' })
      expect(within(area).queryByRole('button', { name: /进程 ·/ })).not.toBeInTheDocument()
      expect(within(area).queryByRole('list', { name: '进程列表' })).not.toBeInTheDocument()
      expect(within(area).queryByRole('button', { name: /停止/ })).not.toBeInTheDocument()
      await waitFor(() => expect(hoisted.listAgentProcessesMock.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2500 })
      await act(async () => release({ jobs: [] }))
      await waitFor(() => expect(screen.queryByRole('region', { name: '进程区' })).not.toBeInTheDocument())
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { release({ jobs: [] }); page.unmount() }
  })

  it.each(['jobs', 'processes'] as const)('warns that retained %s states may be stale until a later poll succeeds', async kind => {
    const lead: ChatSession = { id: `stale-${kind}`, title: 'Lead', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const now = Date.now()
    const running = kind === 'jobs'
      ? { id: 'stale-helper', kind: 'explore', task: 'synthetic', status: 'running', createdAt: now, expiresAt: now + 60000 }
      : { id: 'stale-process', kind: 'python', status: 'running', createdAt: now, expiresAt: now + 60000, outcome: 'known', stdoutBytes: 0, stderrBytes: 0, truncated: false, operationSettled: false, cancellationRequested: false }
    const completed = { ...running, status: 'completed', ...(kind === 'processes' ? { operationSettled: true, exitCode: 0 } : {}) }
    let release!: (value: { jobs: typeof completed[] }) => void
    const recovered = new Promise<{ jobs: typeof completed[] }>(resolve => { release = resolve })
    const list = kind === 'jobs' ? hoisted.listAgentJobsMock : hoisted.listAgentProcessesMock
    list.mockResolvedValueOnce({ jobs: [running] }).mockRejectedValueOnce(new Error('synthetic list failure')).mockImplementation(() => recovered)
    const page = renderChatPage({ team: true })
    try {
      const rowName = kind === 'jobs' ? '展开 explore 详情' : '展开 python 详情'
      const row = await screen.findByRole('button', { name: rowName })
      expect(row).toHaveTextContent('运行中')
      expect(await screen.findByText('当前对话后台进程状态刷新失败，部分显示的状态可能已过期。', {}, { timeout: 3500 })).toBeVisible()
      expect(row).toHaveTextContent('运行中')
      await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 3500 })
      await act(async () => release({ jobs: [completed] }))
      await waitFor(() => expect(screen.queryByText('当前对话后台进程状态刷新失败，部分显示的状态可能已过期。')).not.toBeInTheDocument())
      await waitFor(() => expect(screen.getByRole('button', { name: rowName })).toHaveTextContent('已完成'))
      expect(hoisted.stopAgentJobMock).not.toHaveBeenCalled()
      expect(hoisted.stopAgentProcessMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { release({ jobs: [completed] }); page.unmount() }
  })

  it.each(['jobs', 'processes'] as const)('does not mark a successful %s controller stale when the other controller fails with no entries', async kind => {
    const lead: ChatSession = { id: `fresh-${kind}`, title: 'Lead', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const now = Date.now()
    const running = kind === 'jobs'
      ? { id: 'fresh-helper', kind: 'explore', task: 'synthetic', status: 'running', createdAt: now, expiresAt: now + 60000 }
      : { id: 'fresh-process', kind: 'python', status: 'running', createdAt: now, expiresAt: now + 60000, outcome: 'known', stdoutBytes: 0, stderrBytes: 0, truncated: false, operationSettled: false, cancellationRequested: false }
    const successful = kind === 'jobs' ? hoisted.listAgentJobsMock : hoisted.listAgentProcessesMock
    const failing = kind === 'jobs' ? hoisted.listAgentProcessesMock : hoisted.listAgentJobsMock
    successful.mockResolvedValue({ jobs: [running] })
    failing.mockRejectedValue(new Error('synthetic other-controller failure'))
    const page = renderChatPage({ team: true })
    try {
      const rowName = kind === 'jobs' ? '展开 explore 详情' : '展开 python 详情'
      expect(await screen.findByRole('button', { name: rowName })).toHaveTextContent('运行中')
      expect(await screen.findByText('当前对话后台进程状态刷新失败')).toBeVisible()
      expect(screen.queryByText('当前对话后台进程状态刷新失败，部分显示的状态可能已过期。')).not.toBeInTheDocument()
      expect(hoisted.stopAgentJobMock).not.toHaveBeenCalled()
      expect(hoisted.stopAgentProcessMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('keeps the same process area and collapsed state across teams and an ordinary session in one pane', async () => {
    const leadA: ChatSession = { id: 'stable-lead-a', title: 'Lead A', messages: [] }
    const alice: ChatSession = { id: 'stable-alice', title: 'Alice', messages: [], teamLeadId: leadA.id, teamMemberName: 'Alice' }
    const leadB: ChatSession = { id: 'stable-lead-b', title: 'Lead B', messages: [] }
    const bob: ChatSession = { id: 'stable-bob', title: 'Bob', messages: [], teamLeadId: leadB.id, teamMemberName: 'Bob' }
    const ordinary: ChatSession = { id: 'stable-ordinary', title: 'Ordinary', messages: [] }
    hoisted.storedSessions.value = [leadA, alice, leadB, bob, ordinary]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), alice.id)
    const now = Date.now()
    const job = (id: string, kind: 'explore' | 'python') => ({ id, kind, task: id, status: 'running', createdAt: now, expiresAt: now + 60000 })
    const aliceJob = job('alice-job', 'explore'), bobJob = job('bob-job', 'python'), ordinaryJob = job('ordinary-job', 'python')
    let releaseOrdinary!: (result: { jobs: typeof ordinaryJob[] }) => void
    hoisted.listAgentJobsMock.mockImplementation(({ conversationId }: { conversationId: string }) => {
      if (conversationId === ordinary.id) return new Promise(resolve => { releaseOrdinary = resolve })
      return Promise.resolve({ jobs: conversationId === alice.id ? [aliceJob] : conversationId === bob.id ? [bobJob] : [] })
    })
    const view = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(alice.id))
      const area = await screen.findByRole('region', { name: '进程区' })
      await within(area).findByRole('button', { name: '展开 explore 详情' })
      expect(within(area).getByRole('button', { name: '打开 Alice' })).toHaveAttribute('aria-current', 'page')
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      const assertSameArea = () => {
        expect(area.isConnected).toBe(true)
        expect(document.querySelector('section[aria-label="进程区"]')).toBe(area)
      }
      const assertCollapsed = () => expect(within(area).getByRole('button', { name: /进程 ·/ })).toHaveAttribute('aria-expanded', 'false')
      assertCollapsed()
      await dispatchSwitchSession(bob.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(bob.id))
      await waitFor(() => expect(area.textContent).toContain('python'))
      assertSameArea(); assertCollapsed()
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      expect(within(area).getByRole('button', { name: '打开 Bob' })).toHaveAttribute('aria-current', 'page')
      expect(within(area).getByRole('button', { name: '展开 python 详情' })).toBeVisible()
      expect(within(area).queryByRole('button', { name: '展开 explore 详情' })).not.toBeInTheDocument()
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      await dispatchSwitchSession(ordinary.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(ordinary.id))
      await waitFor(() => expect(releaseOrdinary).toBeDefined())
      assertSameArea()
      expect(area).toHaveAttribute('hidden')
      expect(area).toBeEmptyDOMElement()
      await act(async () => releaseOrdinary({ jobs: [ordinaryJob] }))
      await waitFor(() => expect(area.textContent).toContain('python'))
      assertSameArea(); assertCollapsed()
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      expect(within(area).getByRole('button', { name: '展开 python 详情' })).toBeVisible()
      expect(within(area).queryByRole('button', { name: '打开 Bob' })).not.toBeInTheDocument()
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      await dispatchSwitchSession(alice.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(alice.id))
      await waitFor(() => expect(area.textContent).toContain('explore'))
      assertSameArea(); assertCollapsed()
      fireEvent.click(within(area).getByRole('button', { name: /进程 ·/ }))
      expect(within(area).getByRole('button', { name: '打开 Alice' })).toHaveAttribute('aria-current', 'page')
      expect(within(area).getByRole('button', { name: '展开 explore 详情' })).toBeVisible()
      expect(within(area).queryByRole('button', { name: '展开 python 详情' })).not.toBeInTheDocument()
      expect(hoisted.listAgentJobsMock).toHaveBeenCalledWith({ route: { channel: 'canvas', scopeType: 'thread', scopeId: 'runtime-project', threadId: 'runtime-pane' }, conversationId: ordinary.id })
    } finally { view.unmount() }
  })

  it('warns that retained lead job states may be stale until the lead poll succeeds', async () => {
    const lead: ChatSession = { id: 'stale-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'stale-lead-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    const running = { id: 'stale-lead-job', kind: 'explore', task: 'synthetic', status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 }
    const completed = { ...running, status: 'completed' }
    let release!: (value: { jobs: typeof completed[] }) => void
    const recovered = new Promise<{ jobs: typeof completed[] }>(resolve => { release = resolve })
    let leadPolls = 0
    hoisted.listAgentJobsMock.mockImplementation(({ conversationId }: { conversationId: string }) => {
      if (conversationId !== lead.id) return Promise.resolve({ jobs: [] })
      leadPolls++
      if (leadPolls === 1) return Promise.resolve({ jobs: [running] })
      if (leadPolls === 2) return Promise.reject(new Error('synthetic lead list failure'))
      return recovered
    })
    const page = renderChatPage({ team: true })
    try {
      const rowName = '展开 组长 · explore 详情'
      const row = await screen.findByRole('button', { name: rowName })
      expect(row).toHaveTextContent('运行中')
      expect(await screen.findByText('组长后台助手状态刷新失败，部分显示的状态可能已过期。', {}, { timeout: 3500 })).toBeVisible()
      expect(row).toHaveTextContent('运行中')
      await waitFor(() => expect(leadPolls).toBeGreaterThanOrEqual(3), { timeout: 3500 })
      await act(async () => release({ jobs: [completed] }))
      await waitFor(() => expect(screen.queryByText('组长后台助手状态刷新失败，部分显示的状态可能已过期。')).not.toBeInTheDocument())
      await waitFor(() => expect(screen.getByRole('button', { name: rowName })).toHaveTextContent('已完成'))
      expect(hoisted.stopAgentJobMock).not.toHaveBeenCalled()
      expect(hoisted.stopAgentProcessMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { release({ jobs: [completed] }); page.unmount() }
  })

  it('offline member process area keeps current and lead job scopes distinct and current wins collisions', async () => {
    const lead: ChatSession = { id: 'jobs-scope-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'jobs-scope-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    const now = Date.now()
    const job = (id: string, kind: 'explore' | 'python') => ({ id, kind, task: id, status: 'running', createdAt: now, expiresAt: now + 60000 })
    hoisted.listAgentJobsMock.mockImplementation(async ({ conversationId }: { conversationId: string }) => ({ jobs: conversationId === member.id ? [job('shared', 'explore')] : conversationId === lead.id ? [job('shared', 'explore'), job('lead-only', 'python')] : [] }))
    hoisted.readAgentJobMock.mockResolvedValue({ job: job('lead-only', 'python'), text: 'LEAD JOB DATA', nextOffset: 13, totalCharacters: 13 })
    hoisted.stopAgentJobMock.mockResolvedValue({ stopped: true })
    const view = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      const area = await screen.findByRole('region', { name: '进程区' })
      await within(area).findByRole('button', { name: '展开 组长 · python 详情' })
      expect(within(area).getAllByRole('button', { name: '展开 explore 详情' })).toHaveLength(1)
      expect(within(area).queryByRole('button', { name: '展开 组长 · explore 详情' })).not.toBeInTheDocument()
      expect(new Set(hoisted.listAgentJobsMock.mock.calls.map(([arg]) => arg.conversationId))).toEqual(new Set([member.id, lead.id]))
      fireEvent.click(within(area).getByRole('button', { name: '展开 组长 · python 详情' }))
      fireEvent.click(within(area).getByRole('button', { name: 'chat.agent_jobs.read' }))
      await waitFor(() => expect(hoisted.readAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: lead.id, jobId: 'lead-only', offset: 0, limit: 16000 })))
      expect(await within(area).findByText('LEAD JOB DATA')).toBeVisible()
      fireEvent.click(within(area).getByRole('button', { name: '停止 组长 · python' }))
      await waitFor(() => expect(hoisted.stopAgentJobMock).toHaveBeenCalledWith(expect.objectContaining({ conversationId: lead.id, jobId: 'lead-only' })))
    } finally { view.unmount() }
  })

  it('offline member lead jobs are fenced while End is pending and recover after End fails', async () => {
    const lead: ChatSession = { id: 'pending-end-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'pending-end-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    const job = { id: 'lead-pending-job', kind: 'explore', task: 'pending', status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 }
    hoisted.listAgentJobsMock.mockImplementation(async ({ conversationId }: { conversationId: string }) => ({ jobs: conversationId === lead.id ? [job] : [] }))
    let rejectEnd!: (reason: Error) => void
    hoisted.endTeamMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnd = reject }))
    const view = renderChatPage({ team: true })
    try {
      await screen.findByRole('button', { name: '展开 组长 · explore 详情' })
      chooseAddMenuEntry('chat-composer-menu-team')
      fireEvent.click(screen.getByRole('button', { name: '结束团队' }))
      await waitFor(() => expect(rejectEnd).toBeDefined())
      const count = hoisted.listAgentJobsMock.mock.calls.filter(([arg]) => arg.conversationId === lead.id).length
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
      expect(hoisted.listAgentJobsMock.mock.calls.filter(([arg]) => arg.conversationId === lead.id)).toHaveLength(count)
      expect(screen.queryByRole('button', { name: '展开 组长 · explore 详情' })).not.toBeInTheDocument()
      expect(hoisted.readAgentJobMock).not.toHaveBeenCalled()
      expect(hoisted.stopAgentJobMock).not.toHaveBeenCalled()
      await act(async () => rejectEnd(new Error('fixture end failed')))
      expect(await screen.findByRole('button', { name: '展开 组长 · explore 详情' })).toBeVisible()
      await waitFor(() => expect(hoisted.listAgentJobsMock.mock.calls.filter(([arg]) => arg.conversationId === lead.id).length).toBeGreaterThan(count))
    } finally { view.unmount() }
  })

  it('offline lead job read settling during pending End cannot restore stale output', async () => {
    const lead: ChatSession = { id: 'late-read-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'late-read-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    const job = { id: 'late-read', kind: 'explore', task: 'fixture', status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 }
    hoisted.listAgentJobsMock.mockImplementation(async ({ conversationId }: { conversationId: string }) => ({ jobs: conversationId === lead.id ? [job] : [] }))
    let finishRead!: (value: unknown) => void
    let rejectEnd!: (error: Error) => void
    hoisted.readAgentJobMock.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    hoisted.endTeamMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectEnd = reject }))
    const view = renderChatPage({ team: true })
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 组长 · explore 详情' }))
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
      await waitFor(() => expect(finishRead).toBeDefined())
      chooseAddMenuEntry('chat-composer-menu-team')
      fireEvent.click(screen.getByRole('button', { name: '结束团队' }))
      await waitFor(() => expect(rejectEnd).toBeDefined())
      await act(async () => finishRead({ job, text: 'STALE LEAD OUTPUT', nextOffset: 17, totalCharacters: 17 }))
      expect(screen.queryByText('STALE LEAD OUTPUT')).not.toBeInTheDocument()
      await act(async () => rejectEnd(new Error('fixture failed end')))
      fireEvent.click(await screen.findByRole('button', { name: '展开 组长 · explore 详情' }))
      expect(screen.queryByText('STALE LEAD OUTPUT')).not.toBeInTheDocument()
    } finally { view.unmount() }
  })

  it('offline stale lead list cannot revive after switching scope away and back with the same ids', async () => {
    const a = 'runtime-flow', b = 'jobs-other-scope'
    const lead: ChatSession = { id: 'same-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'same-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.scopedTestSessions.value = { [a]: [lead, member], [b]: [lead, member] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    for (const scope of [a, b]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), member.id)
    const routeA = { channel: 'canvas', scopeType: 'thread', scopeId: 'project-a', threadId: 'pane-a' } as const
    const routeB = { channel: 'canvas', scopeType: 'thread', scopeId: 'project-b', threadId: 'pane-b' } as const
    const job = (id: string) => ({ id, kind: 'explore', task: id, status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 })
    let oldList!: (value: unknown) => void
    let aLeadCalls = 0
    hoisted.listAgentJobsMock.mockImplementation(({ route, conversationId }: { route: typeof routeA; conversationId: string }) => {
      if (conversationId !== lead.id) return Promise.resolve({ jobs: [] })
      if (route.scopeId === routeA.scopeId && ++aLeadCalls === 1) return new Promise(resolve => { oldList = resolve })
      return Promise.resolve({ jobs: [job(route.scopeId === routeA.scopeId ? 'fresh-a' : 'fresh-b')] })
    })
    const page = renderWithProviders(<ChatPage compact storageScope={a} route={routeA} />)
    try {
      await waitFor(() => expect(oldList).toBeDefined())
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={b} route={routeB} /></ThemeProvider></MemoryRouter>)
      fireEvent.click(await screen.findByRole('button', { name: '展开 组长 · explore 详情' }))
      expect(await screen.findByText('explore: fresh-b')).toBeVisible()
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={a} route={routeA} /></ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(aLeadCalls).toBeGreaterThanOrEqual(2))
      fireEvent.click(await screen.findByRole('button', { name: '展开 组长 · explore 详情' }))
      expect(await screen.findByText('explore: fresh-a')).toBeVisible()
      await act(async () => oldList({ jobs: [job('stale-a')] }))
      expect(screen.queryByText('explore: stale-a')).not.toBeInTheDocument()
      expect(screen.getByText('explore: fresh-a')).toBeVisible()
    } finally { page.unmount() }
  })

  it.each(['text-delta', 'tool-status'] as const)('does not apply an old scope stream %s to a different scope with the same session id', async (kind) => {
    const a = 'scope-stream-a', b = 'scope-stream-b', sessionId = 'same-stream-id'
    const sessionA: ChatSession = { id: sessionId, title: 'Scope A', profileId: 'base-model', messages: [] }
    const sessionB: ChatSession = { id: sessionId, title: 'Scope B', profileId: 'base-model', messages: [
      { role: 'user', content: 'B question' }, { role: 'assistant', content: 'B answer' }
    ] }
    hoisted.scopedTestSessions.value = { [a]: [sessionA], [b]: [sessionB] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    for (const scope of [a, b]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), sessionId)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let oldRequest!: { onEvent: (event: unknown) => void; signal: AbortSignal }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce((request) => { oldRequest = request; return new Promise(resolve => { finish = resolve }) })
    const ui = (scope: string) => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} /></ThemeProvider></MemoryRouter>
    const page = render(ui(a))
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Scope A'))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'A pending request' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(oldRequest).toBeDefined())
      page.rerender(ui(b))
      expect(oldRequest.signal.aborted).toBe(true)
      expect(readScopedActiveLoadingSessionIds(a)).not.toContain(sessionId)
      expect(readScopedChatRun(a, sessionId).status).toBe('interrupted')
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Scope B'))
      const tool = { runId: 'old-scope-run', toolCallId: 'old-scope-call', toolName: 'files.write', args: { path: 'OLD_SCOPE_TOOL' }, status: 'running' as const }
      await act(async () => oldRequest.onEvent(kind === 'text-delta'
        ? { type: 'text-delta', delta: 'OLD_SCOPE_TEXT' }
        : { type: 'tool-status', toolStatus: tool, toolHistory: [tool] }))
      expect(readCurrentSessionState()?.messages.at(-1)).toEqual({ role: 'assistant', content: 'B answer' })
      expect(JSON.stringify(hoisted.scopedTestSessions.value?.[b])).not.toContain('OLD_SCOPE_')
    } finally {
      page.unmount()
      if (finish) await act(async () => finish({ result: { content: 'old complete' }, response: 'old complete' }))
    }
  })

  it('pauses a composer queue across A-B-A without auto-sending, and requires editing to restore it', async () => {
    const a = 'scope-owner-a', b = 'scope-owner-b', sessionId = 'scope-owner-same-id'
    const makeSession = (title: string): ChatSession => ({ id: sessionId, title, profileId: 'base-model', messages: [] })
    hoisted.scopedTestSessions.value = { [a]: [makeSession('Owner A')], [b]: [makeSession('Owner B')] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    for (const scope of [a, b]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), sessionId)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    const requests: Array<{ onEvent: (event: unknown) => void; signal: AbortSignal }> = []
    const finishes: Array<(value: unknown) => void> = []
    hoisted.requestChatCompletionStreamMock.mockImplementation((input: typeof requests[number]) => { requests.push(input); return new Promise(resolve => { finishes.push(resolve) }) })
    const ui = (scope: string) => <React.StrictMode><MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} /></ThemeProvider></MemoryRouter></React.StrictMode>
    const send = (text: string) => { fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock')) }
    const page = render(ui(a))
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Owner A'))
      send('old A request')
      await waitFor(() => expect(requests).toHaveLength(1))
      send('old A queued')
      expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('old A queued')
      expect(requests).toHaveLength(1)
      page.rerender(ui(b))
      expect(requests[0].signal.aborted).toBe(true)
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Owner B'))
      expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument()
      send('new B request')
      await waitFor(() => expect(requests).toHaveLength(2))
      await act(async () => requests[1].onEvent({ type: 'text-delta', delta: 'B live' }))
      expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('B live')
      page.rerender(ui(a))
      expect(requests[1].signal.aborted).toBe(true)
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('old A request'))
      expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('old A queued')
      expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('未发送 · 已暂停')
      expect(requests).toHaveLength(2)
      send('new A request')
      await waitFor(() => expect(requests).toHaveLength(3))
      await act(async () => {
        requests[0].onEvent({ type: 'text-delta', delta: 'STALE_A_TEXT' })
        requests[1].onEvent({ type: 'text-delta', delta: 'STALE_B_TEXT' })
        finishes[0]({ result: { content: 'STALE_A_FINAL' }, response: 'STALE_A_FINAL' })
        finishes[1]({ result: { content: 'STALE_B_FINAL' }, response: 'STALE_B_FINAL' })
      })
      expect(requests).toHaveLength(3)
      expect(requests[2].signal.aborted).toBe(false)
      expect(readScopedActiveLoadingSessionIds(a)).toContain(sessionId)
      expect(JSON.stringify(readCurrentSessionState())).not.toContain('STALE_')
      expect(JSON.stringify(hoisted.scopedTestSessions.value?.[b])).not.toContain('STALE_')
      await act(async () => { requests[2].onEvent({ type: 'text-delta', delta: 'new A live' }); finishes[2]({ result: { content: 'new A final' }, response: 'new A final' }) })
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new A final'))
      expect(requests).toHaveLength(3)
      expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('old A queued')
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'new unsent draft' } })
      fireEvent.click(within(screen.getByTestId('chat-queue-panel')).getByRole('button', { name: 'chat.queue_edit' }))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('new unsent draft')
      expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('old A queued')
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '' } })
      fireEvent.click(within(screen.getByTestId('chat-queue-panel')).getByRole('button', { name: 'chat.queue_edit' }))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('old A queued')
      expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument()
      expect(requests).toHaveLength(3)
    } finally {
      for (const finish of finishes) finish({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('does not retire a live scope run for an uncommitted suspended scope render', async () => {
    const a = 'scope-suspended-a', b = 'scope-suspended-b', sessionId = 'scope-suspended-id'
    const session: ChatSession = { id: sessionId, title: 'Suspended A', profileId: 'base-model', messages: [] }
    hoisted.scopedTestSessions.value = { [a]: [session], [b]: [{ ...session, title: 'Suspended B' }] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, a), sessionId)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let request!: { onEvent: (event: unknown) => void; signal: AbortSignal }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => { request = input; return new Promise(resolve => { finish = resolve }) })
    const attempted = vi.fn(), never = new Promise<void>(() => {})
    function Blocker({ pending }: { pending: boolean }) { if (pending) { attempted(); throw never } return null }
    const ui = (pending: boolean) => <React.StrictMode><MemoryRouter><ThemeProvider theme={theme}><React.Suspense fallback={<div>pending scope</div>}><ChatPage compact storageScope={pending ? b : a} /><Blocker pending={pending} /></React.Suspense></ThemeProvider></MemoryRouter></React.StrictMode>
    const page = render(ui(false))
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Suspended A'))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'current scope question' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(request).toBeDefined())
      await act(async () => { React.startTransition(() => page.rerender(ui(true))) })
      expect(attempted).toHaveBeenCalled()
      expect(screen.queryByText('pending scope')).not.toBeInTheDocument()
      expect(request.signal.aborted).toBe(false)
      await act(async () => request.onEvent({ type: 'text-delta', delta: 'still A' }))
      expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('still A')
      await act(async () => finish({ result: { content: 'A final' }, response: 'A final' }))
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('A final'))
    } finally {
      if (finish) finish({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('offline helper stream displays only invocation metadata and fences late events after stop', async () => {
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let request!: { onEvent: (event: unknown) => void }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementation((input: typeof request) => { request = input; return new Promise(resolve => { finish = resolve }) })
    const view = renderChatPage()
    const names = ['explore', 'critic', 'fork', 'response', 'summarize']
    const emit = (name: string, status: string) => request.onEvent({ type: 'tool-status', toolStatus: { runId: 'fixture-run', toolCallId: `call-${name}`, toolName: name, status, args: { secret: 'SECRET_ARGUMENT' }, content: 'SECRET_HISTORY' } })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'run helper fixture' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(request).toBeDefined())
      await act(async () => { for (const name of names) emit(name, 'running'); emit('not_allowed', 'running') })
      const area = await screen.findByRole('region', { name: '进程区' })
      for (const name of names) expect(within(area).getByText(name)).toBeVisible()
      expect(within(area).getAllByText('调用中')).toHaveLength(5)
      expect(area).not.toHaveTextContent('SECRET_ARGUMENT')
      expect(area).not.toHaveTextContent('SECRET_HISTORY')
      expect(area).not.toHaveTextContent('not_allowed')
      for (const name of names) expect(within(area).queryByRole('button', { name: `停止 ${name}` })).not.toBeInTheDocument()
      await act(async () => emit('explore', 'completed'))
      expect(within(area).getByText('调用已返回')).toBeVisible()
      fireEvent.click(screen.getByTestId('chat-composer-stop-mock'))
      await waitFor(() => expect(within(area).getAllByText('状态未知')).toHaveLength(4))
      await act(async () => { emit('critic', 'completed'); finish({ result: { content: 'late' }, response: 'late' }) })
      expect(within(area).getAllByText('状态未知')).toHaveLength(4)
      expect(within(area).getAllByText('调用已返回')).toHaveLength(1)
      expect(area).not.toHaveTextContent('SECRET_ARGUMENT')
    } finally { view.unmount() }
  })

  it('offline helper stream becomes unknown on same-scope reload without aborting its parent', async () => {
    const session: ChatSession = { id: 'helper-reload', title: 'Reload', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let request!: { onEvent: (event: unknown) => void; signal: AbortSignal }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementation((input: typeof request) => { request = input; return new Promise(resolve => { finish = resolve }) })
    const page = renderChatPage()
    const originalNotify = hoisted.notifyErrorMock
    const event = (status: string) => ({ type: 'tool-status', toolStatus: { runId: 'reload-run', toolCallId: 'reload-call', toolName: 'explore', status } })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'fixture request' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(request).toBeDefined())
      await act(async () => request.onEvent(event('running')))
      expect(within(await screen.findByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      let reloadStarted = false
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => { reloadStarted = true; return cloneValue(hoisted.storedSessions.value) })
      hoisted.notifyErrorMock = vi.fn()
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(reloadStarted).toBe(true))
      await waitFor(() => expect(within(screen.getByRole('region', { name: '进程区' })).getByText('状态未知')).toBeVisible())
      expect(request.signal.aborted).toBe(false)
      await act(async () => request.onEvent(event('completed')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('状态未知')).toBeVisible()
      expect(screen.queryByText('调用已返回')).not.toBeInTheDocument()
      expect(request.signal.aborted).toBe(false)
      await act(async () => finish({ result: { content: 'done' }, response: 'done' }))
    } finally {
      hoisted.notifyErrorMock = originalNotify
      page.unmount()
    }
  })

  it.fails('P6 pending: abort-ignoring stream mock blocks a second send before old promise settles', async () => {
    const session: ChatSession = { id: 'strict-helper-session', title: 'Helper', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    const requests: Array<{ onEvent: (event: unknown) => void; signal: AbortSignal }> = []
    const finishes: Array<(value: unknown) => void> = []
    hoisted.requestChatCompletionStreamMock.mockImplementation((input: typeof requests[number]) => { requests.push(input); return new Promise(resolve => { finishes.push(resolve) }) })
    const ui = () => <React.StrictMode><MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter></React.StrictMode>
    const page = render(ui())
    const originalNotify = hoisted.notifyErrorMock
    const event = (status: string) => ({ type: 'tool-status', toolStatus: { runId: 'same-run', toolCallId: 'same-call', toolName: 'explore', status } })
    const send = (text: string) => { fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock')) }
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      send('first fixture')
      await waitFor(() => expect(requests).toHaveLength(1))
      await act(async () => requests[0].onEvent(event('running')))
      expect(within(await screen.findByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      let reloaded = false
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => { reloaded = true; return cloneValue(hoisted.storedSessions.value) })
      hoisted.notifyErrorMock = vi.fn()
      page.rerender(ui())
      await waitFor(() => expect(reloaded).toBe(true))
      await waitFor(() => expect(within(screen.getByRole('region', { name: '进程区' })).getByText('状态未知')).toBeVisible())
      expect(requests[0].signal.aborted).toBe(false)
      fireEvent.click(screen.getByTestId('chat-composer-stop-mock'))
      await waitFor(() => expect(requests[0].signal.aborted).toBe(true))
      send('second fixture')
      await waitFor(() => expect(requests).toHaveLength(2))
      await act(async () => requests[1].onEvent(event('running')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      await act(async () => { requests[0].onEvent(event('completed')); finishes[0]({ result: { content: 'old' }, response: 'old' }) })
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      await act(async () => requests[1].onEvent(event('completed')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用已返回')).toBeVisible()
      await act(async () => finishes[1]({ result: { content: 'new' }, response: 'new' }))
    } finally {
      for (const finish of finishes) finish({ result: { content: 'cleanup' }, response: 'cleanup' })
      hoisted.notifyErrorMock = originalNotify
      page.unmount()
    }
  })

  it('strict helper ignores old same-id events after stop and settled old request', async () => {
    const session: ChatSession = { id: 'strict-helper-settled', title: 'Helper', messages: [], profileId: 'base-model' }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    const requests: Array<{ onEvent: (event: unknown) => void; signal: AbortSignal }> = []
    const finishes: Array<(value: unknown) => void> = []
    hoisted.requestChatCompletionStreamMock.mockImplementation((input: typeof requests[number]) => { requests.push(input); return new Promise(resolve => { finishes.push(resolve) }) })
    const page = render(<React.StrictMode><MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter></React.StrictMode>)
    const event = (status: string) => ({ type: 'tool-status', toolStatus: { runId: 'same-run', toolCallId: 'same-call', toolName: 'explore', status } })
    const send = (text: string) => { fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock')) }
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      send('first fixture')
      await waitFor(() => expect(requests).toHaveLength(1))
      await act(async () => requests[0].onEvent(event('running')))
      expect(within(await screen.findByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      fireEvent.click(screen.getByTestId('chat-composer-stop-mock'))
      await waitFor(() => expect(requests[0].signal.aborted).toBe(true))
      await act(async () => finishes[0]({ result: { content: 'old' }, response: 'old' }))
      await waitFor(() => expect(screen.queryByTestId('chat-composer-stop-mock')).not.toBeInTheDocument())
      send('second fixture')
      await waitFor(() => expect(requests).toHaveLength(2))
      await act(async () => requests[1].onEvent(event('running')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      await act(async () => requests[0].onEvent(event('completed')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用中')).toBeVisible()
      await act(async () => requests[1].onEvent(event('completed')))
      expect(within(screen.getByRole('region', { name: '进程区' })).getByText('调用已返回')).toBeVisible()
      await act(async () => finishes[1]({ result: { content: 'new' }, response: 'new' }))
    } finally {
      for (const finish of finishes) finish({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it.each(['member', 'lead'] as const)('strict lead polling survives reload and activation from %s entry', async (entry) => {
    const lead: ChatSession = { id: 'strict-poll-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'strict-poll-member', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'runtime-project', threadId: 'runtime-pane' } as const
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), entry === 'member' ? member.id : lead.id)
    const calls: Array<{ route: typeof route; conversationId: string }> = []
    let holdNext: 'reload' | 'inactive' | null = null
    let releaseOld: ((value: unknown) => void) | undefined
    let releaseInactive: ((value: unknown) => void) | undefined
    const job = (id: string) => ({ id, kind: 'explore', task: id, status: 'running', createdAt: Date.now(), expiresAt: Date.now() + 60000 })
    hoisted.listAgentJobsMock.mockImplementation((args: { route: typeof route; conversationId: string }) => {
      calls.push(args)
      if (args.conversationId === lead.id && holdNext) {
        const phase = holdNext
        holdNext = null
        return new Promise(resolve => { if (phase === 'reload') releaseOld = resolve; else releaseInactive = resolve })
      }
      return Promise.resolve({ jobs: args.conversationId === lead.id ? [job('strict-fresh')] : [] })
    })
    const ui = (active: boolean) => <React.StrictMode><MemoryRouter><ThemeProvider theme={theme}><ChatPage compact active={active} storageScope="runtime-flow" route={route} /></ThemeProvider></MemoryRouter></React.StrictMode>
    const page = render(ui(true))
    const originalNotify = hoisted.notifyErrorMock
    const leadCalls = () => calls.filter(call => call.conversationId === lead.id)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(entry === 'member' ? member.id : lead.id))
      if (entry === 'lead') {
        fireEvent.click(await screen.findByRole('button', { name: '打开 Alice' }))
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      }
      await waitFor(() => expect(leadCalls().length).toBeGreaterThan(0))
      expect(leadCalls()[0]).toEqual({ route, conversationId: lead.id })
      const firstCount = leadCalls().length
      await waitFor(() => expect(leadCalls().length).toBeGreaterThan(firstCount), { timeout: 2500 })
      expect(leadCalls().at(-1)).toEqual({ route, conversationId: lead.id })
      holdNext = 'reload'
      await waitFor(() => expect(releaseOld).toBeDefined(), { timeout: 2500 })
      let reloadStarted = false
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => { reloadStarted = true; return cloneValue(hoisted.storedSessions.value) })
      const beforeReload = leadCalls().length
      hoisted.notifyErrorMock = vi.fn()
      page.rerender(ui(true))
      await waitFor(() => expect(reloadStarted).toBe(true))
      await waitFor(() => expect(leadCalls().length).toBeGreaterThan(beforeReload), { timeout: 2500 })
      expect(leadCalls().at(-1)).toEqual({ route, conversationId: lead.id })
      fireEvent.click(await screen.findByRole('button', { name: '展开 组长 · explore 详情' }))
      expect(await screen.findByText('explore: strict-fresh')).toBeVisible()
      await act(async () => releaseOld!({ jobs: [job('strict-stale')] }))
      expect(screen.queryByText('explore: strict-stale')).not.toBeInTheDocument()
      expect(screen.getByText('explore: strict-fresh')).toBeVisible()
      holdNext = 'inactive'
      await waitFor(() => expect(releaseInactive).toBeDefined(), { timeout: 2500 })
      expect(leadCalls().at(-1)).toEqual({ route, conversationId: lead.id })
      page.rerender(ui(false))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)) })
      const inactiveCount = leadCalls().length
      await act(async () => releaseInactive!({ jobs: [job('stale-inactive')] }))
      expect(screen.queryByText('explore: stale-inactive')).not.toBeInTheDocument()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1200)) })
      expect(leadCalls()).toHaveLength(inactiveCount)
      page.rerender(ui(true))
      await waitFor(() => expect(leadCalls().length).toBeGreaterThan(inactiveCount), { timeout: 2500 })
      expect(leadCalls().at(-1)).toEqual({ route, conversationId: lead.id })
      expect(await screen.findByRole('button', { name: '展开 组长 · explore 详情' })).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: '展开 组长 · explore 详情' }))
      expect(await screen.findByText('explore: strict-fresh')).toBeVisible()
      expect(screen.queryByText('explore: stale-inactive')).not.toBeInTheDocument()
      const activeCount = leadCalls().length
      await waitFor(() => expect(leadCalls().length).toBeGreaterThan(activeCount), { timeout: 2500 })
      expect(leadCalls().at(-1)).toEqual({ route, conversationId: lead.id })
      for (const call of leadCalls()) expect(call).toEqual({ route, conversationId: lead.id })
    } finally {
      releaseOld?.({ jobs: [] })
      releaseInactive?.({ jobs: [] })
      hoisted.notifyErrorMock = originalNotify
      page.unmount()
    }
  }, 15000)

  it('keeps a user-entered local file path as plain message text without choosing or reading a local file', async () => {
    const route = {
      channel: 'canvas' as const,
      scopeType: 'thread' as const,
      scopeId: 'path-project',
      threadId: 'path-pane'
    }
    const filePath = 'C:/Users/tester/notes/launch.txt'
    renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    expect(screen.queryByRole('region', { name: 'Local files' })).not.toBeInTheDocument()
    expect(hoisted.agentLocalFilesService.setScope).not.toHaveBeenCalled()
    expect(hoisted.agentLocalFilesService.choose).not.toHaveBeenCalled()
    expect(hoisted.agentLocalFilesService.read).not.toHaveBeenCalled()

    const input = screen.getByTestId('chat-composer-input-mock')
    fireEvent.change(input, { target: { value: filePath } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const request = hoisted.requestChatCompletionMock.mock.calls[0][0] as {
      messages: ChatMessage[]
    }
    expect(request.messages.filter((message) => message.role === 'user').at(-1)?.content).toBe(
      filePath
    )
    expect(hoisted.agentLocalFilesService.choose).not.toHaveBeenCalled()
    expect(hoisted.agentLocalFilesService.read).not.toHaveBeenCalled()
  })

  describe('canvas chat uses messages instead of a persistent file form', () => {
    it.each([true, false])(
      'has no local-file form before, during, or after a path request (compact=%s)',
      async (compact) => {
        const route = {
          channel: 'canvas' as const,
          scopeType: 'thread' as const,
          scopeId: 'message-path-project',
          threadId: 'message-path-pane'
        }
        let finish!: (value: { content: string }) => void
        hoisted.requestChatCompletionMock.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve
            })
        )
        renderWithProviders(
          <ChatPage compact={compact} storageScope="runtime-flow" route={route} />
        )
        await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
        const assertNoForm = () => {
          expect(screen.queryByRole('region', { name: 'Local files' })).not.toBeInTheDocument()
          expect(screen.queryByRole('region', { name: 'Text preview' })).not.toBeInTheDocument()
          expect(screen.queryByRole('button', { name: 'Choose file' })).not.toBeInTheDocument()
          expect(screen.queryByRole('button', { name: 'Choose directory' })).not.toBeInTheDocument()
          expect(
            screen.queryByRole('button', { name: 'Use this text in the conversation' })
          ).not.toBeInTheDocument()
          expect(hoisted.agentLocalFilesService.setScope).not.toHaveBeenCalled()
          expect(hoisted.agentLocalFilesService.choose).not.toHaveBeenCalled()
          expect(hoisted.agentLocalFilesService.read).not.toHaveBeenCalled()
          expect(screen.getByTestId('chat-composer-input-mock')).toBeInTheDocument()
          expect(screen.getByTestId('chat-composer-upload-mock')).toBeInTheDocument()
        }
        assertNoForm()
        const text = String.raw`请读取 "D:\项目资料\设计 文档.txt" 并总结。`
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
          target: { value: text }
        })
        expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
        expect(hoisted.requestChatCompletionMock.mock.calls[0][0].messages.at(-1).content).toBe(
          text
        )
        assertNoForm()
        await act(async () => finish({ content: 'request handled by agent tools' }))
        await waitFor(() =>
          expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe(
            'request handled by agent tools'
          )
        )
        assertNoForm()
      }
    )
  })

  it('keeps the chat composer without a diagnostics panel or entry', async () => {
    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    expect(screen.getByTestId('chat-composer-input-mock')).toBeInTheDocument()
    expect(screen.getByTestId('chat-composer-send-mock')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', {
        name: /诊断与调用记录|Diagnostics and receipts|chat\.agent_diagnostics\.open/i
      })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('dialog', { name: /当前线程诊断|Current thread diagnostics/i })
    ).not.toBeInTheDocument()
  })

  it('restores the last selected model when bootstrapping the initial session', async () => {
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'),
      'vision-model'
    )

    renderChatPage()

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('recovers from an initial storage read failure through the real Retry button', async () => {
    const session: ChatSession = { id: 'initial-retry', title: 'Retry', profileId: 'base-model', messages: [{ role: 'user', content: 'retained after retry' }], createdAt: 299 }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.loadAllSessionsMock.mockRejectedValueOnce(new Error('temporary read failure'))
    renderChatPage()
    expect(await screen.findByText(/Failed to load chat sessions: temporary read failure/)).toBeVisible()
    expect(readCurrentSessionState()?.messages.some(message => message.content === 'retained after retry')).not.toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    expect(readCurrentSessionState()?.messages.some(message => message.content === 'retained after retry')).toBe(true)
    expect(screen.queryByText(/Failed to load chat sessions: temporary read failure/)).not.toBeInTheDocument()
    expect(hoisted.storedSessions.value[0]?.messages).toEqual(session.messages)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('does not let a delayed storage refresh overwrite a newer in-memory response', async () => {
    const session: ChatSession = {
      id: 'storage-load-race',
      title: 'Storage load race',
      messages: [
        { role: 'user', content: 'run graph' },
        { role: 'assistant', content: '' }
      ],
      createdAt: 300
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))

    let releaseRefresh!: (sessions: ChatSession[]) => void
    hoisted.loadAllSessionsMock.mockImplementationOnce(
      () =>
        new Promise<ChatSession[]>((resolve) => {
          releaseRefresh = resolve
        })
    )
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'runtime-flow', reason: 'storage-updated' }
        })
      )
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:append-message', {
          detail: {
            scope: 'runtime-flow',
            sessionId: session.id,
            role: 'assistant',
            content: 'new graph output'
          }
        })
      )
    })
    await waitFor(() =>
      expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new graph output')
    )

    await act(async () => {
      releaseRefresh([session])
    })

    expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new graph output')
  })

  it('keeps a confirmed draft and recovers through Retry when the same-scope initial reload read is stale', async () => {
    const session: ChatSession = {
      id: 'initial-read-draft-ack', title: 'Draft reload race', profileId: 'base-model',
      messages: [{ role: 'user', content: 'existing history' }], createdAt: 299
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const page = renderChatPage()
    let releaseSave!: () => void
    let releaseRead!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'confirmed draft' } })
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { releaseSave = resolve })
      await act(async () => { window.dispatchEvent(new Event('blur')) })
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      expect(hoisted.storedSessions.value[0]?.draft?.inputValue).not.toBe('confirmed draft')

      let readStarted = false
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => {
        const snapshot = cloneValue(hoisted.storedSessions.value)
        readStarted = true
        await new Promise<void>(resolve => { releaseRead = resolve })
        return snapshot
      })
      // A real initial-load effect can rerun within the same scope when a dependency changes.
      // Keep the same component instance and vary only the notification callback identity.
      const originalNotify = hoisted.notifyErrorMock
      hoisted.notifyErrorMock = vi.fn()
      try {
        page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter>)
        await waitFor(() => expect(readStarted).toBe(true))
        await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSave() })
        await waitFor(() => expect(hoisted.storedSessions.value[0]?.draft?.inputValue).toBe('confirmed draft'))
        await act(async () => releaseRead())
        expect(await screen.findByRole('alert')).toHaveTextContent('Chat changed while loading')
        expect(readCurrentSessionState()?.draft?.inputValue).toBe('confirmed draft')
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
        expect(readCurrentSessionState()?.draft?.inputValue).toBe('confirmed draft')
        expect(hoisted.storedSessions.value[0]?.draft?.inputValue).toBe('confirmed draft')
      } finally {
        hoisted.notifyErrorMock = originalNotify
      }
    } finally {
      releaseRead?.(); releaseSave?.()
      hoisted.saveSessionToDBGate.value = null
      page.unmount()
    }
  })

  it('preserves a confirmed reply when an old refresh returns during a same-session pending save', async () => {
    const session: ChatSession = {
      id: 'refresh-confirmed-reply-race', title: 'Refresh race', profileId: 'base-model',
      messages: [{ role: 'user', content: 'initial' }], createdAt: 300
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))

    let releaseRefresh!: () => void
    let releaseFirstSave!: () => void
    let releaseSecondSave!: () => void
    let snapshotRead = false
    hoisted.latestSaveCallback.value = null
    const successCount = hoisted.saveSuccessCount.value
    hoisted.saveSessionToDBGateStarted.value = null
    hoisted.saveSessionToDBGate.value = new Promise<void>((resolve) => { releaseFirstSave = resolve })
    const append = async (content: string) => act(async () => window.dispatchEvent(
      new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content }
      })
    ))
    try {
      await append('confirmed reply v1')
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      expect(hoisted.storedSessions.value[0]?.messages.some(m => m.content === 'confirmed reply v1')).toBe(false)
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => {
        const snapshot = cloneValue(hoisted.storedSessions.value)
        snapshotRead = true
        await new Promise<void>((resolve) => { releaseRefresh = resolve })
        return snapshot
      })
      await act(async () => window.dispatchEvent(new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'runtime-flow', reason: 'storage-updated' }
      })))
      await waitFor(() => expect(snapshotRead).toBe(true))
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseFirstSave() })
      await waitFor(() => expect(hoisted.saveSuccessCount.value).toBeGreaterThan(successCount))
      expect(hoisted.storedSessions.value[0]?.messages.some(m => m.content === 'confirmed reply v1')).toBe(true)
      expect(hoisted.latestSaveCallback.value).not.toBeNull()
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>((resolve) => { releaseSecondSave = resolve })
      // Simulate another already-registered debounce callback without mutating sessions.
      const pending = hoisted.latestSaveCallback.value!(session.id, 'runtime-flow').catch(() => null)
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      await act(async () => releaseRefresh())
      expect(readCurrentSessionState()?.messages.some(m => m.content === 'confirmed reply v1')).toBe(true)
      await append('later edit')
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSecondSave(); await pending })
      await waitFor(() => expect(hoisted.storedSessions.value[0]?.messages.some(m => m.content === 'later edit')).toBe(true))
      expect(hoisted.storedSessions.value[0]?.messages.some(m => m.content === 'confirmed reply v1')).toBe(true)
    } finally {
      releaseRefresh?.()
      releaseFirstSave?.()
      releaseSecondSave?.()
      hoisted.saveSessionToDBGate.value = null
    }
  })

  it('rejects a frozen refresh when a same-session save commits before its delayed batch callback', async () => {
    const session: ChatSession = {
      id: 'refresh-ack-before-callback', title: 'Ack ordering', profileId: 'base-model',
      messages: [{ role: 'user', content: 'initial' }], createdAt: 301
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const page = renderChatPage()
    let releaseSave!: () => void
    let releaseRead!: () => void
    let releaseCallback!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { releaseSave = resolve })
      hoisted.saveCallbackGate.value = new Promise<void>(resolve => { releaseCallback = resolve })
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'confirmed before callback' }
      })))
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      let readStarted = false
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => {
        const snapshot = cloneValue(hoisted.storedSessions.value)
        readStarted = true
        await new Promise<void>(resolve => { releaseRead = resolve })
        return snapshot
      })
      await act(async () => window.dispatchEvent(new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'runtime-flow', reason: 'storage-updated' }
      })))
      await waitFor(() => expect(readStarted).toBe(true))
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSave() })
      await waitFor(() => expect(hoisted.saveCallbackGateStarted.value).toBe(session.id))
      expect(hoisted.saveSuccessCount.value).toBe(0)
      expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'confirmed before callback')).toBe(true)
      // A second same-key write keeps adoptLoaded from rebasing while the v0 read is pending.
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { releaseSave = resolve })
      const pending = hoisted.latestSaveCallback.value!(session.id, 'runtime-flow').catch(() => null)
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      await act(async () => releaseRead())
      expect(readCurrentSessionState()?.messages.some(message => message.content === 'confirmed before callback')).toBe(true)
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'later edit' }
      })))
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSave(); await pending })
      await act(async () => { hoisted.saveCallbackGate.value = null; releaseCallback() })
      await waitFor(() => expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'later edit')).toBe(true))
      expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'confirmed before callback')).toBe(true)
    } finally {
      releaseSave?.(); releaseRead?.(); releaseCallback?.()
      hoisted.saveSessionToDBGate.value = null
      hoisted.saveCallbackGate.value = null
      page.unmount()
    }
  })

  it('re-roots legacy chat media URLs on load and persists the migrated session', async () => {
    const session: ChatSession = {
      id: 'legacy-chat-media-session',
      title: 'Legacy chat media',
      compactedMessages: [{ role: 'user', content: 'Retained original with legacy image.', attachments: [{ type: 'image', url: 'file:///C:/OldMagicPot/Data/.chat_media/retained/old%20original.png' }] }],
      messages: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              type: 'image',
              url: 'file:///C:/OldMagicPot/Data/.chat_media/assistant-images/old%20image.png'
            }
          ]
        }
      ],
      contextCompression: {
        summary: 'Compacted image context.',
        coveredMessageCount: 1,
        sourceHash: 'legacy-replay-source',
        estimatedSourceTokens: 100,
        estimatedSummaryTokens: 10,
        updatedAt: 300,
        replayImageMessages: [
          {
            role: 'user',
            content: 'Historical image replay.',
            attachments: [
              {
                type: 'image',
                url: 'file:///C:/OldMagicPot/Data/.chat_media/replay/old%20replay.png'
              }
            ]
          }
        ]
      },
      createdAt: 300
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()

    const expectedUrl =
      'local-media:///C:/MagicPot/Data/.chat_media/assistant-images/old%20image.png'
    const expectedReplayUrl = 'local-media:///C:/MagicPot/Data/.chat_media/replay/old%20replay.png'
    const expectedRetainedUrl = 'local-media:///C:/MagicPot/Data/.chat_media/retained/old%20original.png'
    await waitFor(() => {
      expect(readCurrentSessionState()?.compactedMessages?.[0]?.attachments?.[0]?.url).toBe(expectedRetainedUrl)
      expect(readCurrentSessionState()?.messages[0]?.attachments?.[0]?.url).toBe(expectedUrl)
      expect(
        readCurrentSessionState()?.contextCompression?.replayImageMessages?.[0]?.attachments?.[0]
          ?.url
      ).toBe(expectedReplayUrl)
    })
    await waitFor(() => {
      expect(hoisted.storedSessions.value[0]?.compactedMessages?.[0]?.attachments?.[0]?.url).toBe(expectedRetainedUrl)
      expect(hoisted.storedSessions.value[0]?.messages[0]?.attachments?.[0]?.url).toBe(expectedUrl)
      expect(
        hoisted.storedSessions.value[0]?.contextCompression?.replayImageMessages?.[0]
          ?.attachments?.[0]?.url
      ).toBe(expectedReplayUrl)
    })
  })

  it('preserves external attachment and local edit with a conflict when legacy media migration is delayed', async () => {
    const session: ChatSession = {
      id: 'legacy-chat-media-edit-race',
      title: 'Legacy media edit race',
      messages: [{ role: 'user', content: 'before edit' }],
      createdAt: 300
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))

    const legacyStoredSession: ChatSession = {
      ...session,
      messages: [
        {
          ...session.messages[0],
          attachments: [
            {
              type: 'image',
              url: 'file:///C:/OldMagicPot/Data/.chat_media/assistant-images/old%20image.png'
            }
          ]
        }
      ]
    }
    hoisted.storedSessions.value = [legacyStoredSession]
    let releaseMigration!: () => void
    hoisted.migrationStarted.value = false
    hoisted.migrationCommitGate.value = new Promise<void>((resolve) => {
      releaseMigration = resolve
    })
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'runtime-flow', reason: 'storage-updated' }
        })
      )
    })
    await waitFor(() => expect(hoisted.migrationStarted.value).toBe(true))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:append-message', {
          detail: {
            scope: 'runtime-flow',
            sessionId: session.id,
            role: 'assistant',
            content: 'new local edit'
          }
        })
      )
    })
    await waitFor(() =>
      expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new local edit')
    )

    await act(async () => {
      releaseMigration()
      hoisted.migrationCommitGate.value = null
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(/session save conflict/i)
    expect(hoisted.storedSessions.value[0]?.messages[0]?.attachments).toEqual(legacyStoredSession.messages[0].attachments)
    expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'new local edit')).toBe(false)
    expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new local edit')
    // Retry must not replace the out-of-band attachment with the local draft or adopt it as a
    // new baseline. A failed retry retains the local edit and surfaces the conflict again.
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(hoisted.notifyErrorMock).toHaveBeenCalledWith(expect.stringMatching(/session save conflict/i)))
    expect(screen.getByRole('alert')).toHaveTextContent(/session save conflict/i)
    expect(hoisted.storedSessions.value[0]?.messages[0]?.attachments).toEqual(legacyStoredSession.messages[0].attachments)
    expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'new local edit')).toBe(false)
    expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('new local edit')
  })

  it('preserves existing attachments and local edit during single-window legacy media migration', async () => {
    const legacyUrl = 'file:///C:/OldMagicPot/Data/.chat_media/assistant-images/old%20image.png'
    const session: ChatSession = {
      id: 'legacy-single-window-edit-race', title: 'Single window race', profileId: 'base-model', createdAt: 300,
      messages: [{ role: 'user', content: 'before edit', attachments: [{ type: 'image', url: legacyUrl }] }]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.skipMigrationOnce.value = true
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    let releaseMigration!: () => void
    hoisted.migrationStarted.value = false
    hoisted.migrationCommitGate.value = new Promise<void>(resolve => { releaseMigration = resolve })
    try {
      await act(async () => window.dispatchEvent(new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'runtime-flow', reason: 'storage-updated' }
      })))
      await waitFor(() => expect(hoisted.migrationStarted.value).toBe(true))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'local single-window edit' }
      })))
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('local single-window edit'))
      await act(async () => { hoisted.migrationCommitGate.value = null; releaseMigration() })
      await waitFor(() => expect(hoisted.storedSessions.value[0]?.messages.some(m => m.content === 'local single-window edit')).toBe(true))
      expect(hoisted.storedSessions.value[0]?.messages[0]?.attachments).toEqual([
        expect.objectContaining({ type: 'image', url: legacyUrl })
      ])
    } finally {
      releaseMigration?.()
      hoisted.migrationCommitGate.value = null
    }
  })

  it('does not resurrect a session deleted while legacy media migration persistence is delayed', async () => {
    const deletedSession: ChatSession = {
      id: 'legacy-chat-media-delete-race',
      title: 'Legacy media delete race',
      messages: [{ role: 'user', content: 'delete me' }],
      createdAt: 300
    }
    const remainingSession: ChatSession = {
      id: 'legacy-chat-media-remaining',
      title: 'Remaining',
      messages: [{ role: 'user', content: 'keep me' }],
      createdAt: 200
    }
    hoisted.storedSessions.value = [deletedSession, remainingSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      deletedSession.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(deletedSession.id))

    hoisted.storedSessions.value = [
      {
        ...deletedSession,
        messages: [
          {
            ...deletedSession.messages[0],
            attachments: [
              {
                type: 'image',
                url: 'file:///C:/OldMagicPot/Data/.chat_media/assistant-images/old%20image.png'
              }
            ]
          }
        ]
      },
      remainingSession
    ]
    let releaseMigration!: () => void
    hoisted.migrationStarted.value = false
    hoisted.migrationCommitGate.value = new Promise<void>((resolve) => {
      releaseMigration = resolve
    })
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'runtime-flow', reason: 'storage-updated' }
        })
      )
    })
    await waitFor(() => expect(hoisted.migrationStarted.value).toBe(true))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:deleteSession', {
          detail: { scope: 'runtime-flow', sessionId: deletedSession.id }
        })
      )
    })
    await waitFor(() => expect(readCurrentSessionState()?.id).not.toBe(deletedSession.id))

    await act(async () => {
      releaseMigration()
      hoisted.migrationCommitGate.value = null
    })

    await waitFor(() =>
      expect(hoisted.storedSessions.value.some((item) => item.id === deletedSession.id)).toBe(false)
    )
    expect(readCurrentSessionState()?.id).not.toBe(deletedSession.id)
  })

  it('keeps the staged model-wait loading status after remounting the same Agent thread', async () => {
    const scope = 'runtime-flow-a'
    let resolveCompletion!: (value: { content: string }) => void
    hoisted.requestChatCompletionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCompletion = resolve
        })
    )

    const view = renderChatPage(scope)

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const input = screen.getByTestId('chat-composer-input-mock')
    await act(async () => {
      fireEvent.change(input, { target: { value: '12312312' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    })
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    await waitFor(() => {
      expect(readLatestMessageListProps().loadingStatus).toEqual(
        expect.objectContaining({
          label: '等待模型响应',
          step: 3,
          totalSteps: 4
        })
      )
    })

    const currentSessionId = readLatestMessageListProps().currentSession?.id
    expect(currentSessionId).toBeTruthy()
    expect(readLatestMessageListProps().isLoading).toBe(true)
    view.unmount()
    hoisted.chatMessageListMock.mockClear()

    renderChatPage(scope)

    await waitFor(() => {
      const latestProps = readLatestMessageListProps()
      expect(latestProps.currentSession?.id).toBe(currentSessionId)
      expect(latestProps.isLoading).toBe(true)
      expect(latestProps.loadingStatus).toEqual(
        expect.objectContaining({
          label: '等待模型响应',
          step: 3,
          totalSteps: 4
        })
      )
    })

    await act(async () => {
      resolveCompletion({ content: 'done' })
    })
  })

  it('reloads the current Agent thread body when preview refresh reports a storage update', async () => {
    const session: ChatSession = {
      id: 'storage-refresh-session',
      title: 'Storage refresh',
      messages: [{ role: 'user', content: 'before' }],
      createdAt: 300
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.messages[0]?.content).toBe('before'))

    hoisted.storedSessions.value = [
      {
        ...session,
        messages: [
          { role: 'user', content: 'before' },
          { role: 'assistant', content: 'after storage update' }
        ]
      }
    ]

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'runtime-flow', reason: 'storage-updated' }
        })
      )
    })

    await waitFor(() => {
      expect(readCurrentSessionState()?.messages).toEqual([
        { role: 'user', content: 'before' },
        { role: 'assistant', content: 'after storage update' }
      ])
    })
  })

  it('preserves the original baseline when a local placeholder wins a storage refresh merge', async () => {
    const old:ChatSession={id:'preserved-placeholder',title:'Old',profileId:'base-model',messages:[{role:'user',content:'old question'},{role:'assistant',content:'old reply'},{role:'assistant',content:''}]}
    hoisted.storedSessions.value=[old]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),old.id)
    renderChatPage()
    await waitFor(()=>expect(readCurrentSessionState()?.messages).toHaveLength(3))
    let release!:()=>void
    hoisted.debouncedSaveAllSessionsGate.value=new Promise(resolve=>{release=resolve})
    const replacement:ChatSession={...old,messages:[{role:'user',content:'remote replacement'}]}
    hoisted.storedSessions.value=[replacement]
    await act(async()=>window.dispatchEvent(new CustomEvent('chat:preview-refresh',{detail:{scope:'runtime-flow',reason:'storage-updated'}})))
    await waitFor(()=>expect(readCurrentSessionState()?.messages).toHaveLength(3))
    expect(hoisted.storedSessions.value[0].messages).toEqual(replacement.messages)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    // This UI test's deliberately simplistic debounce mock does not implement real CAS.
    // The actual old-baseline/no-overwrite assertion is exercised in chatSaveBaseline.test.
    hoisted.debouncedSaveAllSessionsGate.value=null
    void release
  })

  it('does not reload deleted sessions back into the body for preview-only refreshes', async () => {
    const deletedSession: ChatSession = {
      id: 'deleted-preview-only-session',
      title: 'Deleted preview only',
      messages: [{ role: 'user', content: 'delete me' }],
      createdAt: 300
    }
    const remainingSession: ChatSession = {
      id: 'remaining-preview-only-session',
      title: 'Remaining',
      messages: [{ role: 'user', content: 'keep me' }],
      createdAt: 200
    }
    hoisted.storedSessions.value = [deletedSession, remainingSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      deletedSession.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(deletedSession.id))

    const deletePromise = act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:deleteSession', {
          detail: { scope: 'runtime-flow', sessionId: deletedSession.id }
        })
      )
    })

    hoisted.storedSessions.value = [deletedSession, remainingSession]
    await deletePromise

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(remainingSession.id))
    expect(readCurrentSessionState()?.id).not.toBe(deletedSession.id)

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:preview-refresh', {
          detail: { scope: 'runtime-flow', reason: 'preview-only' }
        })
      )
    })

    expect(readCurrentSessionState()?.id).toBe(remainingSession.id)
  })

  it('does not rerender the message list synchronously while typing in the composer', async () => {
    // Flush this immediate-storage fixture's initial session/key synchronization
    // before measuring typing. Message-list session ID alone is not composer
    // passive-effect readiness; keep the synchronous typing assertions below.
    await act(async () => { renderChatPage() })

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    hoisted.chatMessageListMock.mockClear()
    const input = screen.getByTestId('chat-composer-input-mock')

    fireEvent.change(input, { target: { value: 'typing without list work' } })

    expect(input).toHaveValue('typing without list work')
    expect(hoisted.chatMessageListMock).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(hoisted.chatMessageListMock).toHaveBeenCalled()
    })
  })

  it('replays historical user images when the selected profile has no continuation support', async () => {
    const session: ChatSession = {
      id: 'no-continuation-image-replay',
      title: 'No continuation image replay',
      profileId: 'vision-model',
      sessionUrl: 'stale-session-url',
      messages: [
        {
          role: 'user',
          content: 'historical image',
          attachments: [
            {
              type: 'image',
              url: 'local-media:///historical.png',
              fileName: 'historical.png',
              mimeType: 'image/png'
            }
          ]
        },
        { role: 'assistant', content: 'historical answer' }
      ]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'continue without continuation' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const call = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as
      { messages?: ChatMessage[]; imageHistoryPolicy?: string; sessionUrl?: string } | undefined
    expect(call?.imageHistoryPolicy).toBe('all')
    expect(call?.sessionUrl).toBeUndefined()
    expect(call?.messages?.[0]?.attachments?.[0]?.url).toBe('local-media:///historical.png')
  })

  it('uses incremental image history only for an explicitly supported usable continuation', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-model',
        model_name: 'Continuation Model',
        model_use: 'chat' as const,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'supported-continuation-image-replay',
      title: 'Supported continuation image replay',
      profileId: 'continuation-model',
      sessionUrl: 'session-supported',
      sessionProfileId: 'continuation-model',
      sessionRouteFingerprint: 'local-continuation-model',
      messages: [
        {
          role: 'user',
          content: 'historical image',
          attachments: [
            {
              type: 'image',
              url: 'local-media:///historical.png',
              fileName: 'historical.png',
              mimeType: 'image/png'
            }
          ]
        },
        { role: 'assistant', content: 'historical answer' }
      ]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'continue incrementally' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const call = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as
      { messages?: ChatMessage[]; imageHistoryPolicy?: string; sessionUrl?: string } | undefined
    expect(call?.imageHistoryPolicy).toBe('latest-user-turn')
    expect(call?.sessionUrl).toBe('session-supported')
  })

  it('uses the forced request profile capability instead of the selected profile capability', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-selected',
        model_name: 'Continuation Selected',
        model_use: 'chat' as const,
        supports_session_continuation: true
      },
      {
        id: 'forced-stateless',
        model_name: 'Forced Stateless',
        model_use: 'vision' as const,
        is_vision_model: true
      }
    ]
    const session: ChatSession = {
      id: 'forced-profile-capability',
      title: 'Forced profile capability',
      profileId: 'continuation-selected',
      sessionUrl: 'selected-session-url',
      messages: [
        {
          role: 'user',
          content: 'historical image',
          attachments: [createImageAttachment('forced-history.png')]
        }
      ]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    await dispatchNewSession({
      profileId: 'forced-stateless',
      initialMessage: 'Use forced profile'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const call = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(call.profileId).toBe('forced-stateless')
    expect(call.sessionUrl).toBeUndefined()
    expect(call.imageHistoryPolicy).toBe('all')
  })

  it('clears a stored continuation immediately when the user switches profiles', async () => {
    const session: ChatSession = {
      id: 'profile-switch-continuation',
      title: 'Profile switch continuation',
      profileId: 'base-model',
      sessionUrl: 'base-session',
      sessionProfileId: 'base-model',
      messages: []
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.click(screen.getByTestId('select-vision-model'))

    await waitFor(() => {
      expect(readCurrentSessionState()?.profileId).toBe('vision-model')
      expect(readCurrentSessionState()?.sessionUrl).toBeUndefined()
      expect(readCurrentSessionState()?.sessionProfileId).toBeUndefined()
    })
  })

  it('rejects a continuation owned by a different profile', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-a',
        model_name: 'Continuation A',
        model_use: 'chat' as const,
        supports_session_continuation: true
      },
      {
        id: 'continuation-b',
        model_name: 'Continuation B',
        model_use: 'chat' as const,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'continuation-owner-mismatch',
      title: 'Continuation owner mismatch',
      profileId: 'continuation-b',
      sessionUrl: 'owned-by-a',
      sessionProfileId: 'continuation-a',
      messages: []
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'do not reuse foreign continuation' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].imageHistoryPolicy).toBe('all')
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBeUndefined())
  })

  it('carries a successful continuation across attachment chunks and consumes it only after success', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-vision-model',
        model_name: 'Continuation Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true,
        supports_session_continuation: true
      }
    ]
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(2)
    hoisted.requestChatCompletionMock
      .mockResolvedValueOnce({
        content:
          '<<<MAGICPOT_RESULT_1>>>first<<<END_MAGICPOT_RESULT_1>>>\n<<<MAGICPOT_RESULT_2>>>second<<<END_MAGICPOT_RESULT_2>>>',
        sessionUrl: 'session-after-first-chunk'
      })
      .mockResolvedValueOnce({ content: 'third', sessionUrl: 'session-after-second-chunk' })

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await dispatchNewSession({
      skillId: BUILT_IN_TAGGING_SKILL_ID,
      profileId: 'continuation-vision-model',
      initialMessage: 'Tag each image',
      initialAttachments: [
        createImageAttachment('chunk-1.png'),
        createImageAttachment('chunk-2.png'),
        createImageAttachment('chunk-3.png')
      ]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].imageHistoryPolicy).toBe('all')
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].sessionUrl).toBe(
      'session-after-first-chunk'
    )
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].imageHistoryPolicy).toBe(
      'latest-user-turn'
    )
    await waitFor(() =>
      expect(readCurrentSessionState()?.sessionUrl).toBe('session-after-second-chunk')
    )
  })

  it('retries a definitive expired continuation once with all historical images', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-model',
        model_name: 'Continuation Model',
        model_use: 'vision' as const,
        is_vision_model: true,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'expired-continuation',
      title: 'Expired continuation',
      profileId: 'continuation-model',
      sessionUrl: 'expired-session',
      sessionProfileId: 'continuation-model',
      sessionRouteFingerprint: 'local-continuation-model',
      messages: [
        {
          role: 'user',
          content: 'historical image',
          attachments: [createImageAttachment('expired-history.png')]
        }
      ]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    hoisted.requestChatCompletionMock
      .mockRejectedValueOnce(createExpiredContinuationError())
      .mockResolvedValueOnce({ content: 'recovered' })

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'recover continuation' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].sessionUrl).toBe('expired-session')
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].imageHistoryPolicy).toBe(
      'latest-user-turn'
    )
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].imageHistoryPolicy).toBe('all')
    expect(
      (hoisted.requestChatCompletionMock.mock.calls[1]?.[0].messages as ChatMessage[]).some(
        (message) =>
          message.attachments?.some((attachment) => attachment.fileName === 'expired-history.png')
      )
    ).toBe(true)
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBeUndefined())
  })

  it('shows connection retry progress without sending a second Agent turn', async () => {
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let pendingInput: { onEvent: (event: unknown) => void } | undefined
    let settle!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce((input) => {
      pendingInput = input
      return new Promise((resolve) => {
        settle = resolve
      })
    })
    let view!: ReturnType<typeof renderChatPage>
    await act(async () => {
      view = renderChatPage()
    })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'continue the same request' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(pendingInput).toBeDefined())
    try {
      const retry = {
        reason: 'connection-error',
        attempt: 1,
        delayMs: 2000,
        nextRetryAt: Date.now() + 2000
      }
      await act(async () => {
        pendingInput!.onEvent({ type: 'retry', retry })
      })
      await waitFor(() => {
        const props = hoisted.chatMessageListMock.mock.calls.at(-1)?.[0] as {
          isLoading?: boolean
          loadingStatus?: ChatLoadingStatus
        }
        expect(props.isLoading).toBe(true)
        expect(props.loadingStatus?.retry).toEqual(retry)
        expect(props.loadingStatus?.label).toBe('chat.loading_connection_retry')
      })
      expect(hoisted.requestChatCompletionStreamMock).toHaveBeenCalledOnce()
      expect(hoisted.notifyErrorMock).not.toHaveBeenCalled()
    } finally {
      await act(async () => {
        settle({ result: { content: 'recovered' }, response: 'recovered' })
      })
      view.unmount()
    }
  })

  it('preserves compacted originals and resolves search from the real current ChatPage archive, not the compressed request', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-project', threadId: 'pane' } as const
    const session: ChatSession = {
      id: 'memory-compact-session', title: 'Original archive', profileId: 'base-model', createdAt: 2,
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index === 0 ? 'ARCHIVE_COMPACT_ONLY_VALUE 原始🌱' : `visible turn ${index}`,
        ...(index === 0 ? { hiddenContext: 'ARCHIVE_HIDDEN_SECRET', attachments: [{ type: 'file' as const, url: 'ARCHIVE_ATTACHMENT_SECRET' }] } : {})
      }))
    }
    const sibling: ChatSession = { id: 'sibling-archive', title: 'Sibling', createdAt: 1, messages: [{ role: 'user', content: 'ARCHIVE_SIBLING_SECRET' }] }
    hoisted.storedSessions.value = [session, sibling]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    let settle!: (result: unknown) => void
    hoisted.requestChatCompletionMock.mockResolvedValueOnce({ content: 'Only a summary; original launch detail omitted.' }).mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    const page = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.click(screen.getByTestId('chat-composer-compress-context-mock'))
      await waitFor(() => expect(readCurrentSessionState()?.contextCompression?.summary).toContain('Only a summary'))
      expect(readCurrentSessionState()).toMatchObject({ compactedMessages: session.messages.slice(0, 6), messages: session.messages.slice(6) })
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === session.id)).toMatchObject({ compactedMessages: session.messages.slice(0, 6) }))
      expect(hoisted.storedSessions.value.find(item => item.id === sibling.id)).toEqual(sibling)
      const scope = { route, conversationId: session.id }
      hoisted.listAgentArchiveQueriesMock.mockImplementation(async request => ({ queries: request.conversationId === session.id ? [{ id: 'owned-original-query', expiresAt: Date.now() + 10000, search: { query: 'ARCHIVE_COMPACT_ONLY_VALUE', mode: 'literal', source: 'messages', limit: 5 } }] : [] }))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Find the earlier launch detail after compaction.' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      expect(JSON.stringify(hoisted.requestChatCompletionMock.mock.calls[1][0].messages)).not.toContain('ARCHIVE_COMPACT_ONLY_VALUE')
      await waitFor(() => expect(hoisted.resolveAgentArchiveQueryMock).toHaveBeenCalledWith(expect.objectContaining({ ...scope, queryId: 'owned-original-query', result: expect.objectContaining({ source: 'session_archive', matches: [{ messageIndex: 0, role: 'user', excerpt: 'ARCHIVE_COMPACT_ONLY_VALUE 原始🌱' }], untrustedData: true }) })))
      const reply = JSON.stringify(hoisted.resolveAgentArchiveQueryMock.mock.calls)
      for (const secret of ['ARCHIVE_HIDDEN_SECRET', 'ARCHIVE_ATTACHMENT_SECRET', 'ARCHIVE_SIBLING_SECRET']) expect(reply).not.toContain(secret)
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled(); expect(hoisted.mutateAgentNoteMock).not.toHaveBeenCalled()
      expect(readCurrentSessionState()).toMatchObject({ compactedMessages: session.messages.slice(0, 6) })
    } finally { if (settle) await act(async () => { settle({ content: 'Recovered detail.' }) }); page.unmount() }
  })

  it.each(['literal', 'lexical', 'bm25'])('resolves restored archive queries during a pending local model turn without touching notes (%s)', async mode => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'memory-project', threadId: 'pane' } as const
    let settle!: (result: unknown) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => { settle = resolve }))
    hoisted.listAgentArchiveQueriesMock.mockResolvedValue({ queries: [{ id: 'owned-query', expiresAt: Date.now() + 10000, search: { query: 'Ordinary question', mode } }] })
    const page = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      expect(hoisted.listAgentArchiveQueriesMock).not.toHaveBeenCalled()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Ordinary question' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      await waitFor(() => expect(hoisted.resolveAgentArchiveQueryMock).toHaveBeenCalledWith(expect.objectContaining({ route, conversationId: readCurrentSessionState()!.id, queryId: 'owned-query', result: expect.objectContaining({ mode, matches: [expect.objectContaining({ role: 'user', excerpt: 'Ordinary question' })], untrustedData: true }) })))
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled(); expect(hoisted.mutateAgentNoteMock).not.toHaveBeenCalled()
    } finally { await act(async () => { settle({ content: 'Ordinary answer' }) }); page.unmount() }
  })

  it('opens and stops isolated HTML from actual ChatPage without injecting HTML or a parent model turn', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'html-project', threadId: 'pane' } as const
    const app = { id: 'owned-html', title: '<script>HTML_TITLE</script>', revision: 1, sha256: 'hash', createdAt: Date.now(), expiresAt: Date.now() + 60000, status: 'ready', surface: 'canvas' }
    hoisted.agentHtmlStorageStatusMock.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: false })
    hoisted.listAgentHtmlAppsMock.mockResolvedValue({ apps: [app] }); hoisted.openAgentHtmlAppMock.mockResolvedValue({ app: { ...app, status: 'open' } }); hoisted.closeAgentHtmlAppMock.mockResolvedValue({ app: { ...app, status: 'closed' } })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.click(await screen.findByRole('button', { name: 'chat.agent_html.open' }))
      await waitFor(() => expect(hoisted.openAgentHtmlAppMock).toHaveBeenCalledOnce())
      expect(hoisted.openAgentHtmlAppMock).toHaveBeenCalledWith({ route, conversationId: readCurrentSessionState()!.id, appId: app.id, expectedRevision: 1 })
      expect(view.container.querySelector('iframe,script')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.close' }))
      await waitFor(() => expect(hoisted.closeAgentHtmlAppMock).toHaveBeenCalledOnce())
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })

  it('saves and restores an HTML ready card from actual ChatPage without running it or adding a model turn', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'html-snapshots', threadId: 'pane' } as const
    const app = { id: '11111111-1111-4111-8111-111111111111', title: 'Snapshot card', revision: 3, sha256: 'hash', createdAt: Date.now(), expiresAt: Date.now() + 60000, status: 'ready', surface: 'canvas' }
    const saved = { id: app.id, title: 'Encrypted saved card', storageRevision: 1, documentRevision: 3, createdAt: 1, updatedAt: 2, sha256: 'hash', htmlBytes: 30, surface: 'canvas' }
    hoisted.agentHtmlStorageStatusMock.mockResolvedValue({ enabled: true, initialized: true, available: true, unconfirmedRuns: 0, canInitialize: false, saveEnabled: true })
    hoisted.listAgentHtmlAppsMock.mockResolvedValue({ apps: [app] })
    hoisted.saveAgentHtmlAppMock.mockImplementation(async () => { hoisted.listAgentHtmlAppsMock.mockResolvedValue({ apps: [{ ...app, savedId: saved.id, savedRevision: 1 }] }); hoisted.listSavedAgentHtmlAppsMock.mockResolvedValue({ apps: [saved] }); return { app, saved } })
    hoisted.restoreAgentHtmlAppMock.mockResolvedValue({ app: { ...app, id: 'fresh-card', savedId: saved.id, savedRevision: 1 } })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.click(await screen.findByRole('button', { name: 'chat.agent_html.save_snapshot' }))
      await waitFor(() => expect(hoisted.saveAgentHtmlAppMock).toHaveBeenCalledOnce())
      expect(hoisted.saveAgentHtmlAppMock.mock.calls[0][0]).toEqual({ route, conversationId: readCurrentSessionState()!.id, documentToken: 'document-token', appId: app.id, expectedRevision: 3, expectedStorageRevision: 0, operationId: expect.any(String) })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_html.saved_refresh' }))
      fireEvent.click(await screen.findByRole('button', { name: 'chat.agent_html.restore' }))
      await waitFor(() => expect(hoisted.restoreAgentHtmlAppMock).toHaveBeenCalledOnce())
      expect(hoisted.restoreAgentHtmlAppMock.mock.calls[0][0]).toMatchObject({ route, conversationId: readCurrentSessionState()!.id, documentToken: 'document-token', savedId: saved.id, expectedStorageRevision: 1 })
      expect(hoisted.openAgentHtmlAppMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before); expect(view.container.querySelector('iframe,script')).toBeNull()
    } finally { view.unmount() }
  })

  it('has no notes/search/counter or duplicate goal/skill entry in the current thread', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'clean-thread', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      for (const key of ['agent_memory.open', 'agent_memory.search_notice', 'agent_goal.open', 'agent_goal.dispatch_open', 'agent_goal.cap_label', 'agent_skill_session.open', 'agent_skill_session.command_usage']) {
        expect(screen.queryByText(`chat.${key}`)).not.toBeInTheDocument()
      }
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled(); expect(hoisted.mutateAgentNoteMock).not.toHaveBeenCalled()
      expect(hoisted.listAgentArchiveQueriesMock).not.toHaveBeenCalled(); expect(hoisted.resolveAgentArchiveQueryMock).not.toHaveBeenCalled()
      expect(hoisted.listAgentGoalDispatchesMock).not.toHaveBeenCalled(); expect(hoisted.listAgentGoalsMock).not.toHaveBeenCalled()
      expect(hoisted.prepareAgentGoalProgressMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('views /env and /system_prompt locally without parent messages or model requests', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'inspection-command', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      for (const command of ['/env', '/system_prompt']) {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: command } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        expect(await screen.findByTestId('agent-inspection-view')).toHaveTextContent(command)
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
        fireEvent.click(screen.getByRole('button', { name: 'Close command view' }))
      }
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/env set secret' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('Use /env or /system_prompt without arguments.')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('/env set secret')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('shows plugin/module configuration handoffs without changing settings or sending parent requests', async () => {
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      for (const command of ['/plugin', '/module configure']) {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: command } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        expect(await screen.findByTestId('agent-configuration-view')).toHaveTextContent(command.split(' ')[0])
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
        if (command === '/plugin') expect(screen.getByRole('button', { name: 'Open plugin center' })).toBeVisible()
        else {
          expect(screen.getByRole('button', { name: 'Open tool environment settings' })).toBeVisible()
          expect(screen.getByRole('button', { name: 'Open MCP client settings' })).toBeVisible()
        }
        fireEvent.click(screen.getByRole('button', { name: 'Close configuration view' }))
      }
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/module enable bash' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('Use /plugin [configure] or /module [configure]. Change switches and parameters in the existing editor.')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('/module enable bash')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })

  it('does not publish a late jobs refresh into a reopened panel', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'jobs-late', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const command = () => {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/jobs' } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      }
      command()
      let release!: (value: { jobs: [] }) => void
      hoisted.listAgentJobsMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      fireEvent.click(screen.getByRole('button', { name: 'Refresh thread jobs' }))
      fireEvent.click(screen.getByRole('button', { name: 'Close command panel' }))
      command()
      await act(async () => release({ jobs: [] }))
      expect(screen.queryByText('No helper jobs.')).toBeNull()
    } finally { view.unmount() }
  })

  it('opens local status and explicit jobs refresh without model calls; compact never samples before confirmation', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'basic-commands', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/status' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(await screen.findByTestId('agent-inspection-view')).toHaveTextContent('"messages"')
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/jobs' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      fireEvent.click(await screen.findByRole('button', { name: 'Refresh thread jobs' }))
      expect(await screen.findByText('No helper jobs.')).toBeVisible()
      expect(hoisted.listAgentJobsMock).toHaveBeenCalledWith({ route, conversationId: readCurrentSessionState()!.id })
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/compact' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/compact now' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('Use /status, /jobs or /compact without arguments.')
    } finally { view.unmount() }
  })

  it('confirms missing references without changing original images, then projects placeholders into the next request', async () => {
    const session: ChatSession = { id: 'repair-positive', title: 'Repair', createdAt: 100, messages: [
      { role: 'assistant', content: 'Historical answer', attachments: [{ type: 'image', url: 'local-media:///missing-history.png' }] }
    ] }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.fileExistsBatchMock.mockResolvedValue([false])
    hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'Done' })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/repair-images' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await screen.findByText('Message 1, image 1')
      expect(readCurrentSessionState()?.messages[0].attachments?.[0].url).toBe('local-media:///missing-history.png')
      fireEvent.click(screen.getByRole('button', { name: 'Confirm branch image placeholders' }))
      expect(screen.getByText('Confirmed branch-context placeholders. Original history unchanged.')).toBeVisible()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Continue without that image' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock.mock.calls.length + hoisted.requestChatCompletionStreamMock.mock.calls.length).toBeGreaterThan(0))
      const request = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] ?? hoisted.requestChatCompletionStreamMock.mock.calls[0]?.[0]
      expect(JSON.stringify(request?.messages)).toContain('[Missing local image omitted from this branch context]')
      expect(JSON.stringify(request?.messages)).not.toContain('missing-history.png')
      expect(readCurrentSessionState()?.messages[0].attachments?.[0].url).toBe('local-media:///missing-history.png')
    } finally { view.unmount() }
  })

  it('lists image repair results only on explicit command without mutating original history', async () => {
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      expect(hoisted.fileExistsBatchMock).not.toHaveBeenCalled()
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/repair-images' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(await screen.findByTestId('image-repair-view')).toHaveTextContent('No missing local images found')
      expect(screen.getByRole('button', { name: 'Confirm branch image placeholders' })).toBeDisabled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      expect(hoisted.fileExistsBatchMock).not.toHaveBeenCalled()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/repair-images all' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('Use /repair-images without arguments.')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('views /scratchpad and /pad explicitly without a parent message, model, mutation or automatic notes read', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'scratchpad-command', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled()
      hoisted.getAgentNotesMock.mockResolvedValue({ revision: 4, notes: [{ key: 'retained', value: '<script>NOT_EXECUTABLE</script>\nSAVED_WORKING_NOTE', updatedAt: 1 }] })
      const before = JSON.stringify(readCurrentSessionState()?.messages), id = readCurrentSessionState()!.id
      for (const command of ['/scratchpad', '/pad']) {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: command } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        await screen.findByText(/SAVED_WORKING_NOTE/)
        expect(hoisted.getAgentNotesMock).toHaveBeenLastCalledWith({ route, conversationId: id })
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
        expect(document.querySelector('script')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
      }
      expect(hoisted.getAgentNotesMock).toHaveBeenCalledTimes(2)
      expect(hoisted.mutateAgentNoteMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })
  it('intercepts invalid /scratchpad write/clear arguments without parent fallback or draft clearing', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'scratchpad-invalid', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      for (const command of ['/scratchpad clear', '/pad set x y']) {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: command } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('chat.agent_scratchpad.command_usage')
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(command)
      }
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled(); expect(hoisted.mutateAgentNoteMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('keeps /pad outside the busy parent queue without aborting or changing its messages', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'scratchpad-busy', threadId: 'pane' } as const
    let finish!: (result: unknown) => void, signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) })
    hoisted.getAgentNotesMock.mockResolvedValue({ revision: 0, notes: [] })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'PARENT_RUNNING' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/pad' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.getAgentNotesMock).toHaveBeenCalledOnce())
      expect(signal?.aborted).toBe(false); expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument(); expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      await act(async () => { finish({ content: 'PARENT_FINISHED' }) })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce(); expect(JSON.stringify(readCurrentSessionState()?.messages)).not.toContain('/pad')
    } finally { view.unmount() }
  })
  it.each(['ordinary', 'remote', 'inactive', 'hidden-context'] as const)('never falls back to parent chat for unavailable /scratchpad (%s)', async mode => {
    if (mode === 'remote') hoisted.currentConfig.value!.use_remote_llm = true
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'scratchpad-unavailable', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={mode === 'ordinary' ? undefined : route} active={mode !== 'inactive'} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      if (mode === 'hidden-context') await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/scratchpad', hiddenText: 'PRIVATE_EXTRA', targetScope: 'runtime-flow' } })) })
      else fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/scratchpad' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('chat.agent_scratchpad.command_unavailable')
      expect(hoisted.getAgentNotesMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })

  it('submits literal /btw start/open/continue/stop only to the private side APIs without a parent message or model', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-command', threadId: 'pane' } as const
    const branch = { id: '11111111-1111-4111-8111-111111111111', revision: 5, generation: 1, status: 'completed', title: 'Private side', createdAt: 1, updatedAt: 2, turns: 1, modelSteps: 1, toolCalls: 0, snapshotTruncated: true, profileId: 'chat-model', modelLabel: 'Model', busy: false, canContinue: true }
    const session: ChatSession = { id: 'command-parent', title: 'Parent', messages: [{ role: 'user', content: 'VISIBLE_PARENT', hiddenContext: 'HIDDEN_PARENT' }, { role: 'assistant', content: 'PARENT_ANSWER', toolHistory: [{ runId: 'old', toolCallId: 'old', toolName: 'files.read', args: {}, status: 'completed', content: 'PRIVATE_TOOL_HISTORY' }] }] }
    hoisted.storedSessions.value = [session]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    hoisted.startAgentSideMock.mockResolvedValue({ branch }); hoisted.continueAgentSideMock.mockResolvedValue({ branch }); hoisted.stopAgentSideMock.mockResolvedValue({ branch })
    hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [{ role: 'assistant', kind: 'answer', content: 'PRIVATE_COMMAND_ANSWER' }], snapshotCharacters: 12, untrustedData: true })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      const submit = async (command: string) => {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: command } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
      }
      await submit('/btw PRIVATE_COMMAND_QUESTION')
      await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledOnce())
      expect(hoisted.startAgentSideMock.mock.calls[0][0]).toMatchObject({ route, conversationId: session.id, question: 'PRIVATE_COMMAND_QUESTION', snapshot: [{ role: 'user', content: 'VISIBLE_PARENT' }, { role: 'assistant', content: 'PARENT_ANSWER' }] })
      expect(JSON.stringify(hoisted.startAgentSideMock.mock.calls)).not.toMatch(/HIDDEN_PARENT|PRIVATE_TOOL_HISTORY/)
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.close' }))
      await submit(`/btw --open ${branch.id}`)
      expect(await screen.findByText('PRIVATE_COMMAND_ANSWER')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.close' }))
      await submit(`/btw --continue ${branch.id} PRIVATE_FOLLOWUP`)
      await waitFor(() => expect(hoisted.continueAgentSideMock).toHaveBeenCalledOnce())
      expect(hoisted.continueAgentSideMock.mock.calls[0][0]).toMatchObject({ route, conversationId: session.id, branchId: branch.id, expectedRevision: 5, question: 'PRIVATE_FOLLOWUP' })
      expect(hoisted.continueAgentSideMock.mock.calls[0][0]).not.toHaveProperty('snapshot')
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.close' }))
      await submit(`/btw --stop ${branch.id}`)
      await waitFor(() => expect(hoisted.stopAgentSideMock).toHaveBeenCalledWith({ route, conversationId: session.id, branchId: branch.id, expectedRevision: 5 }))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })
  it('does not restore an accepted /btw command as a draft after remounting the same conversation', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-draft', threadId: 'pane' } as const
    const branch = { id: '11111111-1111-4111-8111-111111111111', revision: 1, canContinue: true, busy: false }
    hoisted.startAgentSideMock.mockResolvedValue({ branch }); hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [] })
    const renderSideChat = () => renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    const first = renderSideChat()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const id = readCurrentSessionState()!.id
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw PRIVATE_ACCEPTED_DRAFT' } })
    await waitFor(() => expect(hoisted.draftBackups.value[`runtime-flow:${id}`]?.draft?.inputValue).toBe('/btw PRIVATE_ACCEPTED_DRAFT'))
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
    first.unmount()
    const second = renderSideChat()
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(id))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(hoisted.startAgentSideMock).toHaveBeenCalledOnce(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { second.unmount() }
  })
  it('clears an accepted /skill draft synchronously but preserves a newer unsent draft after remount', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-draft', threadId: 'pane' } as const
    const first = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
    const id = readCurrentSessionState()!.id, key = `runtime-flow:${id}`
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skills list' } })
    await waitFor(() => expect(hoisted.draftBackups.value[key]?.draft?.inputValue).toBe('/skills list'))
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    expect(hoisted.draftBackups.value[key]?.draft).toBeUndefined()
    await waitFor(() => expect(hoisted.listAgentSessionSkillsMock).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'NEW_UNSENT_DRAFT' } })
    await waitFor(() => expect(hoisted.draftBackups.value[key]?.draft?.inputValue).toBe('NEW_UNSENT_DRAFT'))
    first.unmount()
    const second = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('NEW_UNSENT_DRAFT'))
      expect(hoisted.listAgentSessionSkillsMock).toHaveBeenCalledOnce(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(readCurrentSessionState()?.messages).toEqual([])
    } finally { second.unmount() }
  })
  it('keeps /btw outside the busy parent queue and does not stop or append to its active request', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'busy-side', threadId: 'pane' } as const
    const branch = { id: '11111111-1111-4111-8111-111111111111', revision: 1, generation: 1, status: 'running', title: 'Side', createdAt: 1, updatedAt: 2, turns: 1, modelSteps: 0, toolCalls: 0, snapshotTruncated: true, profileId: 'chat-model', modelLabel: 'Model', busy: true, canContinue: false }
    hoisted.startAgentSideMock.mockResolvedValue({ branch }); hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [], snapshotCharacters: 0, untrustedData: true })
    let finish!: (result: unknown) => void, signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'PARENT_RUNNING' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw BUSY_PRIVATE_QUESTION' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledOnce())
      expect(signal?.aborted).toBe(false); expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      await act(async () => { finish({ content: 'PARENT_FINISHED' }) })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).not.toMatch(/BUSY_PRIVATE_QUESTION|\/btw/)
    } finally { view.unmount() }
  })
  it('intercepts malformed/unavailable /btw and rejects attachments without parent fallback', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-refusal', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw --open ../../other' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('chat.agent_side.command_usage')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('/btw --open ../../other')
      await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/btw ATTACHED', attachment: createImageAttachment('private.png'), targetScope: 'runtime-flow' } })) })
      await waitFor(() => expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1'))
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('chat.agent_side.command_unavailable')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1')
      expect(hoisted.startAgentSideMock).not.toHaveBeenCalled(); expect(hoisted.openAgentSideMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it.each(['ordinary', 'remote', 'inactive', 'hidden-context'] as const)('does not fall back to parent chat for /btw when %s is unavailable', async mode => {
    if (mode === 'remote') hoisted.currentConfig.value!.use_remote_llm = true
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-unavailable', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={mode === 'ordinary' ? undefined : route} active={mode !== 'inactive'} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      if (mode === 'hidden-context') await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/btw PRIVATE_HIDDEN', hiddenText: 'PRIVATE_EXTRA', targetScope: 'runtime-flow' } })) })
      else fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw PRIVATE_UNAVAILABLE' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('chat.agent_side.command_unavailable')
      expect(hoisted.startAgentSideMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('drops a delayed /btw continuation after actual ChatPage session switching', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-switch', threadId: 'pane' } as const
    const a: ChatSession = { id: 'command-a', title: 'A', messages: [] }, b: ChatSession = { id: 'command-b', title: 'B', messages: [] }
    hoisted.storedSessions.value = [a, b]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), a.id)
    let finish!: (value: unknown) => void
    hoisted.openAgentSideMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ branch: { id: '11111111-1111-4111-8111-111111111111', revision: 4, canContinue: true, busy: false }, messages: [], untrustedData: true, snapshotCharacters: 0 })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(a.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw --continue 11111111-1111-4111-8111-111111111111 PRIVATE_OLD_FOLLOWUP' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.openAgentSideMock).toHaveBeenCalled())
      await dispatchSwitchSession(b.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(b.id))
      await act(async () => { finish({ branch: { id: '11111111-1111-4111-8111-111111111111', revision: 4, canContinue: true, busy: false }, messages: [{ role: 'assistant', content: 'OLD_PRIVATE_ANSWER' }] }) })
      expect(hoisted.continueAgentSideMock).not.toHaveBeenCalled()
      expect(screen.queryByText('OLD_PRIVATE_ANSWER')).not.toBeInTheDocument(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(readCurrentSessionState()?.messages).toEqual([])
    } finally { view.unmount() }
  })
  it('revokes a delayed /btw continuation when local command eligibility changes during actual ChatPage open', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-mode-change', threadId: 'pane' } as const
    let finish!: (value: unknown) => void
    hoisted.openAgentSideMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue({ branch: { id: '11111111-1111-4111-8111-111111111111', revision: 4, canContinue: true, busy: false }, messages: [], untrustedData: true, snapshotCharacters: 0 })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/btw --continue 11111111-1111-4111-8111-111111111111 OLD_MODE_QUESTION' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.openAgentSideMock).toHaveBeenCalled())
      hoisted.currentConfig.value = { ...hoisted.currentConfig.value!, use_remote_llm: true }
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" route={route} /></ThemeProvider></MemoryRouter>)
      await act(async () => { finish({ branch: { id: '11111111-1111-4111-8111-111111111111', revision: 4, canContinue: true, busy: false }, messages: [] }) })
      expect(hoisted.continueAgentSideMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('does not interpret an external auto-send as a privileged /btw command', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'external-side', threadId: 'pane' } as const
    hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'Ordinary parent text received' })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/btw EXTERNAL_TEXT', autoSend: true, targetScope: 'runtime-flow' } })) })
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      expect(hoisted.startAgentSideMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].messages.at(-1).content).toBe('/btw EXTERNAL_TEXT')
    } finally { view.unmount() }
  })

  it('lists the main and side conversations as thread sub-rows and restores the parent draft', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-nav', threadId: 'pane' } as const
    const branch = { id: '11111111-1111-4111-8111-111111111111', revision: 3, title: 'A private branch', status: 'completed', busy: false, canContinue: true }
    hoisted.listAgentSidesMock.mockResolvedValue({ branches: [branch] })
    hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [{ role: 'assistant', kind: 'answer', content: 'SIDE_NAV_ANSWER' }] })
    const subRowChange = vi.fn()
    const page = renderWithProviders(<WithThreadSubRows>{host => <ChatPage compact storageScope="runtime-flow" route={route} threadSubRowsHost={host} onThreadSubRowChange={subRowChange} />}</WithThreadSubRows>)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const input = screen.getByTestId('chat-composer-input-mock')
      fireEvent.change(input, { target: { value: 'PARENT_DRAFT_RETAINED' } })
      // No permanent row or "+" above the transcript: the rows live in the thread list host.
      expect(screen.queryByRole('button', { name: 'chat.agent_side.navigation' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'chat.agent_side.new' })).not.toBeInTheDocument()
      const rows = within(screen.getByTestId('thread-sub-rows'))
      const side = await rows.findByRole('button', { name: /A private branch/ })
      const main = rows.getByRole('button', { name: 'chat.agent_side.main' })
      expect(rows.getAllByRole('button')).toEqual([main, side])
      expect(main).toHaveAttribute('aria-current', 'true'); expect(side).not.toHaveAttribute('aria-current')
      fireEvent.click(side)
      expect(await screen.findByText('SIDE_NAV_ANSWER')).toBeVisible()
      expect(input).not.toBeVisible(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(side).toHaveAttribute('aria-current', 'true'); expect(main).not.toHaveAttribute('aria-current')
      expect(subRowChange).toHaveBeenLastCalledWith('A private branch')
      fireEvent.click(main)
      expect(input).toBeVisible(); expect(input).toHaveValue('PARENT_DRAFT_RETAINED')
      expect(screen.queryByText('SIDE_NAV_ANSWER')).not.toBeInTheDocument()
      expect(subRowChange).toHaveBeenLastCalledWith(null)
      expect(hoisted.stopAgentSideMock).not.toHaveBeenCalled(); expect(hoisted.startAgentSideMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })
  it('changes per-conversation skill availability through the actual ChatPage without sending body or a parent model turn', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-session', threadId: 'pane' } as const
    const skill = { id: 'registered-skill', name: 'Current procedure', description: 'Metadata only', paths: ['*.ts'], hidden: false, enabled: true }
    hoisted.listAgentSessionSkillsMock.mockResolvedValue({ revision: 3, skills: [skill], staleDisabledIds: [], truncated: false, grantsPermission: false })
    hoisted.setAgentSkillPreferenceMock.mockResolvedValue({ revision: 4, skills: [{ ...skill, enabled: false }], staleDisabledIds: [], truncated: false, grantsPermission: false })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      const before = JSON.stringify(readCurrentSessionState()?.messages), conversationId = readCurrentSessionState()!.id
      expect(hoisted.listAgentSessionSkillsMock).not.toHaveBeenCalled(); expect(hoisted.setAgentSkillPreferenceMock).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: '技能' })).not.toBeInTheDocument()
      await openSkillTakeover()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_skill_session.open' }))
      await screen.findByText('Current procedure · chat.agent_skill_session.enabled')
      expect(hoisted.listAgentSessionSkillsMock).toHaveBeenCalledWith({ route, conversationId, documentToken: 'skill-document' })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_skill_session.disable' }))
      await screen.findByText('Current procedure · chat.agent_skill_session.disabled')
      expect(hoisted.setAgentSkillPreferenceMock).toHaveBeenCalledWith({ route, conversationId, documentToken: 'skill-document', id: skill.id, enabled: false, expectedRevision: 3, operationId: expect.any(String) })
      fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })

  it('retains an uncertain side request while the top skill picker opens and closes', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-skill-navigation', threadId: 'pane' } as const
    hoisted.startAgentSideMock.mockRejectedValueOnce(new Error('Reply lost'))
    const page = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      openNewSideForm()
      fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'Retain this operation' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
      await screen.findByText('chat.agent_side.error')
      const original = hoisted.startAgentSideMock.mock.calls[0][0]
      await openSkillTakeover()
      expect(screen.getByTestId('agent-side-navigation')).not.toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
      expect(screen.getByText('chat.agent_side.pending_notice')).toBeVisible()
      expect(screen.getByLabelText('chat.agent_side.question')).toHaveValue('Retain this operation')
      expect(screen.getByLabelText('chat.agent_side.question')).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
      await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledTimes(2))
      expect(hoisted.startAgentSideMock.mock.calls[1][0]).toEqual(original)
      expect(hoisted.stopAgentSideMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('keeps the parent composer and request mounted through top Skills navigation with Stop available', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skills-parent-owner', threadId: 'pane' } as const
    let finish!: (result: unknown) => void, signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const input = screen.getByTestId('chat-composer-input-mock')
      fireEvent.change(input, { target: { value: 'PARENT_RUNNING' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      await openSkillTakeover()
      // The hidden composer stays mounted and keeps a draft written while the view is open.
      fireEvent.change(input, { target: { value: 'NEW_PARENT_DRAFT' } })
      expect(input).toBeInTheDocument(); expect(input).not.toBeVisible(); expect(signal?.aborted).toBe(false)
      expect(screen.getByRole('button', { name: 'chat.stop_generating' })).toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
      expect(screen.getByTestId('chat-composer-input-mock')).toBe(input); expect(input).toBeVisible(); expect(input).toHaveValue('NEW_PARENT_DRAFT')
      expect(signal?.aborted).toBe(false); expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      await openSkillTakeover()
      fireEvent.click(screen.getByRole('button', { name: 'chat.stop_generating' }))
      await waitFor(() => expect(signal?.aborted).toBe(true))
    } finally { await act(async () => { finish({ content: 'LATE_AFTER_STOP' }) }); view.unmount() }
  })
  it('restores the exact uncertain side identity after switching the actual ChatPage away and back', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-round-trip', threadId: 'pane' } as const
    const a: ChatSession = { id: 'side-a', title: 'A', messages: [] }, b: ChatSession = { id: 'side-b', title: 'B', messages: [] }
    hoisted.storedSessions.value = [a, b]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), a.id)
    hoisted.startAgentSideMock.mockRejectedValueOnce(new Error('Reply lost'))
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(a.id))
      openNewSideForm()
      fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'ORIGINAL_PRIVATE_QUESTION' } }); fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
      await screen.findByText('chat.agent_side.error')
      const original = hoisted.startAgentSideMock.mock.calls[0][0]
      await dispatchSwitchSession(b.id); await waitFor(() => expect(readCurrentSessionState()?.id).toBe(b.id))
      expect(screen.queryByText('chat.agent_side.pending_notice')).not.toBeInTheDocument()
      await dispatchSwitchSession(a.id); await waitFor(() => expect(readCurrentSessionState()?.id).toBe(a.id))
      expect(screen.getByText('chat.agent_side.pending_notice')).toBeVisible()
      expect(screen.getByTestId('chat-composer-input-mock')).not.toBeVisible()
      expect(screen.getByTestId('chat-session-state')).not.toBeVisible()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
      await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledTimes(2))
      expect(hoisted.startAgentSideMock.mock.calls[1][0]).toEqual(original)
      expect(readCurrentSessionState()?.messages).toEqual([]); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('routes /skills list, /skill show and preference commands through user services without a parent message or model', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-commands', threadId: 'pane' } as const
    let enabled = true, revision = 1
    const entry = () => ({ id: 'one', name: 'review-local', description: 'Metadata', paths: [], hidden: false, enabled })
    const catalog = () => ({ revision, skills: [entry()], staleDisabledIds: [], truncated: false, grantsPermission: false })
    hoisted.listAgentSessionSkillsMock.mockImplementation(async () => catalog())
    hoisted.setAgentSkillPreferenceMock.mockImplementation(async input => { enabled = input.enabled; revision++; return catalog() })
    hoisted.showAgentSessionSkillMock.mockImplementation(async () => ({ ...entry(), revision, instructions: '<script>USER_ONLY_SKILL_BODY</script>', baseDirectory: 'D:/pack', untrustedData: true, grantsPermission: false, executed: false }))
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      const before = JSON.stringify(readCurrentSessionState()?.messages), conversationId = readCurrentSessionState()!.id
      const submit = (text: string) => { fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock')) }
      submit('/skills list')
      await screen.findByText('review-local · chat.agent_skill_session.enabled')
      expect(hoisted.showAgentSessionSkillMock).not.toHaveBeenCalled()
      submit('/skill disable review-local')
      await screen.findByText('review-local · chat.agent_skill_session.disabled')
      expect(hoisted.setAgentSkillPreferenceMock).toHaveBeenLastCalledWith({ route, conversationId, documentToken: 'skill-document', id: 'one', enabled: false, expectedRevision: 1, operationId: expect.any(String) })
      submit('/skill show review-local')
      expect(await screen.findByText('<script>USER_ONLY_SKILL_BODY</script>')).toBeInTheDocument()
      expect(hoisted.showAgentSessionSkillMock).toHaveBeenCalledWith({ route, conversationId, documentToken: 'skill-document', name: 'review-local' })
      expect(view.container.querySelector('script')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_skill_session.close_body' }))
      submit('/skill enable one'); await screen.findByText('review-local · chat.agent_skill_session.enabled')
      submit('/skill toggle one'); await screen.findByText('review-local · chat.agent_skill_session.disabled')
      expect(hoisted.setAgentSkillPreferenceMock.mock.calls.map(([req]) => req.expectedRevision)).toEqual([1, 2, 3])
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    } finally { view.unmount() }
  })
  it('keeps a user /skill command out of a busy parent queue and preserves the active parent Stop request', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-busy', threadId: 'pane' } as const
    let finish!: (result: unknown) => void, signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(input => { signal = input.signal; return new Promise(resolve => { finish = resolve }) })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'PARENT_WORK' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skill list' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.listAgentSessionSkillsMock).toHaveBeenCalledOnce())
      expect(signal?.aborted).toBe(false); expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument(); expect(screen.getByTestId('chat-composer-stop-mock')).toBeInTheDocument()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
      await act(async () => { finish({ content: 'PARENT_DONE' }) })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).not.toContain('/skill')
    } finally { view.unmount() }
  })
  it('does not turn a malformed /skill into parent text or reinterpret external autoSend as a user skill command', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-refused', threadId: 'pane' } as const
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skill delete one' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('chat.agent_skill_session.command_usage')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.listAgentSessionSkillsMock).not.toHaveBeenCalled()
      await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/skill show EXTERNAL', autoSend: true, targetScope: 'runtime-flow' } })) })
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      expect(hoisted.showAgentSessionSkillMock).not.toHaveBeenCalled(); expect(hoisted.setAgentSkillPreferenceMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it.each(['ordinary', 'remote', 'inactive', 'attachments', 'hidden-context'] as const)('never falls back to a parent model for a recognized user /skill when %s prevents it', async mode => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-unavailable', threadId: 'pane' } as const
    if (mode === 'remote') hoisted.currentConfig.value!.use_remote_llm = true
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={mode === 'ordinary' ? undefined : route} active={mode !== 'inactive'} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      if (mode === 'attachments' || mode === 'hidden-context') {
        await act(async () => { window.dispatchEvent(new CustomEvent('send-to-agent', { detail: { text: '/skill show PRIVATE_PROCEDURE', ...(mode === 'attachments' ? { attachment: createImageAttachment('private.png') } : { hiddenText: 'PRIVATE_HIDDEN' }), targetScope: 'runtime-flow' } })) })
        if (mode === 'attachments') await waitFor(() => expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1'))
      } else fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skill show PRIVATE_PROCEDURE' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('chat.agent_skill_session.command_unavailable')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('/skill show PRIVATE_PROCEDURE')
      expect(hoisted.showAgentSessionSkillMock).not.toHaveBeenCalled(); expect(hoisted.setAgentSkillPreferenceMock).not.toHaveBeenCalled(); expect(hoisted.listAgentSessionSkillsMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('drops delayed user /skill mutation and body responses when the actual ChatPage switches conversations', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-switch', threadId: 'pane' } as const
    const a: ChatSession = { id: 'skill-a', title: 'A', messages: [] }, b: ChatSession = { id: 'skill-b', title: 'B', messages: [] }
    hoisted.storedSessions.value = [a, b]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), a.id)
    let finish!: (result: unknown) => void
    hoisted.listAgentSessionSkillsMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(a.id))
      await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skill toggle one' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.listAgentSessionSkillsMock).toHaveBeenCalledOnce())
      await dispatchSwitchSession(b.id); await waitFor(() => expect(readCurrentSessionState()?.id).toBe(b.id))
      await act(async () => { finish({ revision: 1, skills: [{ id: 'one', name: 'one', enabled: true }], staleDisabledIds: [] }) })
      expect(hoisted.setAgentSkillPreferenceMock).not.toHaveBeenCalled()
      await waitFor(() => expect(hoisted.setAgentSkillScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      hoisted.showAgentSessionSkillMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/skill show one' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.showAgentSessionSkillMock).toHaveBeenCalledOnce())
      await dispatchSwitchSession(a.id); await waitFor(() => expect(readCurrentSessionState()?.id).toBe(a.id))
      await act(async () => { finish({ instructions: 'OLD_SKILL_BODY' }) })
      expect(screen.queryByText('OLD_SKILL_BODY')).not.toBeInTheDocument(); expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('starts and continues a private side from the actual ChatPage without altering parent messages or calling its model', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'side-project', threadId: 'pane' } as const
    const branch = { id: 'owned-side', revision: 3, generation: 1, status: 'completed', title: 'Private side', createdAt: 1, updatedAt: 2, turns: 1, modelSteps: 1, toolCalls: 0, snapshotTruncated: true, profileId: 'chat-model', modelLabel: 'Model', busy: false, canContinue: true }
    hoisted.startAgentSideMock.mockResolvedValue({ branch }); hoisted.continueAgentSideMock.mockResolvedValue({ branch: { ...branch, turns: 2 } })
    hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [{ role: 'assistant', kind: 'answer', content: 'PRIVATE_SIDE_ANSWER' }], snapshotCharacters: 0, untrustedData: true })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const before = JSON.stringify(readCurrentSessionState()?.messages)
      openNewSideForm()
      fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'PRIVATE_SIDE_QUESTION' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.start' }))
      await waitFor(() => expect(hoisted.startAgentSideMock).toHaveBeenCalledOnce())
      expect(hoisted.startAgentSideMock.mock.calls[0][0]).toMatchObject({ route, conversationId: readCurrentSessionState()!.id, question: 'PRIVATE_SIDE_QUESTION' })
      expect(await screen.findByText('PRIVATE_SIDE_ANSWER')).toBeTruthy()
      fireEvent.change(screen.getByLabelText('chat.agent_side.question'), { target: { value: 'FOLLOWUP_ONLY' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.continue' }))
      await waitFor(() => expect(hoisted.continueAgentSideMock).toHaveBeenCalledOnce())
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(JSON.stringify(readCurrentSessionState()?.messages)).toBe(before)
    } finally { view.unmount() }
  })

  it('keeps approved background process controls available after the parent reply without another model call', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'process-project', threadId: 'pane' } as const
    const job = { id: 'owned-process', kind: 'python', status: 'completed', createdAt: Date.now(), expiresAt: Date.now() + 60000, outcome: 'known', stdoutBytes: 7, stderrBytes: 0, truncated: false, operationSettled: true, cancellationRequested: false, exitCode: 0 }
    hoisted.listAgentProcessesMock.mockResolvedValue({ jobs: [job] })
    hoisted.readAgentProcessMock.mockResolvedValue({ job, data: 'REAL_PROCESS_LOG', nextCursor: 16, eof: true, truncated: false, untrustedData: true })
    hoisted.requestChatCompletionMock.mockResolvedValueOnce({ content: 'Approved process submitted; inspect status.' })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const id = readCurrentSessionState()!.id
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Run Python in background' } }); fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.content).toContain('submitted'))
      expect(hoisted.readAgentProcessMock).not.toHaveBeenCalled()
      fireEvent.click(await screen.findByRole('button', { name: '展开 python 详情' }))
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_process.stdout' }))
      expect(await screen.findByText('REAL_PROCESS_LOG')).toBeTruthy()
      expect(hoisted.readAgentProcessMock).toHaveBeenCalledWith({ route, conversationId: id, jobId: 'owned-process', stream: 'stdout', cursor: 0, maxBytes: 16384 })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      expect(readCurrentSessionState()?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    } finally { view.unmount() }
  })

  it('keeps the job panel usable after the parent answer without sending a new model request', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'jobs-project', threadId: 'pane' } as const
    const job = { id: 'owned-job', kind: 'explore', task: 'Read project files', status: 'completed', createdAt: Date.now(), expiresAt: Date.now() + 60000 }
    hoisted.listAgentJobsMock.mockResolvedValue({ jobs: [job] })
    hoisted.readAgentJobMock.mockResolvedValue({ job, text: 'REPORT FROM BACKGROUND', nextOffset: 22, totalCharacters: 22 })
    hoisted.requestChatCompletionMock.mockResolvedValueOnce({ content: 'Delegated; report pending.' })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const sessionId = readCurrentSessionState()!.id
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Investigate in background' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('Delegated; report pending.'))
      fireEvent.click(await screen.findByRole('button', { name: '展开 explore 详情' }))
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_jobs.read' }))
      await waitFor(() => expect(screen.getByText('REPORT FROM BACKGROUND')).toBeInTheDocument())
      expect(hoisted.readAgentJobMock).toHaveBeenCalledWith({ route, conversationId: sessionId, jobId: 'owned-job', offset: 0, limit: 16000 })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      expect(readCurrentSessionState()?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    } finally { view.unmount() }
  })

  it.each([false, true])('shows local Agent feedback while the original request waits (stream=%s)', async (stream) => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'feedback-project', threadId: 'pane' } as const
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    let settle!: (value: unknown) => void
    const dispatch = stream ? hoisted.requestChatCompletionStreamMock : hoisted.requestChatCompletionMock
    dispatch.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    hoisted.listAgentInteractionsMock.mockResolvedValue({ interactions: [{ id: 'owned-question', expiresAt: Date.now() + 60000, prompt: { kind: 'ask_user', question: 'Which colour?' } }] })
    let view!: ReturnType<typeof renderChatPage>
    await act(async () => { view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />) })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const sessionId = readCurrentSessionState()!.id
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Ask me' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(screen.getByText('Which colour?')).toBeInTheDocument())
    try {
      expect(hoisted.listAgentInteractionsMock).toHaveBeenCalledWith({ route, conversationId: sessionId })
      fireEvent.change(screen.getByRole('textbox', { name: 'chat.agent_interaction.answer' }), { target: { value: 'Blue' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_interaction.submit' }))
      await waitFor(() => expect(hoisted.resolveAgentInteractionMock).toHaveBeenCalledWith({ route, conversationId: sessionId, interactionId: 'owned-question', answer: { status: 'answered', text: 'Blue' } }))
      expect(dispatch).toHaveBeenCalledOnce()
      expect(readCurrentSessionState()?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    } finally {
      await act(async () => settle(stream ? { result: { content: 'Received Blue' }, response: 'Received Blue' } : { content: 'Received Blue' }))
      view.unmount()
    }
  })

  it('opens a declarative display from the mounted thread and submits feedback without adding a user turn', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'display-project', threadId: 'pane' } as const
    let settle!: (value: unknown) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
    hoisted.listAgentInteractionsMock.mockResolvedValue({ interactions: [{ id: 'owned-display', expiresAt: Date.now() + 60000, prompt: { kind: 'show_app', document: { title: 'Budget comparison', blocks: [{ kind: 'table', columns: ['Plan', 'Cost'], rows: [['A', '10']] }], fields: [{ kind: 'text', id: 'note', label: 'Plan feedback', required: true }] } } }] })
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      const sessionId = readCurrentSessionState()!.id
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Show plans' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      fireEvent.click(await screen.findByRole('button', { name: 'chat.agent_app.open' }))
      expect(await screen.findByRole('table')).toHaveTextContent('Cost')
      fireEvent.change(screen.getByRole('textbox', { name: 'Plan feedback' }), { target: { value: 'Use A' } })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_app.submit' }))
      await waitFor(() => expect(hoisted.resolveAgentInteractionMock).toHaveBeenCalledWith({ route, conversationId: sessionId, interactionId: 'owned-display', answer: { status: 'answered', values: { note: 'Use A' } } }))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      expect(readCurrentSessionState()?.messages.filter((message) => message.role === 'user')).toHaveLength(1)
    } finally { await act(async () => { settle?.({ content: 'Received feedback' }) }); view.unmount() }
  })

  it('reports real tool activity while the model answer remains pending', async () => {
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let pendingInput: { onEvent: (event: unknown) => void } | undefined
    let settle!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce((input) => {
      pendingInput = input
      return new Promise((resolve) => {
        settle = resolve
      })
    })
    let view!: ReturnType<typeof renderChatPage>
    await act(async () => {
      view = renderChatPage()
    })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'search for documentation' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(pendingInput).toBeDefined())
    const loading = () =>
      (
        hoisted.chatMessageListMock.mock.calls.at(-1)?.[0] as {
          loadingStatus?: { label: string; detail?: string; step?: number }
        }
      )?.loadingStatus
    try {
      await act(async () => {
        pendingInput!.onEvent({
          type: 'tool-status',
          toolStatus: {
            runId: 'owned-search-run',
            toolCallId: 'owned-search-call',
            toolName: 'web_search',
            status: 'running'
          }
        })
      })
      await waitFor(() => expect(loading()?.detail).toBe('web_search'))
      const runningLabel = loading()?.label
      expect(runningLabel).toBeTruthy()
      expect(loading()?.step).toBeUndefined()
      await act(async () => {
        pendingInput!.onEvent({
          type: 'tool-status',
          toolStatus: {
            runId: 'owned-search-run',
            toolCallId: 'owned-search-call',
            toolName: 'web_search',
            status: 'completed'
          }
        })
      })
      await waitFor(() => expect(loading()?.label).not.toBe(runningLabel))
      expect(loading()?.detail).toBe('web_search')
      expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('')
    } finally {
      await act(async () => settle({ result: { content: 'finished' }, response: 'finished' }))
      view.unmount()
    }
  })

  it('persists completed tool evidence before the pending model answer or cancellation', async () => {
    const checkpoint: NonNullable<ChatMessage['toolHistory']> = [
      {
        runId: 'owned-checkpoint-run',
        toolCallId: 'owned-checkpoint-call',
        toolName: 'files.write',
        args: { path: 'owned.txt', content: 'owned output' },
        status: 'completed',
        content: '{"path":"owned.txt","created":true}'
      }
    ]
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let pendingInput: { onEvent: (event: unknown) => void; signal: AbortSignal } | undefined
    let settle!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce((input) => {
      pendingInput = input
      return new Promise((resolve) => {
        settle = resolve
      })
    })
    const view = renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const sessionId = readCurrentSessionState()!.id
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'write a file' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(pendingInput).toBeDefined())
    try {
      const running = { ...checkpoint[0], status: 'running' as const, content: undefined }
      await act(async () => {
        pendingInput!.onEvent({
          type: 'tool-status',
          toolStatus: {
            runId: running.runId,
            toolCallId: running.toolCallId,
            toolName: running.toolName,
            status: 'running'
          },
          toolHistory: [running]
        })
      })
      await waitFor(() => {
        expect(readCurrentSessionState()?.messages.at(-1)?.toolHistory).toEqual([running])
      })
      await act(async () => {
        pendingInput!.onEvent({
          type: 'tool-status',
          toolStatus: {
            runId: 'owned-checkpoint-run',
            toolCallId: 'owned-checkpoint-call',
            toolName: 'files.write',
            status: 'completed'
          },
          toolHistory: checkpoint
        })
      })
      await waitFor(() => {
        const saved = hoisted.storedSessions.value.find((session) => session.id === sessionId)
        expect(saved?.messages.at(-1)?.toolHistory).toEqual(checkpoint)
        expect(saved?.messages.at(-1)?.content).toBe('')
      })
      // A late or foreign run snapshot cannot replace this run's completed evidence.
      await act(async () => {
        pendingInput!.onEvent({
          type: 'tool-status',
          toolStatus: {
            runId: 'owned-checkpoint-run',
            toolCallId: 'foreign-call',
            toolName: 'files.write',
            status: 'completed'
          },
          toolHistory: [
            {
              ...checkpoint[0],
              runId: 'foreign-run',
              toolCallId: 'foreign-call',
              content: 'FOREIGN_NOT_SAVED'
            }
          ]
        })
      })
      expect(JSON.stringify(hoisted.storedSessions.value)).not.toContain('FOREIGN_NOT_SAVED')
    } finally {
      await act(async () => {
        settle({
          result: { content: 'finished', metadata: { toolHistory: checkpoint } },
          response: 'finished'
        })
      })
      view.unmount()
    }
  })

  it('falls back from an expired streaming continuation before any output is emitted', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'stream-continuation-model',
        model_name: 'Stream Continuation Model',
        model_use: 'chat' as const,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'expired-stream-continuation',
      title: 'Expired stream continuation',
      profileId: 'stream-continuation-model',
      sessionUrl: 'expired-stream-session',
      sessionProfileId: 'stream-continuation-model',
      messages: []
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    hoisted.requestChatCompletionStreamMock.mockRejectedValueOnce(createExpiredContinuationError())
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(async (input) => {
      input.onEvent({ type: 'text-delta', delta: 'stream recovered' })
      input.onEvent({ type: 'done' })
      return { result: { content: 'stream recovered' }, response: 'stream recovered' }
    })

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'recover expired stream' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionStreamMock).toHaveBeenCalledTimes(2))
    expect(hoisted.requestChatCompletionStreamMock.mock.calls[1]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionStreamMock.mock.calls[1]?.[0].imageHistoryPolicy).toBe(
      'all'
    )
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBeUndefined())
  })

  it('does not automatically retry a generic failure with a continuation', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-model',
        model_name: 'Continuation Model',
        model_use: 'chat' as const,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'generic-continuation-failure',
      title: 'Generic continuation failure',
      profileId: 'continuation-model',
      sessionUrl: 'usable-session',
      sessionProfileId: 'continuation-model',
      sessionRouteFingerprint: 'local-continuation-model',
      messages: []
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    hoisted.requestChatCompletionMock.mockRejectedValueOnce(new Error('503 upstream unavailable'))

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'do not retry generically' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBe('usable-session'))
  })

  it('clears an expired continuation even when its one-shot recovery request also fails', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-model',
        model_name: 'Continuation Model',
        model_use: 'chat' as const,
        supports_session_continuation: true
      }
    ]
    const session: ChatSession = {
      id: 'failed-continuation-recovery',
      title: 'Failed continuation recovery',
      profileId: 'continuation-model',
      sessionUrl: 'expired-session',
      sessionProfileId: 'continuation-model',
      sessionRouteFingerprint: 'local-continuation-model',
      messages: []
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    hoisted.requestChatCompletionMock
      .mockRejectedValueOnce(createExpiredContinuationError())
      .mockRejectedValueOnce(new Error('503 recovery unavailable'))

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'failed recovery' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBeUndefined())
  })

  it('dispatches an 11-image historical request without a local image-count guard', async () => {
    const session: ChatSession = {
      id: 'too-many-history-images',
      title: 'Too many history images',
      profileId: 'vision-model',
      messages: Array.from({ length: 11 }, (_, index) => ({
        role: 'user' as const,
        content: `history ${index + 1}`,
        attachments: [createImageAttachment(`history-${index + 1}.png`)]
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'continue with all history' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const request = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as {
      messages?: ChatMessage[]
    }
    expect(
      request.messages?.flatMap((message) =>
        (message.attachments || []).filter((attachment) => attachment.type === 'image')
      )
    ).toHaveLength(11)
  })

  it('replays prior successful attachment chunks when no continuation is available', async () => {
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(1)
    hoisted.requestChatCompletionMock
      .mockResolvedValueOnce({ content: 'first' })
      .mockResolvedValueOnce({ content: 'second' })

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await dispatchNewSession({
      skillId: BUILT_IN_TAGGING_SKILL_ID,
      profileId: 'vision-model',
      initialMessage: 'Tag each image',
      initialAttachments: [
        createImageAttachment('stateless-1.png'),
        createImageAttachment('stateless-2.png')
      ]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    const secondCallMessages = hoisted.requestChatCompletionMock.mock.calls[1]?.[0]
      .messages as ChatMessage[]
    expect(secondCallMessages.some((message) => message.content === 'Tag each image')).toBe(true)
    expect(
      secondCallMessages.some((message) =>
        message.attachments?.some((attachment) => attachment.fileName === 'stateless-1.png')
      )
    ).toBe(true)
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].imageHistoryPolicy).toBe('all')
  })

  it('does not consume a candidate continuation when malformed batch output falls back to singles', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-vision-model',
        model_name: 'Continuation Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true,
        supports_session_continuation: true
      }
    ]
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(2)
    hoisted.requestChatCompletionMock
      .mockResolvedValueOnce({ content: 'malformed', sessionUrl: 'discard-me' })
      .mockResolvedValueOnce({ content: 'first-single', sessionUrl: 'accepted-single-1' })
      .mockResolvedValueOnce({ content: 'second-single', sessionUrl: 'accepted-single-2' })

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await dispatchNewSession({
      skillId: BUILT_IN_TAGGING_SKILL_ID,
      profileId: 'continuation-vision-model',
      initialMessage: 'Tag fallback images',
      initialAttachments: [
        createImageAttachment('fallback-1.png'),
        createImageAttachment('fallback-2.png')
      ]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3))
    expect(hoisted.requestChatCompletionMock.mock.calls[1]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionMock.mock.calls[2]?.[0].sessionUrl).toBe(
      'accepted-single-1'
    )
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBe('accepted-single-2'))
  })

  it('replays all history again when an attachment chunk fails before a continuation is returned', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'continuation-vision-model',
        model_name: 'Continuation Vision Model',
        model_use: 'vision' as const,
        is_vision_model: true,
        supports_session_continuation: true
      }
    ]
    hoisted.resolveAttachmentBatchCapabilityMock.mockResolvedValue(2)
    hoisted.requestChatCompletionMock.mockRejectedValueOnce(new Error('chunk failed'))

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await dispatchNewSession({
      skillId: BUILT_IN_TAGGING_SKILL_ID,
      profileId: 'continuation-vision-model',
      initialMessage: 'Tag each image',
      initialAttachments: [
        createImageAttachment('failed-1.png'),
        createImageAttachment('failed-2.png')
      ]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].sessionUrl).toBeUndefined()
    expect(hoisted.requestChatCompletionMock.mock.calls[0]?.[0].imageHistoryPolicy).toBe('all')
    await waitFor(() => expect(readCurrentSessionState()?.sessionUrl).toBeUndefined())
  })

  it('persists duplicate blob image URLs once and uses durable URLs for history and one request', async () => {
    const fetchMock = vi.fn(async () => ({
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', { ...URL, revokeObjectURL })
    hoisted.storedSessions.value = [
      {
        id: 'session-duplicate-blob-user-image',
        title: 'Duplicate blob user image',
        profileId: 'vision-model',
        messages: []
      }
    ]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      'session-duplicate-blob-user-image'
    )

    renderChatPage()
    await waitFor(() =>
      expect(readCurrentSessionState()?.id).toBe('session-duplicate-blob-user-image')
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: 'runtime-flow',
            autoSend: true,
            text: 'describe both',
            attachments: [
              {
                type: 'image',
                url: 'blob:duplicate-user-upload',
                fileName: 'first.png',
                mimeType: 'image/png'
              },
              {
                type: 'image',
                url: 'blob:duplicate-user-upload',
                fileName: 'second.png',
                mimeType: 'image/png'
              }
            ]
          }
        })
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('blob:duplicate-user-upload')
    expect(hoisted.saveImageToDirMock).toHaveBeenCalledTimes(1)
    expect(revokeObjectURL).not.toHaveBeenCalled()

    const durableUrl = 'file://C:/MagicPot/AutoSave/Agent/chat_upload.png'
    expect(readCurrentSessionState()?.messages[0]?.attachments?.map((item) => item.url)).toEqual([
      durableUrl,
      durableUrl
    ])
    for (const call of hoisted.requestChatCompletionMock.mock.calls) {
      const requestMessages = call[0]?.messages as ChatMessage[] | undefined
      const requestAttachments = requestMessages?.at(-1)?.attachments ?? []
      expect(requestAttachments.length).toBeGreaterThan(0)
      expect(requestAttachments.every((item) => !item.url.startsWith('blob:'))).toBe(true)
      expect(requestAttachments.every((item) => item.url === durableUrl)).toBe(true)
    }
  })

  it('preserves blob image URLs when outgoing persistence fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ blob: async () => new Blob(['image'], { type: 'image/png' }) }))
    )
    hoisted.saveImageToDirMock.mockResolvedValueOnce({ savedPath: null })

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: 'runtime-flow',
            autoSend: true,
            text: 'send despite persistence failure',
            attachments: [
              {
                type: 'image',
                url: 'blob:failed-user-upload',
                fileName: 'failed.png',
                mimeType: 'image/png'
              }
            ]
          }
        })
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(readCurrentSessionState()?.messages[0]?.attachments?.[0]?.url).toBe(
      'blob:failed-user-upload'
    )
    const requestMessages = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
      ?.messages as ChatMessage[]
    expect(requestMessages.at(-1)?.attachments?.[0]?.url).toBe('blob:failed-user-upload')
  })

  it('leaves durable outgoing image URLs unchanged', async () => {
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: 'runtime-flow',
            autoSend: true,
            text: 'durable image',
            attachments: [
              {
                type: 'image',
                url: 'file://C:/MagicPot/existing.png',
                fileName: 'existing.png',
                mimeType: 'image/png'
              }
            ]
          }
        })
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.saveImageToDirMock).not.toHaveBeenCalled()
    expect(readCurrentSessionState()?.messages[0]?.attachments?.[0]?.url).toBe(
      'file://C:/MagicPot/existing.png'
    )
    const requestMessages = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
      ?.messages as ChatMessage[]
    expect(requestMessages.at(-1)?.attachments?.[0]?.url).toBe('file://C:/MagicPot/existing.png')
  })

  it('offers manual thread goal records for the current local canvas session without dispatch', async () => {
    const first: ChatSession = { id: 'goal-session-first', title: 'First', profileId: 'base-model', messages: [] }
    const second: ChatSession = { id: 'goal-session-second', title: 'Second', profileId: 'base-model', messages: [] }
    hoisted.storedSessions.value = [first, second]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), first.id)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(first.id))
      expect(hoisted.agentGoalScopeRevisionMock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      expect(await screen.findByText('No goals yet.')).toBeVisible()
      const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'runtime-project', threadId: 'runtime-pane' }
      expect(hoisted.listAgentGoalsMock).toHaveBeenCalledWith({ route, conversationId: first.id, documentToken: 'goal-document' })
      expect(screen.getByText('Manual records only. Activating a goal does not run a model or grant permissions.')).toBeVisible()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      await dispatchSwitchSession(second.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(second.id))
      expect(screen.queryByLabelText('Thread goals')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Goals' }))
      await waitFor(() => expect(hoisted.listAgentGoalsMock).toHaveBeenCalledWith({ route, conversationId: second.id, documentToken: 'goal-document' }))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it.each(['remote', 'inactive', 'no-route', 'archived'] as const)('hides manual goal records for %s', async mode => {
    if (mode === 'remote') hoisted.currentConfig.value!.use_remote_llm = true
    const session: ChatSession = { id: 'goal-ineligible', title: 'Ineligible', messages: [], archived: mode === 'archived' }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const route = mode === 'no-route' ? undefined : { channel: 'canvas' as const, scopeType: 'thread' as const, scopeId: 'runtime-project', threadId: 'runtime-pane' }
    const page = renderWithProviders(<ChatPage compact active={mode !== 'inactive'} storageScope="runtime-flow" route={route} />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      expect(screen.queryByRole('button', { name: 'Goals' })).not.toBeInTheDocument()
      expect(hoisted.agentGoalScopeRevisionMock).not.toHaveBeenCalled()
      expect(hoisted.setAgentGoalScopeMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('renders one model and reasoning selector in the composer, not the workspace card', async () => {
    renderChatPage()

    const composer = await screen.findByTestId('chat-composer-mock')
    const workspaceControlsPortal = document.getElementById(
      buildChatWorkspaceControlsPortalId('runtime-flow')
    )
    expect(workspaceControlsPortal).not.toBeNull()
    expect(within(workspaceControlsPortal as HTMLElement).queryByTestId('chat-primary-selection-mock')).toBeNull()
    expect(screen.queryByTestId('chat-top-context-controls')).toBeNull()
    expect(within(composer).getByTestId('chat-primary-selection-mock')).toBeInTheDocument()
    expect(screen.getAllByTestId('chat-primary-selection-mock')).toHaveLength(1)
  })

  it('shows the effective inherited member model without changing either session on selection', async () => {
    const lead: ChatSession = { id: 'composer-model-lead', title: 'Lead', profileId: 'base-model', messages: [] }
    const member: ChatSession = { id: 'composer-model-writer', title: '文案', teamLeadId: lead.id, teamMemberName: '文案', teamRole: '文案', profileId: 'vision-model', messages: [] }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.click(screen.getByRole('button', { name: '打开 文案' }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      expect(screen.getByTestId('chat-member-model-mock')).toHaveTextContent('inherited:GPT-4o')
      expect(screen.queryByTestId('select-vision-model')).not.toBeInTheDocument()
      expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.profileId).toBe('base-model')
      fireEvent.click(screen.getByRole('button', { name: /返回组长/ }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      expect(screen.getByTestId('chat-primary-selection-value')).toHaveTextContent('base-model')
    } finally {
      page.unmount()
    }
  })

  it('passes only current member-selectable model IDs to the composer in their original order', async () => {
    const lead: ChatSession = { id: 'selectable-lead', title: 'Lead', profileId: 'base-model', messages: [] }
    const member: ChatSession = { id: 'selectable-writer', title: 'writer', teamLeadId: lead.id, teamMemberName: 'writer', messages: [] }
    hoisted.storedSessions.value = [lead, member]
    hoisted.availableProfiles.value = [
      { id: 'base-model', model_name: 'Lead', model_use: 'chat' },
      { id: 'hunyuan3d-pro', model_name: '3D fixture', model_use: 'chat' },
      { id: 'vision-model', model_name: 'Member', model_use: 'vision', is_vision_model: true }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      expect(JSON.parse(screen.getByTestId('selectable-member-profile-ids').textContent || 'null')).toEqual(['base-model', 'vision-model'])
      fireEvent.click(screen.getByTestId('forge-member-3d-model'))
      await act(async () => { await Promise.resolve() })
      expect(hoisted.storedSessions.value.find(item => item.id === member.id)?.memberModelChoice).toBeUndefined()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('selects a model for the current member without altering the lead or another member', async () => {
    const lead: ChatSession = { id:'choice-lead', title:'Lead', messages:[], profileId:'base-model' }
    const writer: ChatSession = { id:'choice-writer', title:'文案', messages:[], teamLeadId:lead.id, teamMemberName:'文案', profileId:'base-model' }
    const designer: ChatSession = { id:'choice-designer', title:'设计师', messages:[], teamLeadId:lead.id, teamMemberName:'设计师', profileId:'base-model' }
    hoisted.storedSessions.value = [lead, writer, designer]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.click(screen.getByRole('button', {name:'打开 文案'}))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(writer.id))
      fireEvent.click(screen.getByTestId('select-member-vision-model'))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === writer.id)?.memberModelChoice).toEqual({version:1, profileId:'vision-model'}))
      await waitFor(() => expect(screen.getByTestId('chat-member-model-mock')).toHaveTextContent('selected:Vision Model'))
      expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.profileId).toBe('base-model')
      expect(hoisted.storedSessions.value.find(item => item.id === designer.id)?.memberModelChoice).toBeUndefined()
      fireEvent.click(screen.getByRole('button', {name:'打开 设计师'}))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(designer.id))
      expect(screen.getByTestId('chat-member-model-mock')).toHaveTextContent('inherited:GPT-4o')
      fireEvent.click(screen.getByRole('button', {name:'打开 文案'}))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(writer.id))
      expect(screen.getByTestId('chat-member-model-mock')).toHaveTextContent('selected:Vision Model')
    } finally { page.unmount() }
  })

  it('requires branch confirmation and preserves original without generation', async () => {
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const original = readCurrentSessionState()!
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target:{value:'/branch'} })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(screen.getByTestId('replay-confirmation')).toBeVisible())
    expect(readCurrentSessionState()?.id).toBe(original.id)
    fireEvent.click(screen.getByRole('button',{name:'Create separate conversation'}))
    await waitFor(()=>expect(readCurrentSessionState()?.id).not.toBe(original.id))
    expect(readCurrentSessionState()?.messages).toEqual(original.messages)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it.each([['/regen','original replay text'],['/edit 1 replacement','replacement']])('opens %s as an unsent separate draft and preserves original messages', async (command, expectedDraft) => {
    renderChatPage()
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'original replay text'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(readCurrentSessionState()?.messages.some(message=>message.role==='assistant')).toBe(true))
    await waitFor(()=>expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(()=>expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
    const original = structuredClone(readCurrentSessionState()!)
    hoisted.requestChatCompletionMock.mockClear()
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:command}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(screen.getByTestId('replay-confirmation')).toBeVisible())
    fireEvent.click(screen.getByRole('button',{name:'Create separate conversation'}))
    await waitFor(()=>expect(readCurrentSessionState()?.id).not.toBe(original.id))
    await waitFor(()=>expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(expectedDraft))
    expect(readCurrentSessionState()?.sessionUrl).toBeUndefined()
    expect(readCurrentSessionState()?.messages).toHaveLength(0)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('cancels edit confirmation without creating a conversation or sending', async () => {
    renderChatPage()
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'editable original'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(readCurrentSessionState()?.messages.some(message=>message.role==='assistant')).toBe(true))
    const original = structuredClone(readCurrentSessionState()!)
    hoisted.requestChatCompletionMock.mockClear()
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'/edit 1 replacement'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(screen.getByTestId('replay-confirmation')).toBeVisible())
    fireEvent.click(screen.getByRole('button',{name:'Cancel replay'}))
    expect(screen.queryByTestId('replay-confirmation')).toBeNull()
    expect(readCurrentSessionState()?.id).toBe(original.id)
    expect(readCurrentSessionState()?.messages).toEqual(original.messages)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('rejects stale branch confirmation after the source history changes', async () => {
    renderChatPage()
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBeTruthy())
    const originalId = readCurrentSessionState()!.id
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'/branch'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(screen.getByTestId('replay-confirmation')).toBeVisible())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'new source turn'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(readCurrentSessionState()?.messages.some(message=>message.role==='assistant')).toBe(true))
    fireEvent.click(screen.getByRole('button',{name:'Create separate conversation'}))
    expect(readCurrentSessionState()?.id).toBe(originalId)
    expect(screen.queryByTestId('replay-confirmation')).toBeNull()
  })
  it.each([
    { designerName: 'designer', writerName: 'writer' },
    { designerName: '设计师', writerName: '文案' }
  ])('runs a mock two-member team ($designerName / $writerName) through actual chat dispatch, canvas placement and lead summary', async ({ designerName, writerName }) => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    const fetchGuard = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === 'data:image/png;base64,QQ==') return { blob: async () => new Blob(['A'], { type: 'image/png' }) } as Response
      throw new Error('network forbidden')
    })
    // A prior test may have stubbed fetch with a vi.fn: spyOn can reuse its call history.
    // Keep the no-network check, but scope it to calls made during this scenario.
    fetchGuard.mockClear()
    const placements: Array<{ src: string; projectId: string; generationSessionId: string }> = []
    const onCanvasImage = (event: Event) => {
      const detail = (event as CustomEvent).detail
      placements.push(detail)
      detail.onAdded({ id: 'fixture-image', type: 'image' })
    }
    window.addEventListener('canvas:add-image', onCanvasImage)
    let approveWriter!: (approved: boolean) => void
    let writerId = ''
    let writerReturned = false
    hoisted.listPendingApprovalsMock.mockReset().mockResolvedValue({ approvals: [] })
    hoisted.resolvePendingApprovalMock.mockReset().mockImplementation(async (input: { approved: boolean }) => {
      hoisted.listPendingApprovalsMock.mockResolvedValue({ approvals: [] })
      approveWriter(input.approved)
      return {}
    })
    try {
      hoisted.requestChatCompletionMock.mockImplementation(async ({ messages }: { messages: ChatMessage[] }) => {
        const text = String(messages.at(-1)?.content ?? '')
        if (text.includes('设计海报')) return { content: '设计结果', attachments: [{ type: 'image', url: 'data:image/png;base64,QQ==', mimeType: 'image/png' }] }
        if (text.includes('撰写文案')) {
          const allowed = await new Promise<boolean>(resolve => {
            approveWriter = resolve
            hoisted.listPendingApprovalsMock.mockResolvedValue({ approvals: [{ approvalId: 'writer-tool', revision: 3, request: { request: {
              sessionId: writerId, route: { channel: 'canvas', scopeType: 'thread', scopeId: 'runtime-project', threadId: 'runtime-pane' },
              target: { id: 'shell.execute' }, input: { command: 'echo fixture' }
            } } }] })
          })
          writerReturned = true
          return { content: allowed ? '文案结果' : '文案已拒绝' }
        }
        if (text.includes('汇总团队结果')) return { content: '汇总：设计结果和文案结果' }
        throw new Error(`Unexpected fixture request: ${text}`)
      })
      localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
      renderChatPage({ team: true })
      await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('base-model'))
      const lead = readCurrentSessionState()!.id
      for (const [name, role, count] of [[designerName, '设计师', '1'], [writerName, '文案', '2']] as const) {
        if (count === '1') {
          chooseAddMenuEntry('chat-composer-menu-add-member')
        } else {
          await openTeamManagement()
          fireEvent.click(screen.getByRole('button', { name: '组建团队 / 添加成员' }))
        }
        fireEvent.change(screen.getByLabelText('成员名'), { target: { value: name } })
        fireEvent.change(screen.getByLabelText('角色 / 当前任务'), { target: { value: role } })
        fireEvent.click(screen.getByRole('button', { name: '确认创建成员' }))
        await waitFor(() => expect(screen.getByRole('region', { name: '进程区' })).toHaveTextContent(`成员 ${count}`))
      }
      const designer = hoisted.storedSessions.value.find(session => session.teamMemberName === designerName)!
      const writer = hoisted.storedSessions.value.find(session => session.teamMemberName === writerName)!
      writerId = writer.id
      expect(designer).toMatchObject({ teamLeadId: lead, teamRole: '设计师', messages: [] })
      expect(writer).toMatchObject({ teamLeadId: lead, teamRole: '文案', messages: [] })
      const send = (value: string) => {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      }
      send(`@${designerName} 设计海报`)
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].teamMember).toEqual({scope:'runtime-flow',thread:'runtime-pane',lead,member:designer.id})
      await waitFor(() => expect(placements).toEqual([expect.objectContaining({ src: 'data:image/png;base64,QQ==', projectId: 'runtime-project', generationSessionId: designer.id })]))
      await waitFor(() => expect(hoisted.storedSessions.value.find(session => session.id === designer.id)?.messages.some(message => message.content === '设计结果')).toBe(true))
      send(`@${writerName} 撰写文案`)
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      expect(hoisted.requestChatCompletionMock.mock.calls[1][0].teamMember).toEqual({scope:'runtime-flow',thread:'runtime-pane',lead,member:writer.id})
      expect(writerReturned).toBe(false)
      expect(hoisted.storedSessions.value.find(session => session.id === writer.id)?.messages.some(message => message.content === '文案结果')).toBe(false)
      const approvalView = renderWithProviders(<MagicAgentApprovalCenter />)
      try {
        expect(await screen.findByText(`${writerName} 请求操作`)).toBeVisible()
        expect(screen.getByText('shell.execute')).toBeVisible()
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
        const inlineApproval = screen.getByTestId('team-inline-approvals')
        expect(within(inlineApproval).getByRole('button', { name: '批准' })).toBeVisible()
        expect(within(inlineApproval).getByRole('button', { name: '拒绝' })).toBeVisible()
        const processArea = screen.getByRole('region', { name: '进程区' })
        await waitFor(() => expect(within(processArea).getByRole('button', { name: `打开 ${writerName}` })).toHaveTextContent('待审批'))
        expect(within(processArea).getByRole('button', { name: `停止 ${writerName}` })).toBeVisible()
        expect(inlineApproval).toBeInTheDocument()
        expect(processArea.contains(inlineApproval)).toBe(false)
        expect(fetchGuard.mock.calls.map(([input]) => input).filter(input => input !== 'data:image/png;base64,QQ==')).toEqual([])
        fireEvent.click(screen.getByRole('button', { name: '批准' }))
        await waitFor(() => expect(hoisted.resolvePendingApprovalMock).toHaveBeenCalledWith({ approvalId: 'writer-tool', expectedRevision: 3, approved: true }))
      } finally { approvalView.unmount() }
      await waitFor(() => expect(hoisted.storedSessions.value.find(session => session.id === writer.id)?.messages.some(message => message.content === '文案结果')).toBe(true))
      expect(writerReturned).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: `打开 ${designerName}` }))
      await waitFor(() => expect(readCurrentSessionState()?.messages.some(message => message.content === '设计结果')).toBe(true))
      fireEvent.click(screen.getByRole('button', { name: `打开 ${writerName}` }))
      await waitFor(() => expect(readCurrentSessionState()?.messages.some(message => message.content === '文案结果')).toBe(true))
      fireEvent.click(screen.getByRole('button', { name: /返回组长/ }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead))
      send('汇总团队结果')
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3))
      const leadMessages = hoisted.requestChatCompletionMock.mock.calls[2][0].messages as ChatMessage[]
      expect(hoisted.requestChatCompletionMock.mock.calls[2][0]).not.toHaveProperty('teamMember')
      const leadRequest = leadMessages.find(message => message.role === 'user' && message.content === '汇总团队结果')
      expect(leadRequest?.hiddenContext).toContain('设计结果')
      expect(leadRequest?.hiddenContext).toContain('文案结果')
      await waitFor(() => expect(readCurrentSessionState()?.messages.some(message => message.content === '汇总：设计结果和文案结果')).toBe(true))
      await waitFor(() => expect(hoisted.storedSessions.value.find(session => session.id === lead)?.messages.some(message => message.content === '汇总：设计结果和文案结果')).toBe(true))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3)
    } finally {
      fetchGuard.mockRestore()
      window.removeEventListener('canvas:add-image', onCanvasImage)
    }
  })

  it.each(['single', 'all'] as const)('exposes team %s stop while a queued composer item is in preflight', async mode => {
    const lead: ChatSession = { id: `preflight-stop-${mode}-lead`, title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: `preflight-stop-${mode}-member`, title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const fetchBlocked = vi.fn(async () => { throw new Error('Unexpected network access') })
    vi.stubGlobal('fetch', fetchBlocked)
    let finish!: (value: { content: string }) => void
    let release!: () => void
    const running = new Promise<{ content: string }>(resolve => { finish = resolve })
    const gate = { entered: false, gate: new Promise<void>(resolve => { release = resolve }) }
    hoisted.requestChatCompletionMock.mockImplementation(() => running)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Alice active request' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      fireEvent.click(screen.getByRole('button', { name: '打开 Alice' }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'queued preflight text' } })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued preflight text'))
      hoisted.teamPreflightReadGate.value = gate
      await act(async () => finish({ content: 'first synthetic response' }))
      await waitFor(() => expect(gate.entered).toBe(true), { timeout: 2000 })
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('正在准备'))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      const stop = screen.getByRole('button', { name: mode === 'single' ? '停止 Alice' : '全部停止成员' })
      expect(stop).toBeVisible()
      expect(stop).toBeEnabled()
      fireEvent.click(stop)
      hoisted.teamPreflightReadGate.value = null
      await act(async () => release())
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('未发送 · 已暂停'))
      expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued preflight text')
      expect(readCurrentSessionState()?.messages.some(message => message.role === 'user' && message.content === 'queued preflight text')).toBe(false)
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(fetchBlocked).not.toHaveBeenCalled()
    } finally {
      hoisted.teamPreflightReadGate.value = null
      release()
      finish({ content: 'synthetic cleanup' })
      page.unmount()
      vi.unstubAllGlobals()
    }
  })

  it.each(['single', 'all'] as const)('preserves an unstarted ordinary composer queue on team %s stop without overwriting a new draft', async (mode) => {
    const lead: ChatSession = { id: `safe-stop-${mode}-lead`, title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: `safe-stop-${mode}-member`, title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const fetchBlocked = vi.fn(async () => { throw new Error('Unexpected network access') })
    vi.stubGlobal('fetch', fetchBlocked)
    let finish!: (value: { content: string }) => void
    const running = new Promise<{ content: string }>(resolve => { finish = resolve })
    let signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementation(({ signal: requestSignal }: { signal: AbortSignal }) => {
      signal = requestSignal
      return running
    })
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Alice running' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(signal).toBeDefined())
      fireEvent.click(screen.getByRole('button', { name: '打开 Alice' }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'unstarted queued text' } })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('unstarted queued text'))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'newer unsent draft' } })
      fireEvent.click(screen.getByRole('button', { name: mode === 'single' ? '停止 Alice' : '全部停止成员' }))
      expect(signal?.aborted).toBe(true)
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('未发送 · 已暂停'))
      expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('unstarted queued text')
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      fireEvent.click(within(screen.getByTestId('chat-queue-item')).getByRole('button', { name: 'chat.queue_edit' }))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('newer unsent draft')
      expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('unstarted queued text')
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(fetchBlocked).not.toHaveBeenCalled()
    } finally {
      finish({ content: 'synthetic cleanup' })
      page.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('stops both running members and drops their queued sends from the team status bar', async () => {
    const lead: ChatSession = { id: 'stop-all-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const alice: ChatSession = { id: 'stop-all-alice', title: 'Alice', messages: [], teamLeadId: lead.id, teamMemberName: 'Alice' }
    const bob: ChatSession = { id: 'stop-all-bob', title: 'Bob', messages: [], teamLeadId: lead.id, teamMemberName: 'Bob' }
    hoisted.storedSessions.value = [lead, alice, bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const signals = new Map<string, AbortSignal>()
    hoisted.requestChatCompletionMock.mockImplementation(({ conversationId, signal }: { conversationId: string; signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signals.set(conversationId, signal)
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      for (const name of ['Alice', 'Bob']) {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: `@${name} running` } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
        await waitFor(() => expect(signals.has(name === 'Alice' ? alice.id : bob.id)).toBe(true))
      }
      await waitFor(() => expect(screen.getByRole('region', { name: '进程区' })).toHaveTextContent('运行项 2'))
      for (const member of [alice, bob]) {
        fireEvent.click(screen.getByRole('button', { name: `打开 ${member.teamMemberName}` }))
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: `queued for ${member.teamMemberName}` } })
        fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
        await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent(`queued for ${member.teamMemberName}`))
      }
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2)
      fireEvent.click(screen.getByRole('button', { name: '全部停止成员' }))
      expect(signals.get(alice.id)?.aborted).toBe(true)
      expect(signals.get(bob.id)?.aborted).toBe(true)
      await waitFor(() => expect(screen.getByRole('region', { name: '进程区' })).toHaveTextContent('运行项 0'))
      expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '打开 Alice' }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(alice.id))
      expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2)
    } finally { page.unmount() }
  })

  it('creates a member with empty history and switches back to its lead without enabling execution', async () => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('base-model'))
    const lead = readCurrentSessionState()!.id
    chooseAddMenuEntry('chat-composer-menu-add-member')
    fireEvent.change(screen.getByLabelText('成员名'), { target: { value: 'writer' } })
    fireEvent.change(screen.getByLabelText('角色 / 当前任务'), { target: { value: 'write notes' } })
    fireEvent.click(screen.getByRole('button', { name: '确认创建成员' }))
    await waitFor(() => expect(screen.getByRole('region', { name: '进程区' })).toHaveTextContent('成员 1'))
    const committed = hoisted.storedSessions.value.find(session => session.teamMemberName === 'writer')
    expect(committed).toMatchObject({ teamLeadId: lead, messages: [] })
    fireEvent.click(screen.getByRole('button', { name: '打开 writer' }))
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(committed?.id))
    expect(readCurrentSessionState()?.messages).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: /返回组长/ }))
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('creates a team member, switches within the same column and returns to lead', async () => {
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE,'runtime-flow'),'base-model')
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.profileId).toBe('base-model'))
    const lead=readCurrentSessionState()!.id
    chooseAddMenuEntry('chat-composer-menu-add-member')
    fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'writer'}})
    fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'write notes'}})
    fireEvent.click(screen.getByRole('button',{name:'确认创建成员'}))
    await waitFor(()=>expect(screen.getByRole('region', { name: '进程区' })).toHaveTextContent('成员 1'))
    expect(readCurrentSessionState()?.id).toBe(lead)
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@writer write a short note'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.requestChatCompletionMock).toHaveBeenCalled())
    expect(readCurrentSessionState()?.id).toBe(lead)
    expect(readCurrentSessionState()?.messages).toHaveLength(0)
    fireEvent.click(screen.getByRole('button',{name:'打开 writer'}))
    await waitFor(()=>expect(readCurrentSessionState()?.teamLeadId).toBe(lead))
    await waitFor(()=>expect(readCurrentSessionState()?.messages.some(message=>message.content==='write a short note')).toBe(true))
    fireEvent.click(screen.getByRole('button',{name:/返回组长/}))
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead))
  })
  async function openTeamManagement() {
    await waitFor(() => expect(readCurrentSessionState()).toBeDefined())
    const current = readCurrentSessionState()
    const hasMembers = !current?.teamEnded && hoisted.storedSessions.value.some(session => session.teamLeadId === current?.id && !session.archived)
    fireEvent.click(screen.getByRole('button', { name: 'open-add-menu' }))
    fireEvent.click(hasMembers ? await screen.findByTestId('chat-composer-menu-team') : screen.getByTestId('chat-composer-menu-team'))
    await screen.findByRole('dialog', { name: '团队管理' })
  }

  it.each([
    { label: '频道消息', text: 'local channel entry', button: '添加到频道记录', field: 'teamChannel' as const },
    { label: '任务', text: 'local task entry', button: '添加任务', field: 'teamTasks' as const }
  ])('persists $field after changing the lead model while retaining stale team default', async ({ label, text, button, field }) => {
    const lead: ChatSession = { id: 'model-change-local-record', title: 'Lead', messages: [], profileId: 'base-model', teamSettings: { maxMembers: 6, defaultModel: 'base-model', autoCleanup: false } }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('base-model'))
    fireEvent.click(screen.getByTestId('select-vision-model'))
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('vision-model'))
    await waitFor(() => expect(hoisted.storedSessions.value.find(s => s.id === lead.id)?.profileId).toBe('vision-model'))
    expect(readCurrentSessionState()?.teamSettings?.defaultModel).toBe('base-model')
    await openTeamManagement()
    fireEvent.change(screen.getByLabelText(label), { target: { value: text } })
    expect(screen.getByLabelText(label)).toHaveValue(text)
    fireEvent.click(screen.getByRole('button', { name: button }))
    await waitFor(() => {
      const stored = hoisted.storedSessions.value.find(s => s.id === lead.id)
      if (field === 'teamChannel') expect(stored?.teamChannel).toEqual(expect.arrayContaining([expect.objectContaining({ text })]))
      else expect(stored?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: text })]))
    })
  })

  it.each([
    { label: '任务', text: 'keep pending task', button: '添加任务', field: 'teamTasks' as const },
    { label: '频道消息', text: 'keep pending channel', button: '添加到频道记录', field: 'teamChannel' as const }
  ])('retains $field draft until CAS succeeds and keeps it on conflict', async ({ label, text, button, field }) => {
    const lead: ChatSession = { id: 'team-draft-save-race', title: 'Lead', profileId: 'base-model', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    await openTeamManagement()
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: text } })
    let release!: () => void
    hoisted.saveSessionToDBGateStarted.value = null
    hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { release = resolve })
    try {
      fireEvent.click(screen.getByRole('button', { name: button }))
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(lead.id))
      expect(input).toHaveValue(text)
      const external = cloneValue(hoisted.storedSessions.value.find(s => s.id === lead.id)!)
      external.title = 'External change'
      hoisted.storedSessions.value = [external]
      await act(async () => { hoisted.saveSessionToDBGate.value = null; release() })
      await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('无法保存团队设置'))
      expect(input).toHaveValue(text)
      const stored = hoisted.storedSessions.value.find(s => s.id === lead.id)
      expect(stored?.title).toBe('External change')
      expect(stored?.[field]).toBeUndefined()
      expect(screen.getByText(new RegExp(`${text}.*未确认|未确认.*${text}`))).toBeVisible()
      expect(screen.getByRole('button', { name: button })).toBeDisabled()
      expect(readCurrentSessionState()?.[field]?.length).toBe(1)
    } finally {
      release?.()
      hoisted.saveSessionToDBGate.value = null
    }
  })

  it.each([
    { label: '任务', text: 'successful task draft', button: '添加任务', field: 'teamTasks' as const },
    { label: '频道消息', text: 'successful channel draft', button: '添加到频道记录', field: 'teamChannel' as const }
  ])('clears $field draft only after successful CAS', async ({ label, text, button, field }) => {
    const lead: ChatSession = { id: 'team-draft-success', title: 'Lead', profileId: 'base-model', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    await openTeamManagement()
    const input = screen.getByLabelText(label)
    fireEvent.change(input, { target: { value: text } })
    let release!: () => void
    hoisted.saveSessionToDBGateStarted.value = null
    hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { release = resolve })
    try {
      fireEvent.click(screen.getByRole('button', { name: button }))
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(lead.id))
      expect(input).toHaveValue(text)
      await act(async () => { hoisted.saveSessionToDBGate.value = null; release() })
      await waitFor(() => {
        const stored = hoisted.storedSessions.value.find(s => s.id === lead.id)
        if (field === 'teamTasks') expect(stored?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: text })]))
        else expect(stored?.teamChannel).toEqual(expect.arrayContaining([expect.objectContaining({ text })]))
      })
      await waitFor(() => expect(input).toHaveValue(''))
    } finally {
      release?.()
      hoisted.saveSessionToDBGate.value = null
    }
  })

  it('keeps the new scope task draft when an older scope task save acknowledges after commit', async () => {
    const scopeA = 'runtime-flow', scopeB = 'team-scope-b', id = 'same-team-lead'
    const leadA: ChatSession = { id, title: 'Lead A', profileId: 'base-model', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    const leadB: ChatSession = { ...leadA, title: 'Lead B' }
    hoisted.scopedTestSessions.value = { [scopeA]: [leadA], [scopeB]: [leadB] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scopeA), id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scopeB), id)
    const route = { channel: 'canvas' as const, scopeType: 'thread' as const, scopeId: 'runtime-project', threadId: 'runtime-pane' }
    const page = renderChatPage({ team: true })
    let release!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Lead A'))
      await openTeamManagement()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: 'scope A task' } })
      hoisted.teamPostCommitGate.value = new Promise<void>(resolve => { release = resolve })
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      await waitFor(() => expect(hoisted.teamPostCommitSnapshot.value?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })])))
      expect(hoisted.scopedTestSessions.value?.[scopeA][0].teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })]))
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scopeB} route={route} /></ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Lead B'))
      if (!screen.queryByLabelText('任务')) await openTeamManagement()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: 'scope B draft' } })
      await act(async () => { hoisted.teamPostCommitGate.value = null; release() })
      expect(screen.getByLabelText('任务')).toHaveValue('scope B draft')
      expect(hoisted.scopedTestSessions.value?.[scopeB][0].teamTasks).toBeUndefined()
      expect(hoisted.scopedTestSessions.value?.[scopeA][0].teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })]))
      expect(readCurrentSessionState()?.title).toBe('Lead B')
    } finally {
      release?.()
      hoisted.teamPostCommitGate.value = null
      page.unmount()
    }
  })

  it('keeps the committed A task and B isolated after A-B-A and a delayed mock save, then retries', async () => {
    const a = 'ack-scope-a', b = 'ack-scope-b', id = 'ack-shared-id'
    const leadA: ChatSession = { id, title: 'Ack A', profileId: 'base-model', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    const leadB: ChatSession = { ...leadA, title: 'Ack B' }
    hoisted.scopedTestSessions.value = { [a]: [leadA], [b]: [leadB] }
    let aReads = 0, releaseStale!: (value: ChatSession[]) => void
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => {
      if (scope === a && ++aReads === 2) return new Promise<ChatSession[]>(resolve => { releaseStale = resolve })
      return cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? [])
    })
    for (const scope of [a, b]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), id)
    const route = { channel: 'canvas' as const, scopeType: 'thread' as const, scopeId: 'runtime-project', threadId: 'runtime-pane' }
    const ui = (scope: string) => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} route={route}/></ThemeProvider></MemoryRouter>
    const page = render(ui(a))
    let releaseWrite!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Ack A'))
      await openTeamManagement()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: 'scope A task' } })
      hoisted.teamPostCommitGate.value = new Promise<void>(resolve => { releaseWrite = resolve })
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      await waitFor(() => expect(hoisted.teamPostCommitSnapshot.value?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })])))
      page.rerender(ui(b))
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('Ack B'))
      page.rerender(ui(a))
      await waitFor(() => expect(releaseStale).toBeDefined())
      await act(async () => { hoisted.teamPostCommitGate.value = null; releaseWrite() })
      await act(async () => releaseStale([cloneValue(leadA)]))
      await waitFor(() => expect(screen.getByText('This thread has unsaved changes. Retry saving before closing it.')).toBeVisible())
      expect(hoisted.scopedTestSessions.value?.[b][0].teamTasks).toBeUndefined()
      expect(hoisted.scopedTestSessions.value?.[a][0].teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })]))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(readCurrentSessionState()?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })])))
      await waitFor(() => expect(screen.queryByText('This thread has unsaved changes. Retry saving before closing it.')).not.toBeInTheDocument())
      expect(hoisted.scopedTestSessions.value?.[b][0].teamTasks).toBeUndefined()
    } finally {
      hoisted.teamPostCommitGate.value = null
      releaseWrite?.()
      page.unmount()
    }
  })

  it('retains a newer A task and rejects an external A change during delayed mock save acknowledgement', async () => {
    const a = 'ack-external-a', b = 'ack-external-b', id = 'ack-external-id'
    const leadA: ChatSession = { id, title: 'External A', profileId: 'base-model', messages: [], teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    const leadB: ChatSession = { ...leadA, title: 'External B' }
    hoisted.scopedTestSessions.value = { [a]: [leadA], [b]: [leadB] }
    let aReads = 0, releaseStale!: (value: ChatSession[]) => void
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => {
      if (scope === a && ++aReads === 2) return new Promise<ChatSession[]>(resolve => { releaseStale = resolve })
      return cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? [])
    })
    for (const scope of [a, b]) localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scope), id)
    const route = { channel: 'canvas' as const, scopeType: 'thread' as const, scopeId: 'runtime-project', threadId: 'runtime-pane' }
    const ui = (scope: string) => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scope} route={route}/></ThemeProvider></MemoryRouter>
    const page = render(ui(a))
    let releaseWrite!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('External A'))
      await openTeamManagement()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: 'scope A task' } })
      hoisted.teamPostCommitGate.value = new Promise<void>(resolve => { releaseWrite = resolve })
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      await waitFor(() => expect(hoisted.teamPostCommitSnapshot.value?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'scope A task' })])))
      page.rerender(ui(b))
      await waitFor(() => expect(readCurrentSessionState()?.title).toBe('External B'))
      page.rerender(ui(a))
      await waitFor(() => expect(releaseStale).toBeDefined())
      const committed = cloneValue(hoisted.scopedTestSessions.value![a][0])
      hoisted.scopedTestSessions.value![a] = [{ ...committed, title: 'Third-party edit' }]
      await act(async () => { hoisted.teamPostCommitGate.value = null; releaseWrite() })
      await act(async () => releaseStale([cloneValue(leadA)]))
      await openTeamManagement()
      fireEvent.change(screen.getByLabelText('任务'), { target: { value: 'newer local task' } })
      fireEvent.click(screen.getByRole('button', { name: '添加任务' }))
      await waitFor(() => expect(readCurrentSessionState()?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'newer local task' })])))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      await waitFor(() => expect(screen.getByText(/Failed to save chat session/)).toBeVisible())
      expect(hoisted.scopedTestSessions.value?.[a][0].title).toBe('Third-party edit')
      expect(hoisted.scopedTestSessions.value?.[a][0].teamTasks).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: 'newer local task' })]))
      expect(readCurrentSessionState()?.teamTasks).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'newer local task' })]))
      expect(hoisted.scopedTestSessions.value?.[b][0].teamTasks).toBeUndefined()
    } finally {
      hoisted.teamPostCommitGate.value = null
      releaseWrite?.()
      page.unmount()
    }
  })

  it('shows member identity once and keeps useful model details when expanded', async () => {
    const lead: ChatSession = { id: 'detail-lead', title: 'Lead', profileId: 'base-model', messages: [] }
    const member: ChatSession = { id: 'detail-writer', title: '文案', teamLeadId: lead.id, teamMemberName: '文案', teamRole: '文案', messages: [] }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const page = renderChatPage({ team: true })
    try {
      const area = await screen.findByRole('region', { name: '进程区' })
      fireEvent.click(within(area).getByRole('button', { name: '展开 文案 详情' }))
      expect(within(area).getByRole('button', { name: '打开 文案' })).toHaveTextContent('文案')
      expect(within(area).queryByText(/^角色 \/ 任务：/)).not.toBeInTheDocument()
      expect(within(area).getByText(/^模型：/)).toBeVisible()
    } finally {
      page.unmount()
    }
  })

  it('shows only this member’s observed current tool while it is running, not old history', async () => {
    const lead: ChatSession = { id: 'tool-lead', title: 'Lead', profileId: 'base-model', messages: [] }
    const member: ChatSession = { id: 'tool-writer', title: 'writer', teamLeadId: lead.id, teamMemberName: 'writer', messages: [
      { role: 'assistant', content: 'old answer', toolHistory: [{ runId: 'old', toolCallId: 'old-call', toolName: 'old.tool', status: 'completed', args: {}, content: 'old-result' }] }
    ] }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let request!: { onEvent: (event: unknown) => void; signal: AbortSignal }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => { request = input; return new Promise(resolve => { finish = resolve }) })
    const page = renderChatPage({ team: true })
    try {
      const area = await screen.findByRole('region', { name: '进程区' })
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      fireEvent.click(within(area).getByRole('button', { name: '展开 writer 详情' }))
      const oldHistory = within(area).getByText('最近工具步骤：old.tool · 完成')
      expect(oldHistory).toBeVisible()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'run live tool' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(request).toBeDefined())
      expect(within(area).getByText('最近工具步骤：old.tool · 完成')).toBeVisible()
      expect(within(area).queryByText('工具：old.tool')).not.toBeInTheDocument()
      const firstTool = { runId: 'live', toolCallId: 'live-call', toolName: 'image_gen' }
      const secondTool = { runId: 'live', toolCallId: 'second-call', toolName: 'web_search' }
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...firstTool, status: 'running' } }))
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      expect(within(area).getByText('出图中')).toBeVisible()
      await act(async () => request.onEvent({ type: 'text-delta', delta: 'partial output' }))
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...secondTool, status: 'running' } }))
      expect(within(area).getByText('工具：web_search')).toBeVisible()
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...firstTool, status: 'completed' } }))
      expect(within(area).getByText('工具：web_search')).toBeVisible()
      expect(within(area).queryByText('Tool returned; waiting for the model to continue')).not.toBeInTheDocument()
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...secondTool, status: 'completed' } }))
      expect(within(area).queryByText('工具：web_search')).not.toBeInTheDocument()
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...firstTool, status: 'running' } }))
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      await act(async () => request.onEvent({ type: 'retry', retry: { reason: 'connection-error', attempt: 1, maxAttempts: 2, delayMs: 1 } }))
      expect(within(area).queryByText('工具：image_gen')).not.toBeInTheDocument()
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...firstTool, status: 'running' } }))
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      fireEvent.click(within(area).getByRole('button', { name: '停止 writer' }))
      await waitFor(() => expect(request.signal.aborted).toBe(true))
      await waitFor(() => expect(within(area).queryByText('工具：image_gen')).not.toBeInTheDocument())
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { ...secondTool, status: 'running' } }))
      expect(within(area).queryByText('工具：web_search')).not.toBeInTheDocument()
      await act(async () => { finish({ result: { content: 'done' }, response: 'done' }) })
      expect(within(area).queryByText('工具：old.tool')).not.toBeInTheDocument()
    } finally {
      finish?.({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('keeps each member’s current tool isolated while switching during a run', async () => {
    const lead: ChatSession = { id: 'tool-switch-lead', title: 'Lead', profileId: 'base-model', messages: [] }
    const alice: ChatSession = { id: 'tool-switch-alice', title: 'Alice', teamLeadId: lead.id, teamMemberName: 'Alice', messages: [] }
    const bob: ChatSession = { id: 'tool-switch-bob', title: 'Bob', teamLeadId: lead.id, teamMemberName: 'Bob', messages: [] }
    hoisted.storedSessions.value = [lead, alice, bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), alice.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let request!: { onEvent: (event: unknown) => void }
    let finish!: (value: unknown) => void
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => { request = input; return new Promise(resolve => { finish = resolve }) })
    const page = renderChatPage({ team: true })
    try {
      const area = await screen.findByRole('region', { name: '进程区' })
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(alice.id))
      fireEvent.click(within(area).getByRole('button', { name: '展开 Alice 详情' }))
      fireEvent.click(within(area).getByRole('button', { name: '展开 Bob 详情' }))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Alice task' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(request).toBeDefined())
      await act(async () => request.onEvent({ type: 'tool-status', toolStatus: { runId: 'alice-run', toolCallId: 'alice-tool', toolName: 'image_gen', status: 'running' } }))
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      fireEvent.click(within(area).getByRole('button', { name: '打开 Bob' }))
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(bob.id))
      const bobRow = within(area).getByRole('button', { name: '打开 Bob' }).closest('li')!
      expect(within(bobRow).queryByText('工具：image_gen')).not.toBeInTheDocument()
      expect(within(area).getByText('工具：image_gen')).toBeVisible()
      await act(async () => finish({ result: { content: 'Alice done' }, response: 'Alice done' }))
      await waitFor(() => expect(within(area).queryByText('工具：image_gen')).not.toBeInTheDocument())
      await waitFor(() => expect(within(area).getByRole('button', { name: '打开 Alice' })).toHaveTextContent('已完成'))
      expect(within(bobRow).queryByText('工具：image_gen')).not.toBeInTheDocument()
    } finally {
      finish?.({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('shows an idle member waiting for its task dependency without claiming it is running', async () => {
    const lead: ChatSession = { id: 'dependency-lead', title: 'Lead', messages: [], profileId: 'base-model', teamTasks: [
      { id: 'prepare', title: '准备素材', ownerId: 'designer', status: 'pending', dependsOn: [] },
      { id: 'poster', title: '制作海报', ownerId: 'designer', status: 'pending', dependsOn: ['prepare'] }
    ] }
    const member: ChatSession = { id: 'designer', title: 'designer', messages: [], teamLeadId: lead.id, teamMemberName: 'designer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({ team: true })
    const area = await screen.findByRole('region', { name: '进程区' })
    await waitFor(() => expect(within(area).getByRole('button', { name: '打开 designer' })).toBeVisible())
    expect(within(area).getByText('等待依赖：准备素材')).toBeVisible()
    expect(within(area).getByRole('button', { name: '进程 · 成员 1 · 运行项 0 · 待审批项 0' })).toBeVisible()
    expect(within(area).queryByRole('button', { name: '停止 designer' })).not.toBeInTheDocument()
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('dispatches only a ready assigned team task and persists done after its member responds', async () => {
    const lead: ChatSession = { id:'task-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}, teamTasks:[
      {id:'first',title:'准备素材',ownerId:'task-member',status:'pending',dependsOn:[]},
      {id:'second',title:'制作海报',ownerId:'task-member',status:'pending',dependsOn:['first']}
    ] }
    const member: ChatSession = {id:'task-member',title:'designer',messages:[],teamLeadId:lead.id,teamMemberName:'designer',teamRole:'设计师'}
    hoisted.storedSessions.value = [lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let finish!: (value: {content:string}) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    chooseAddMenuEntry('chat-composer-menu-team')
    expect(screen.getByRole('button',{name:'执行 制作海报'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'执行 准备素材'}))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const req = hoisted.requestChatCompletionMock.mock.calls[0][0]
    expect(req.teamMember).toEqual({scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:member.id})
    expect(req.messages.at(-1)?.content).toContain('准备素材')
    expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.teamTasks?.[0].status).toBe('running')
    expect(screen.getByRole('button',{name:'执行 制作海报'})).toBeDisabled()
    await act(async () => { finish({content:'素材已准备'}) })
    await waitFor(() => expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.teamTasks?.[0].status).toBe('done'))
    await waitFor(() => expect(screen.getByRole('button',{name:'执行 制作海报'})).toBeEnabled())
    fireEvent.click(screen.getByRole('button',{name:'执行 制作海报'}))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    expect(hoisted.requestChatCompletionMock.mock.calls[1][0].messages.at(-1)?.content).toContain('制作海报')
  })

  it('keeps two member results and a newer lead message when task completion overlaps lead saving', async () => {
    const lead: ChatSession = { id:'interleave-lead', title:'Lead', messages:[], profileId:'base-model', teamTasks:[
      { id:'task', title:'准备素材', ownerId:'interleave-a', status:'pending', dependsOn:[] }
    ] }
    const a: ChatSession = { id:'interleave-a', title:'Alice', messages:[], teamLeadId:lead.id, teamMemberName:'Alice' }
    const b: ChatSession = { id:'interleave-b', title:'Bob', messages:[], teamLeadId:lead.id, teamMemberName:'Bob' }
    hoisted.storedSessions.value = [lead, a, b]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let finishA!: (value:{content:string}) => void
    let finishLead!: (value:{content:string}) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => { finishA = resolve }))
      .mockResolvedValueOnce({content:'Bob result'})
      .mockImplementationOnce(() => new Promise(resolve => { finishLead = resolve }))
    const page = renderChatPage({team:true})
    let release!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button',{name:'执行 准备素材'}))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@Bob independent'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.storedSessions.value.find(s=>s.id===b.id)?.messages.some(m=>m.content==='Bob result')).toBe(true))
      const gate = new Promise<void>(resolve => { release = resolve })
      const selective = { id:lead.id, gate, started:false }
      hoisted.selectiveSaveGate.value = selective
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'Lead latest message'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(selective.started).toBe(true))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3))
      await act(async () => finishA({content:'Alice result'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(s=>s.id===a.id)?.messages.some(m=>m.content==='Alice result')).toBe(true))
      hoisted.selectiveSaveGate.value = null
      await act(async () => release())
      await act(async () => finishLead({content:'Lead reply'}))
      await waitFor(() => {
        const saved = hoisted.storedSessions.value.find(s=>s.id===lead.id)
        expect(saved?.teamTasks?.[0].status).toBe('done')
        expect(saved?.messages.some(m=>m.content==='Lead latest message')).toBe(true)
        expect(saved?.messages.some(m=>m.content==='Lead reply')).toBe(true)
      })
      expect(hoisted.notifyErrorMock).not.toHaveBeenCalledWith(expect.stringMatching(/Failed to save chat session/))
      hoisted.requestChatCompletionMock.mockResolvedValueOnce({content:'Summary reply'})
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'Summarize members'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(4))
      const summaryRequest = hoisted.requestChatCompletionMock.mock.calls[3][0]
      const summaryContext = JSON.stringify(summaryRequest.messages)
      expect(summaryContext).toContain('Alice result')
      expect(summaryContext).toContain('Bob result')
      await waitFor(() => {
        const saved = hoisted.storedSessions.value.find(s => s.id === lead.id)
        expect(saved?.messages.some(m => m.content === 'Lead latest message')).toBe(true)
        expect(saved?.messages.some(m => m.content === 'Summary reply')).toBe(true)
      })
    } finally {
      hoisted.selectiveSaveGate.value = null
      release?.()
      finishA?.({content:'cleanup'})
      finishLead?.({content:'cleanup'})
      page.unmount()
    }
  })

  it('can execute a task immediately after creating it in the team menu', async () => {
    const lead: ChatSession = {id:'new-task-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'new-task-member',title:'designer',messages:[],teamLeadId:lead.id,teamMemberName:'designer'}
    hoisted.storedSessions.value = [lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    chooseAddMenuEntry('chat-composer-menu-team')
    fireEvent.change(screen.getByLabelText('任务'),{target:{value:'刚添加的任务'}})
    fireEvent.mouseDown(screen.getByLabelText('负责人'))
    fireEvent.click(await screen.findByRole('option',{name:'designer'}))
    fireEvent.click(screen.getByRole('button',{name:'添加任务'}))
    await waitFor(() => expect(screen.getByLabelText('任务')).toHaveValue(''))
    fireEvent.click(screen.getByRole('button',{name:'执行 刚添加的任务'}))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.requestChatCompletionMock.mock.calls[0][0].messages.at(-1)?.content).toContain('刚添加的任务')
  })

  it('pumps a busy user broadcast when MAIN list remains pending', async () => {
    const lead: ChatSession = {id:'pending-list-lead',title:'Lead',messages:[],profileId:'base-model'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let releaseList!: (value:{intents:never[]}) => void
    const listGate = new Promise<{intents:never[]}>(resolve => {releaseList = resolve})
    hoisted.listAgentTeamMessagesMock.mockReturnValue(listGate)
    let finish!: (value:{content:string}) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      await waitFor(() => expect(hoisted.listAgentTeamMessagesMock).toHaveBeenCalledTimes(1))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@Bob busy first'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      await openTeamManagement()
      await waitFor(() => expect(screen.getByRole('checkbox',{name:'Bob'})).toBeChecked())
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      fireEvent.change(screen.getByLabelText('频道消息'),{target:{value:'pending list broadcast'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      expect(await screen.findByText(/用户 → Bob · 排队中/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      await act(async () => finish({content:'busy completed'}))
      expect(await screen.findByText(/用户 → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.listAgentTeamMessagesMock).toHaveBeenCalledTimes(1)
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2)
      const request = hoisted.requestChatCompletionMock.mock.calls[1][0]
      expect(request.teamMember.member).toBe('bob')
      expect(request.teamMessageHop).toBe(1)
      expect(request.messages.at(-1).content).toContain('pending list broadcast')
      expect(hoisted.claimAgentTeamMessageMock).not.toHaveBeenCalled()
    } finally {
      finish?.({content:'cleanup'})
      page.unmount()
      await act(async () => releaseList({intents:[]}))
    }
  })

  it('saves a member tool checkpoint queued behind its in-flight placeholder without a false conflict', async () => {
    const lead: ChatSession = { id: 'checkpoint-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'checkpoint-writer', title: 'Writer', messages: [], teamLeadId: lead.id, teamMemberName: 'Writer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let finish!: (value: unknown) => void
    let pending!: { onEvent: (event: unknown) => void }
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => {
      pending = input
      return new Promise(resolve => { finish = resolve })
    })
    const page = renderChatPage({ team: true })
    let release!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { release = resolve })
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Writer do work' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(pending).toBeDefined())
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(member.id))
      await act(async () => pending.onEvent({
        type: 'tool-status',
        toolStatus: { runId: 'run', toolCallId: 'call', toolName: 'scratchpad', status: 'running' },
        toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'scratchpad', status: 'running', args: {} }]
      }))
      hoisted.saveSessionToDBGate.value = null
      await act(async () => release())
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === member.id)?.messages.at(-1)?.toolHistory?.[0]?.status).toBe('running'))
      await act(async () => finish({ result: { content: 'done' }, response: 'done' }))
      await waitFor(() => {
        const saved = hoisted.storedSessions.value.find(item => item.id === member.id)
        expect(saved?.messages.at(-1)?.content).toBe('done')
        expect(saved?.messages.at(-1)?.toolHistory?.[0]?.toolName).toBe('scratchpad')
      })
      expect(hoisted.notifyErrorMock).not.toHaveBeenCalledWith(expect.stringMatching(/Failed to save chat session/))
      expect(screen.queryByText(/Failed to save chat session/)).not.toBeInTheDocument()
    } finally {
      hoisted.saveSessionToDBGate.value = null
      release?.()
      finish?.({ result: { content: 'done' }, response: 'done' })
      page.unmount()
    }
  })

  it('prefers a final tool history over the earlier validated running checkpoint', async () => {
    const lead: ChatSession = { id: 'checkpoint-final-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'checkpoint-final-writer', title: 'Writer', messages: [], teamLeadId: lead.id, teamMemberName: 'Writer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    const running = { runId: 'run', toolCallId: 'call', toolName: 'scratchpad', status: 'running' as const, args: {} }
    const completed = { ...running, status: 'completed' as const, content: 'stored fixture result' }
    let finish!: (value: unknown) => void
    let pending!: { onEvent: (event: unknown) => void }
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => {
      pending = input
      return new Promise(resolve => { finish = resolve })
    })
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Writer do work' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(pending).toBeDefined())
      await act(async () => pending.onEvent({ type: 'tool-status', toolStatus: running, toolHistory: [running] }))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === member.id)?.messages.at(-1)?.toolHistory).toEqual([running]))
      await act(async () => finish({ result: { content: 'done', metadata: { toolHistory: [completed] } }, response: 'done' }))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === member.id)?.messages.at(-1)).toMatchObject({ content: 'done', toolHistory: [completed] }))
      expect(hoisted.notifyErrorMock).not.toHaveBeenCalledWith(expect.stringMatching(/Failed to save chat session/))
    } finally {
      finish?.({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('retains an external member edit and surfaces a conflict when the in-flight placeholder loses CAS', async () => {
    const lead: ChatSession = { id: 'external-checkpoint-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'external-checkpoint-writer', title: 'Writer', messages: [], teamLeadId: lead.id, teamMemberName: 'Writer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let finish!: (value: unknown) => void
    let pending!: { onEvent: (event: unknown) => void }
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => {
      pending = input
      return new Promise(resolve => { finish = resolve })
    })
    const page = renderChatPage({ team: true })
    let release!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { release = resolve })
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Writer do work' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(pending).toBeDefined())
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(member.id))
      await act(async () => pending.onEvent({
        type: 'tool-status',
        toolStatus: { runId: 'run', toolCallId: 'call', toolName: 'scratchpad', status: 'running' },
        toolHistory: [{ runId: 'run', toolCallId: 'call', toolName: 'scratchpad', status: 'running', args: {} }]
      }))
      hoisted.storedSessions.value = hoisted.storedSessions.value.map(item => item.id === member.id ? { ...item, title: 'External member edit' } : item)
      hoisted.saveSessionToDBGate.value = null
      await act(async () => release())
      await waitFor(() => expect(hoisted.notifyErrorMock).toHaveBeenCalledWith(expect.stringContaining('Session save conflict')))
      expect(hoisted.storedSessions.value.find(item => item.id === member.id)).toMatchObject({ title: 'External member edit', messages: [] })
      fireEvent.click(screen.getByRole('button', { name: '打开 Writer' }))
      await waitFor(() => expect(readCurrentSessionState()?.messages.some(message => message.content === 'do work')).toBe(true))
    } finally {
      hoisted.saveSessionToDBGate.value = null
      release?.()
      finish?.({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('pumps a user broadcast despite rejected MAIN polling and after a busy member becomes free', async () => {
    const lead: ChatSession = {id:'broadcast-busy-lead',title:'Lead',messages:[],profileId:'base-model'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    const carol: ChatSession = {id:'carol',title:'Carol',messages:[],teamLeadId:lead.id,teamMemberName:'Carol'}
    hoisted.storedSessions.value = [lead,bob,carol]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.listAgentTeamMessagesMock.mockRejectedValue(new Error('fixture IPC unavailable'))
    let finish!: (value:{content:string}) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@Bob busy user request'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(hoisted.listAgentTeamMessagesMock).toHaveBeenCalled())
      await openTeamManagement()
      await waitFor(() => expect(screen.getByRole('checkbox',{name:'Bob'})).toBeChecked())
      await waitFor(() => expect(screen.getByRole('checkbox',{name:'Carol'})).toBeChecked())
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      fireEvent.click(screen.getByRole('button',{name:'展开 Carol 详情'}))
      fireEvent.change(screen.getByLabelText('频道消息'),{target:{value:'用户本地广播'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      expect(await screen.findByText(/用户 → Bob · 排队中/)).toBeVisible()
      expect(await screen.findByText(/用户 → Carol · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2)
      expect(hoisted.requestChatCompletionMock.mock.calls[1][0].teamMember.member).toBe('carol')
      await act(async () => finish({content:'busy completed'}))
      expect(await screen.findByText(/用户 → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3)
      const request = hoisted.requestChatCompletionMock.mock.calls[2][0]
      expect(request.teamMember.member).toBe('bob')
      expect(request.teamMessageHop).toBe(1)
      expect(request.messages.at(-1).content).toContain('用户本地广播')
      expect(hoisted.claimAgentTeamMessageMock).not.toHaveBeenCalled()
    } finally { finish?.({content:'cleanup'}); page.unmount() }
  })

  it('broadcasts the user menu message once to each subscriber, distinct from agent tool messages', async () => {
    const lead: ChatSession = {id:'user-broadcast-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    const carol: ChatSession = {id:'carol',title:'Carol',messages:[],teamLeadId:lead.id,teamMemberName:'Carol'}
    hoisted.storedSessions.value = [lead,alice,bob,carol]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const agentIntent = {id:'agent-origin',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'agent tool origin'}
    let queued = false
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [agentIntent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent:agentIntent}})
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      const carolSubscription = await screen.findByRole('checkbox',{name:'Carol'})
      await waitFor(() => expect(carolSubscription).toBeChecked())
      fireEvent.click(carolSubscription)
      const draft = screen.getByLabelText('频道消息')
      fireEvent.change(draft,{target:{value:'用户广播正文'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      const requests = hoisted.requestChatCompletionMock.mock.calls.map(call => call[0])
      expect(requests.map(req => req.teamMember.member).sort()).toEqual(['alice','bob'])
      for (const req of requests) {
        expect(req.teamMessageHop).toBe(1)
        expect(req.messages.at(-1).content).toContain('用户频道消息')
        expect(req.messages.at(-1).content).toContain('用户广播正文')
        expect(req.messages.at(-1).content).not.toContain('团队成员消息')
      }
      fireEvent.click(screen.getByRole('button',{name:'展开 Alice 详情'}))
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      expect(await screen.findByText(/用户 → Alice · 已收到响应（不代表送达）/)).toBeVisible()
      expect(await screen.findByText(/用户 → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(screen.queryByText(/用户 → Carol/)).not.toBeInTheDocument()
      await waitFor(() => expect(draft).toHaveValue(''))
      queued = true
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3)
      const memberRequest = hoisted.requestChatCompletionMock.mock.calls[2][0]
      expect(memberRequest.messages.at(-1).content).toContain('团队成员消息，来自 Alice')
      expect(memberRequest.teamMessageHop).toBe(1)
    } finally { page.unmount() }
  })

  it('does not enqueue a broadcast under an unavailable versioned member model and preserves its draft', async () => {
    const lead: ChatSession = { id:'blocked-broadcast-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId:'vision-model'}} }
    const member: ChatSession = { id:'blocked-broadcast-member', title:'Bob', messages:[], teamLeadId:lead.id, teamMemberName:'Bob' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const fetchBlocked = vi.fn(async () => { throw new Error('Unexpected network request in broadcast test') })
    vi.stubGlobal('fetch', fetchBlocked)
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      await waitFor(() => expect(screen.getByRole('checkbox',{name:'Bob'})).toBeChecked())
      const input = screen.getByLabelText('频道消息')
      fireEvent.change(input, {target:{value:'不可用的广播'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      expect(await screen.findByText('广播结果未确认，请先核对相关会话，避免重复发送。')).toBeVisible()
      expect(input).toHaveValue('不可用的广播')
      const broadcast = screen.getByRole('button', { name: '广播给订阅成员' })
      expect(broadcast).toBeDisabled()
      fireEvent.change(input, { target: { value: '修改后的广播草稿' } })
      expect(broadcast).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: '我已了解风险，允许再次广播' }))
      expect(input).toHaveValue('修改后的广播草稿')
      expect(broadcast).toBeEnabled()
      expect(screen.queryByText(/用户 → Bob/)).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)?.messages).toEqual([])
    } finally {
      page.unmount()
      vi.unstubAllGlobals()
      expect(fetchBlocked).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])('does not dispatch a queued broadcast if a marker appears after preparation (stream=%s)', async stream => {
    const lead: ChatSession = { id:'late-broadcast-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false} }
    const bob: ChatSession = { id:'late-broadcast-bob', title:'Bob', messages:[], teamLeadId:lead.id, teamMemberName:'Bob' }
    hoisted.storedSessions.value = [lead,bob]
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let release!: () => void
    const gate = { gate: new Promise<void>(resolve => { release = resolve }), entered: false }
    hoisted.teamBeforeDispatchGate.value = gate
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      await waitFor(() => expect(screen.getByRole('checkbox',{name:'Bob'})).toBeChecked())
      fireEvent.change(screen.getByLabelText('频道消息'), { target:{ value:'等候中的频道消息' } })
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      await waitFor(() => expect(gate.entered).toBe(true))
      hoisted.storedSessions.value = hoisted.storedSessions.value.map(session => session.id === lead.id
        ? { ...session, teamSettings: { ...session.teamSettings!, memberModelSelection: { version: 1, profileId:'vision-model' } } }
        : session)
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      await act(async () => { release() })
      expect(await screen.findByText(/用户 → Bob · 状态未确认 · 等候中的频道消息/)).toBeVisible()
      expect(screen.queryByText(/用户 → Bob · 请求已发起/)).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { hoisted.teamBeforeDispatchGate.value = null; release(); page.unmount() }
  })

  it('preserves user broadcast draft and sends no request with no subscribers', async () => {
    const lead: ChatSession = {id:'broadcast-empty-lead',title:'Lead',messages:[],profileId:'base-model'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      const subscription = await screen.findByRole('checkbox',{name:'Bob'})
      await waitFor(() => expect(subscription).toBeChecked())
      fireEvent.click(subscription)
      const draft = screen.getByLabelText('频道消息')
      fireEvent.change(draft,{target:{value:'保留广播草稿'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      expect(await screen.findByText('未送出，请检查订阅')).toBeVisible()
      expect(draft).toHaveValue('保留广播草稿')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it.fails('P6 known End-remount draft loss: preserves user broadcast draft after End', async () => {
    const lead: ChatSession = {id:'broadcast-empty-lead',title:'Lead',messages:[],profileId:'base-model'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      const subscription = await screen.findByRole('checkbox',{name:'Bob'})
      await waitFor(() => expect(subscription).toBeChecked())
      fireEvent.click(subscription)
      const draft = screen.getByLabelText('频道消息')
      fireEvent.change(draft,{target:{value:'保留广播草稿'}})
      fireEvent.click(screen.getByRole('button',{name:'广播给订阅成员'}))
      expect(await screen.findByText('未送出，请检查订阅')).toBeVisible()
      expect(draft).toHaveValue('保留广播草稿')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamEnded).toBe(true))
      await waitFor(() => expect(readCurrentSessionState()?.teamEnded).toBe(true))
      if (!screen.queryByLabelText('频道消息')) await openTeamManagement()
      const endButton = screen.queryByRole('button',{name:'广播给订阅成员'})
      if (endButton && !endButton.hasAttribute('disabled')) {
        fireEvent.click(endButton)
        expect(await screen.findByText(/未送出/)).toBeVisible()
      } else if (endButton) expect(endButton).toBeDisabled()
      expect(screen.getByLabelText('频道消息')).toHaveValue('保留广播草稿')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('broadcasts only to subscribed members and displays the member source', async () => {
    const lead: ChatSession = {id:'channel-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    const carol: ChatSession = {id:'carol',title:'Carol',messages:[],teamLeadId:lead.id,teamMemberName:'Carol'}
    hoisted.storedSessions.value = [lead,alice,bob,carol]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'channel-1',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'channel',hop:1,text:'广播测试'}
    let queued = false
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      await openTeamManagement()
      const carolSubscription = await screen.findByRole('checkbox',{name:'Carol'})
      await waitFor(() => expect(carolSubscription).toBeChecked())
      fireEvent.click(carolSubscription)
      expect(carolSubscription).not.toBeChecked()
      queued = true
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      const request = hoisted.requestChatCompletionMock.mock.calls[0][0]
      expect(request.teamMember.member).toBe(bob.id)
      expect(request.messages.at(-1).content).toContain('来自 Alice')
      expect(screen.queryByText(/Alice → Carol/)).not.toBeInTheDocument()
    } finally { page.unmount() }
  })

  it('keeps a member message queued while Bob handles a user @ request', async () => {
    const lead: ChatSession = {id:'busy-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'busy',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'member queued message'}
    let queued = false, finish!: (value:{content:string}) => void
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => {finish = resolve}))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@Bob user request'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].teamMessageHop).toBeUndefined()
      fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
      queued = true
      expect(await screen.findByText(/Alice → Bob · 排队中/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      await act(async () => finish({content:'user request done'}))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      expect(hoisted.requestChatCompletionMock.mock.calls[1][0].teamMessageHop).toBe(1)
      expect(hoisted.requestChatCompletionMock.mock.calls[1][0].messages.at(-1).content).toContain('member queued message')
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.claimAgentTeamMessageMock).toHaveBeenCalledTimes(1)
    } finally { finish?.({content:'cleanup'}); page.unmount() }
  })

  it('does not probe or batch skill reference attachments for a member message', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {...config,llm_config:{...config.llm_config,customSkills:[{id:'member-reference',category:'Design',skillName:'Reference',prompt:'Review references',type:'normal',referenceAttachments:[createSkillReferenceImageAttachment('one.png'),createSkillReferenceImageAttachment('two.png')]}]}}
    hoisted.availableProfiles.value = [{id:'vision-model',model_name:'Vision',model_use:'vision',is_vision_model:true}]
    const lead: ChatSession = {id:'reference-lead',title:'Lead',messages:[],profileId:'vision-model',skillId:'member-reference'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'reference',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'review references'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button',{name:'展开 Bob 详情'}))
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）/)).toBeVisible()
      expect(hoisted.resolveAttachmentBatchCapabilityMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].teamMessageHop).toBe(1)
    } finally { page.unmount() }
  })

  it('does not probe or batch skill reference attachments for a directly addressed member', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {...config,llm_config:{...config.llm_config,customSkills:[{id:'direct-reference',category:'Design',skillName:'Reference',prompt:'Review references',type:'normal',referenceAttachments:[createSkillReferenceImageAttachment('one.png'),createSkillReferenceImageAttachment('two.png')]}]}}
    hoisted.availableProfiles.value = [{id:'vision-model',model_name:'Vision',model_use:'vision',is_vision_model:true}]
    const lead: ChatSession = {id:'direct-reference-lead',title:'Lead',messages:[],profileId:'vision-model',skillId:'direct-reference'}
    const member: ChatSession = {id:'direct-reference-bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'review references'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      expect(hoisted.resolveAttachmentBatchCapabilityMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].teamMember.member).toBe(member.id)
      expect(hoisted.requestChatCompletionMock.mock.calls[0][0].messages.at(-1).attachments).toHaveLength(2)
    } finally { page.unmount() }
  })

  it('offline shows the unknown-result check without offering an extra send', async () => {
    const lead: ChatSession = {id:'unknown-hint-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'unknown-hint-alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'unknown-hint-bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'unknown-hint-message',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'unknown hint fixture'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    hoisted.requestChatCompletionMock.mockRejectedValueOnce(new Error('synthetic unknown'))
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button',{name:'展开 Bob 详情'}))
      expect(await screen.findByText(/Alice → Bob · 结果未知.*unknown hint fixture/)).toBeVisible()
      expect(screen.getByText('未确认结果，请核对相关会话中的后续记录。')).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it.each([false, true])('does not mark preprocessing failure as a started member request (stream=%s)', async stream => {
    const lead: ChatSession = {id:'preprocess-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    hoisted.teamPreprocessingFails.value = true
    const intent = {id:'preprocess',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'preprocessing fails'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button',{name:'展开 Bob 详情'}))
      expect(await screen.findByText(/Alice → Bob · 状态未确认/)).toBeVisible()
      expect(screen.queryByText(/Alice → Bob · 请求已发起/)).not.toBeInTheDocument()
      expect(screen.queryByText(/Alice → Bob · 结果未知/)).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { hoisted.teamPreprocessingFails.value = false; page.unmount() }
  })

  it.each([false, true])('does not retry invalid continuation after a member message starts (stream=%s)', async stream => {
    hoisted.availableProfiles.value = [{id:'continuation-model',model_name:'Continuation Model',model_use:'vision',is_vision_model:true,supports_session_continuation:true}]
    const lead: ChatSession = {id:'continuation-team',title:'Lead',messages:[],profileId:'continuation-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob',profileId:'continuation-model',sessionUrl:'expired-session',sessionProfileId:'continuation-model',sessionRouteFingerprint:'local-continuation-model'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    const intent = {id:'continuation-message',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'side effect may have occurred'}
    let queued = true, sideEffects = 0
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const request = stream ? hoisted.requestChatCompletionStreamMock : hoisted.requestChatCompletionMock
    request.mockImplementationOnce(async () => { sideEffects += 1; throw createExpiredContinuationError() })
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 结果未知/)).toBeVisible()
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][0].sessionUrl).toBe('expired-session')
      expect(request.mock.calls[0][0].teamMessageHop).toBe(1)
      expect(sideEffects).toBe(1)
      queued = true
      await waitFor(() => expect(hoisted.claimAgentTeamMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect(request).toHaveBeenCalledTimes(1)
      expect(sideEffects).toBe(1)
    } finally { page.unmount() }
  })

  it.each([false, true])('member message failure is unknown and never retried (stream=%s)', async stream => {
    const lead: ChatSession = {id:'message-fail-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    const intent = {id:'failure',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'fixture failure message'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const request = stream ? hoisted.requestChatCompletionStreamMock : hoisted.requestChatCompletionMock
    request.mockRejectedValueOnce(new Error('fixture failure'))
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 结果未知/)).toBeVisible()
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0][0].teamMember.member).toBe(bob.id)
      expect(request.mock.calls[0][0].teamMessageHop).toBe(1)
      // A fresh poll observing the already-claimed ID must not execute it again.
      queued = true
      await waitFor(() => expect(hoisted.claimAgentTeamMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect(request).toHaveBeenCalledTimes(1)
    } finally { page.unmount() }
  })

  it('marks a cancelled member message unknown and does not retry', async () => {
    const lead: ChatSession = {id:'cancel-msg-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),bob.id)
    const intent = {id:'cancel',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'cancel this'}
    let queued = true, signal: AbortSignal | undefined, rejectPending!: (error:Error) => void
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    hoisted.requestChatCompletionMock.mockImplementationOnce((request:{signal:AbortSignal}) => {
      signal = request.signal
      return new Promise((_resolve,reject) => { rejectPending = reject; signal!.addEventListener('abort', () => reject(new DOMException('aborted','AbortError')), {once:true}) })
    })
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 请求已发起/)).toBeVisible()
      fireEvent.click(screen.getByTestId('chat-composer-stop-mock'))
      expect(signal?.aborted).toBe(true)
      expect(await screen.findByText(/Alice → Bob · 结果未知/)).toBeVisible()
      queued = true
      await waitFor(() => expect(hoisted.claimAgentTeamMessageMock.mock.calls.length).toBeGreaterThanOrEqual(2))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
    } finally { rejectPending?.(new Error('cleanup')); page.unmount() }
  })

  it('does not send an old-scope message after a pending claim resolves', async () => {
    const lead: ChatSession = {id:'scope-msg-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'scope-claim',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'old scope'}
    hoisted.listAgentTeamMessagesMock.mockResolvedValue({intents:[intent]})
    let release!: (value:{intent:typeof intent}) => void
    hoisted.claimAgentTeamMessageMock.mockImplementation(() => new Promise(resolve => {release = resolve}))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(release).toBeDefined())
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="other-scope" route={{channel:'canvas',scopeType:'thread',scopeId:'runtime-project',threadId:'runtime-pane'}} /></ThemeProvider></MemoryRouter>)
      await act(async () => release({intent}))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { release?.({intent}); page.unmount() }
  })

  it('does not retract an already-started member message when the team ends', async () => {
    const lead: ChatSession = {id:'message-live-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'live',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'already started'}
    let queued = true, finish!: (value:{content:string}) => void, signal: AbortSignal | undefined
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    hoisted.requestChatCompletionMock.mockImplementationOnce((request:{signal:AbortSignal}) => { signal = request.signal; return new Promise(resolve => {finish = resolve}) })
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 请求已发起/)).toBeVisible()
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamEnded).toBe(true))
      await waitFor(() => expect(screen.queryByTestId('team-message-activity')).not.toBeInTheDocument())
      expect(signal?.aborted).toBe(false)
      await act(async () => finish({content:'already dispatched result'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === bob.id)?.messages.some(message => message.content === 'already dispatched result')).toBe(true))
      expect(screen.queryByTestId('team-message-activity')).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
    } finally { finish?.({content:'cleanup'}); page.unmount() }
  })

  it('keeps same-generation activity when returning to a lead, but does not restore it after remount', async () => {
    const lead: ChatSession = {id:'activity-lead',title:'Activity lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'activity-alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'activity-bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    const other: ChatSession = {id:'activity-other',title:'Other lead',messages:[],profileId:'base-model'}
    hoisted.storedSessions.value = [lead,alice,bob,other]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'activity-transient',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'transient activity'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）.*transient activity/)).toBeVisible()
      await dispatchSwitchSession(other.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(other.id))
      expect(screen.queryByText(/transient activity/)).not.toBeInTheDocument()
      await dispatchSwitchSession(lead.id)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.click(screen.getByRole('button', { name: '展开 Bob 详情' }))
      expect(screen.getByText(/Alice → Bob · 已收到响应（不代表送达）.*transient activity/)).toBeVisible()
    } finally { page.unmount() }
    const reopened = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      expect(screen.queryByText(/transient activity/)).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
    } finally { reopened.unmount() }
  })

  it('keeps the current team message visible after its last member is removed', async () => {
    const lead: ChatSession = {id:'last-member-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'last-member-alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'last-member-bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead, alice, bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'last-member-message',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'last member activity'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      fireEvent.click(await screen.findByRole('button', { name: '展开 Bob 详情' }))
      expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）.*last member activity/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      await act(async () => window.dispatchEvent(new CustomEvent('chat:deleteSession', { detail: { scope:'runtime-flow', sessionId:bob.id } })))
      await waitFor(() => expect(screen.queryByRole('button', { name: '展开 Bob 详情' })).not.toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: '展开 Alice 详情' }))
      expect(screen.getByText(/Alice → last-member-bob · 已收到响应（不代表送达）.*last member activity/)).toBeVisible()
      await act(async () => window.dispatchEvent(new CustomEvent('chat:deleteSession', { detail: { scope:'runtime-flow', sessionId:alice.id } })))
      await waitFor(() => expect(screen.queryByRole('button', { name: '展开 Alice 详情' })).not.toBeInTheDocument())
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      const area = screen.getByRole('region', { name: '进程区' })
      fireEvent.click(within(area).getByText('其他团队消息'))
      expect(within(area).getByText(/last-member-alice → last-member-bob · 已收到响应（不代表送达）.*last member activity/)).toBeVisible()
      const route = { channel:'canvas', scopeType:'thread', scopeId:'runtime-project', threadId:'runtime-pane' } as const
      const ui = (active: boolean) => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact active={active} storageScope="runtime-flow" route={route} /></ThemeProvider></MemoryRouter>
      page.rerender(ui(false))
      expect(screen.queryByText(/last member activity/)).not.toBeInTheDocument()
      page.rerender(ui(true))
      const restoredArea = screen.getByRole('region', { name: '进程区' })
      fireEvent.click(within(restoredArea).getByText('其他团队消息'))
      expect(within(restoredArea).getByText(/last-member-alice → last-member-bob · 已收到响应（不代表送达）.*last member activity/)).toBeVisible()
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact active storageScope="other-scope" route={route} /></ThemeProvider></MemoryRouter>)
      expect(screen.queryByText(/last member activity/)).not.toBeInTheDocument()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('records an invalid recipient as not sent without a model request', async () => {
    const lead: ChatSession = {id:'missing-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    hoisted.storedSessions.value = [lead,alice]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'missing',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:'missing-bob',text:'not deliverable'}
    let queued = true
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({intents:queued ? [intent] : []}))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => {queued = false; return {intent}})
    const page = renderChatPage({team:true})
    try {
      const area = await screen.findByRole('region', { name: '进程区' })
      fireEvent.click(within(area).getByRole('button', { name: '展开 Alice 详情' }))
      expect(await within(area).findByText(/Alice → missing-bob · 状态未确认/)).toBeVisible()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })

  it('does not send a claimed member message when End occurs while the claim is pending', async () => {
    const lead: ChatSession = {id:'claim-end-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = {id:'end-claim',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'must not send'}
    hoisted.listAgentTeamMessagesMock.mockResolvedValue({intents:[intent]})
    let release!: (value: {intent: typeof intent}) => void
    hoisted.claimAgentTeamMessageMock.mockImplementation(() => new Promise(resolve => {release = resolve}))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(release).toBeDefined())
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamEnded).toBe(true))
      await act(async () => release({intent}))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { release?.({intent}); page.unmount() }
  })

  it('routes a queued member message to the recipient model and reports request and response separately', async () => {
    const lead: ChatSession = {id:'msg-lead',title:'Lead',messages:[],profileId:'base-model'}
    const alice: ChatSession = {id:'alice',title:'Alice',messages:[],teamLeadId:lead.id,teamMemberName:'Alice'}
    const bob: ChatSession = {id:'bob',title:'Bob',messages:[],teamLeadId:lead.id,teamMemberName:'Bob'}
    hoisted.storedSessions.value = [lead,alice,bob]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const intent = { id:'msg-1',source:{scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:alice.id},kind:'message',hop:1,recipient:bob.id,text:'来自 Alice 的问题',expiresAt:Date.now()+60000 }
    let queued = true, finish!: (value: {content:string}) => void
    hoisted.listAgentTeamMessagesMock.mockImplementation(async () => ({ intents: queued ? [intent] : [] }))
    hoisted.claimAgentTeamMessageMock.mockImplementation(async () => { if (!queued) return {}; queued = false; return { intent } })
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    renderChatPage({team:true})
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const request = hoisted.requestChatCompletionMock.mock.calls[0][0]
    expect(request.teamMember).toEqual({scope:'runtime-flow',thread:'runtime-pane',lead:lead.id,member:bob.id})
    expect(request.teamMessageHop).toBe(1)
    expect(request.messages.at(-1)?.content).toContain('来自 Alice 的问题')
    fireEvent.click(screen.getByRole('button',{name:'展开 Bob 详情'}))
    expect(await screen.findByText(/Alice → Bob · 请求已发起/)).toBeVisible()
    expect(screen.queryByText(/已收到响应（不代表送达）/)).not.toBeInTheDocument()
    await act(async () => { finish({content:'Bob 的答复'}) })
    expect(await screen.findByText(/Alice → Bob · 已收到响应（不代表送达）/)).toBeVisible()
    expect(hoisted.claimAgentTeamMessageMock).toHaveBeenCalledTimes(1)
  })

  it('leaves a task running if its member request fails instead of marking it done', async () => {
    const lead: ChatSession = {id:'failed-task-lead',title:'Lead',messages:[],profileId:'base-model',teamTasks:[{id:'task',title:'失败任务',ownerId:'failed-task-member',status:'pending',dependsOn:[]}]}
    const member: ChatSession = {id:'failed-task-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.requestChatCompletionMock.mockRejectedValueOnce(new Error('fixture failure'))
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    chooseAddMenuEntry('chat-composer-menu-team')
    fireEvent.click(screen.getByRole('button',{name:'执行 失败任务'}))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.messages.some(message=>String(message.content).includes('fixture failure'))).toBe(true))
    expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.teamTasks?.[0].status).toBe('running')
  })

  it('does not mark a task done when its member response cannot be saved', async () => {
    const lead: ChatSession = {id:'unsaved-task-lead',title:'Lead',messages:[],profileId:'base-model',teamTasks:[{id:'task',title:'需保存结果',ownerId:'unsaved-task-member',status:'pending',dependsOn:[]}]}
    const member: ChatSession = {id:'unsaved-task-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead,member]
    hoisted.failTaskResponseSave.value = member.id
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    hoisted.requestChatCompletionMock.mockResolvedValueOnce({content:'结果已返回但未保存'})
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    chooseAddMenuEntry('chat-composer-menu-team')
    fireEvent.click(screen.getByRole('button',{name:'执行 需保存结果'}))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('成员已有回复，但会话保存未确认，任务仍为进行中'))
    expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.teamTasks?.[0].status).toBe('running')
    expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.messages.some(message=>message.content==='结果已返回但未保存')).toBe(false)
  })

  it('does not dispatch a task whose claim commits after End', async () => {
    const lead: ChatSession = {id:'gated-task-lead',title:'Lead',messages:[],profileId:'base-model',teamTasks:[{id:'task',title:'等待结束',ownerId:'gated-task-member',status:'pending',dependsOn:[]}]}
    const member: ChatSession = {id:'gated-task-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let release!: () => void
    hoisted.migrationCommitGate.value = new Promise<void>(resolve => { release = resolve })
    renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button',{name:'执行 等待结束'}))
      await waitFor(() => expect(hoisted.migrationStarted.value).toBe(true))
      fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamEnded).toBe(true))
      await act(async () => { release(); hoisted.migrationCommitGate.value = null })
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamTasks?.[0].status).toBe('pending')
    } finally { hoisted.migrationCommitGate.value = null; release?.() }
  })

  it('keeps an already dispatched member request alive through End and denies later sends', async () => {
    const lead: ChatSession = { id: 'end-live-lead', title: 'Lead', messages: [], profileId: 'base-model', teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: false } }
    const member: ChatSession = { id: 'end-live-member', title: 'writer', messages: [], teamLeadId: lead.id, teamMemberName: 'writer', teamRole: '文案' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    let finish!: (value: { content: string }) => void
    let signal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce((request: { signal: AbortSignal }) => {
      signal = request.signal
      return new Promise(resolve => { finish = resolve })
    })
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '写一段文案' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(false)
    await openTeamManagement()
    fireEvent.click(screen.getByRole('button', { name: '结束团队' }))
    await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === lead.id)?.teamEnded).toBe(true))
    expect(signal?.aborted).toBe(false)
    await act(async () => { finish({ content: '已发请求的文案结果' }) })
    await waitFor(() => expect(hoisted.storedSessions.value.find(item => item.id === member.id)?.messages.some(message => message.content === '已发请求的文案结果')).toBe(true))
    await dispatchSwitchSession(member.id)
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '结束后不应执行' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('结束后不应执行')
  })

  it('rejects member creation that is still pending when the team ends', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model',teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:true}}
    hoisted.storedSessions.value=[lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    vi.mocked(createTeamMemberInDB).mockClear()
    const page = renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    let release!:()=>void
    hoisted.saveSessionToDBGate.value=new Promise(resolve=>{release=resolve})
    try {
      chooseAddMenuEntry('chat-composer-menu-add-member')
      fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'waiting'}})
      fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'do work'}})
      fireEvent.click(screen.getByRole('button',{name:'确认创建成员'}))
      await waitFor(()=>expect(screen.getByRole('button',{name:'确认创建成员'})).toBeDisabled())
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
      await waitFor(() => expect(hoisted.storedSessions.value.find(session => session.id === lead.id)?.teamEnded).toBe(true))
      await act(async()=>{release();hoisted.saveSessionToDBGate.value=null})
      await waitFor(()=>expect(createTeamMemberInDB).toHaveReturnedTimes(1))
      const committedCreate = vi.mocked(createTeamMemberInDB).mock.results[0].value
      await expect(committedCreate).rejects.toThrow('Team changed')
      // End unmounts the creation form; it must not resurrect its old error UI.
      expect(screen.queryByText('无法创建：请检查唯一成员名、范围或并发上限。')).not.toBeInTheDocument()
      expect(hoisted.storedSessions.value.some(session=>session.teamMemberName==='waiting' && !session.archived)).toBe(false)
      expect(screen.queryByRole('button',{name:/waiting.*空闲/})).toBeNull()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { hoisted.saveSessionToDBGate.value = null; release(); page.unmount() }
  })
  it('keeps an existing member archived when its in-flight save resumes after End', async () => {
    const lead: ChatSession = { id: 'saving-lead', title: 'Lead', messages: [], profileId: 'base-model', teamSettings: { maxMembers: 6, defaultModel: null, autoCleanup: true } }
    const member: ChatSession = { id: 'saving-writer', title: 'Writer', messages: [], teamLeadId: lead.id, teamMemberName: 'Writer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(true)
    let finish!: (value: unknown) => void
    let pending!: { onEvent: (event: unknown) => void }
    hoisted.requestChatCompletionStreamMock.mockImplementationOnce(input => {
      pending = input
      return new Promise(resolve => { finish = resolve })
    })
    const page = renderChatPage({ team: true })
    let release!: () => void
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      vi.mocked(saveSessionToDB).mockClear()
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { release = resolve })
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '@Writer pending save' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(pending).toBeDefined())
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(member.id))
      const save = vi.mocked(saveSessionToDB)
      const saveIndex = save.mock.calls.findIndex(([session]) => session.id === member.id)
      expect(saveIndex).toBeGreaterThanOrEqual(0)
      const inFlightSave = save.mock.results[saveIndex].value
      await openTeamManagement()
      fireEvent.click(screen.getByRole('button', { name: '结束团队' }))
      await waitFor(() => expect(hoisted.storedSessions.value.find(session => session.id === lead.id)?.teamEnded).toBe(true))
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)).toMatchObject({ archived: true, teamLifecycleRevision: 1 })
      hoisted.saveSessionToDBGate.value = null
      await act(async () => { release() })
      await expect(inFlightSave).rejects.toThrow('Session lifecycle changed')
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)).toMatchObject({ archived: true, teamLifecycleRevision: 1 })
      expect(screen.queryByRole('button', { name: '打开 Writer' })).not.toBeInTheDocument()
    } finally {
      hoisted.saveSessionToDBGate.value = null
      release?.()
      finish?.({ result: { content: 'cleanup' }, response: 'cleanup' })
      page.unmount()
    }
  })

  it('renders a creation error while a live team remains available', async()=>{
    const lead:ChatSession={id:'team-create-error',title:'Lead',messages:[],profileId:'base-model'}
    hoisted.storedSessions.value=[lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    const create=vi.mocked(createTeamMemberInDB)
    create.mockClear()
    create.mockRejectedValueOnce(new Error('Team changed'))
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    chooseAddMenuEntry('chat-composer-menu-add-member')
    fireEvent.change(screen.getByLabelText('成员名'),{target:{value:'waiting'}})
    fireEvent.change(screen.getByLabelText('角色 / 当前任务'),{target:{value:'do work'}})
    fireEvent.click(screen.getByRole('button',{name:'确认创建成员'}))
    expect(await screen.findByText('无法创建：请检查唯一成员名、范围或并发上限。')).toBeVisible()
    expect(screen.getByLabelText('成员名')).toHaveValue('waiting')
    expect(screen.getByLabelText('角色 / 当前任务')).toHaveValue('do work')
    expect(create).toHaveBeenCalledTimes(1)
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('keeps terminated members archived when selecting a lead that needs normalization', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'missing-model',teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:true}}
    const member:ChatSession={id:'team-member',title:'writer',messages:[{role:'user',content:'keep history'},{role:'assistant',content:''}],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.profileId).toBe('missing-model')
    chooseAddMenuEntry('chat-composer-menu-team')
    fireEvent.click(screen.getByRole('button',{name:'结束团队'}))
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    expect(screen.queryByRole('button',{name:/writer.*空闲/})).toBeNull()
    await waitFor(()=>expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.archived).toBe(true))
    expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.messages[0]).toEqual({role:'user',content:'keep history'})
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('branches a member into a standalone conversation instead of copying team membership',async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model',teamGeneration:1}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',teamMemberGeneration:1,teamRole:'writer',memberModelChoice:{version:1,profileId:'vision-model'}}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'/branch'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(screen.getByTestId('replay-confirmation')).toBeVisible())
    fireEvent.click(screen.getByRole('button',{name:'Create separate conversation'}))
    await waitFor(()=>expect(readCurrentSessionState()?.id).not.toBe(member.id))
    expect(readCurrentSessionState()?.teamLeadId).toBeUndefined()
    expect(readCurrentSessionState()?.teamMemberName).toBeUndefined()
    expect(readCurrentSessionState()?.memberModelChoice).toBeUndefined()
    expect(readCurrentSessionState()?.teamMemberGeneration).toBeUndefined()
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('uses the live lead model rather than member or team overrides', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model',teamSettings:{maxMembers:6,defaultModel:'vision-model',autoCleanup:false}}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'vision-model',skillId:'forged-skill'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'member request'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.requestChatCompletionMock.mock.calls[0][0].profileId).toBe('base-model')
  })
  it.each([false, true])('uses the target member profile effort when the lead composer sends (stream=%s)', async stream => {
    hoisted.availableProfiles.value = [
      {id:'lead-codex', model_name:'Lead Codex', model_use:'chat' as const, call_type:'codex'},
      {id:'member-codex', model_name:'Member Codex', model_use:'chat' as const, call_type:'codex'}
    ]
    const lead: ChatSession = {id:'effort-lead',title:'Lead',messages:[],profileId:'lead-codex'}
    const member: ChatSession = {id:'effort-writer',title:'文案',messages:[],teamLeadId:lead.id,teamMemberName:'文案',memberModelChoice:{version:1,profileId:'member-codex'}}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem('chat.reasoningEffort', JSON.stringify({'lead-codex':'low','member-codex':'high'}))
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'@文案 write a tagline'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      const request = stream ? hoisted.requestChatCompletionStreamMock : hoisted.requestChatCompletionMock
      await waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      expect(request.mock.calls[0][0]).toMatchObject({profileId:'member-codex', reasoningEffort:'high'})
    } finally { page.unmount() }
  })

  it('uses an explicitly selected member model while continuing to inherit the lead skill', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model',teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false}}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'base-model',skillId:'forged-skill',memberModelChoice:{version:1,profileId:'vision-model'}}
    hoisted.storedSessions.value=[lead,member]
    hoisted.currentConfig.value!.llm_config.api_profiles=[
      {id:'base-model',model_name:'Lead',base_url:'http://127.0.0.1',api_key:'fixture',model_use:'chat'},
      {id:'vision-model',model_name:'Member',base_url:'http://127.0.0.1',api_key:'fixture',model_use:'vision'}
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'member request'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.requestChatCompletionMock.mock.calls[0][0].profileId).toBe('vision-model')
    expect(hoisted.requestChatCompletionMock.mock.calls[0][0].skillRuntime?.skillId).not.toBe('forged-skill')
  })
  it.each([false, true])('blocks a versioned member model before direct send without consuming the draft (stream=%s)', async stream => {
    const lead: ChatSession = { id:'team-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId:'vision-model'}} }
    const member: ChatSession = { id:'team-member', title:'writer', messages:[], teamLeadId:lead.id, teamMemberName:'writer' }
    hoisted.storedSessions.value = [lead, member]
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'do not send this draft'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('do not send this draft')
    expect(readCurrentSessionState()?.messages).toEqual([])
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('keeps an @member draft when a versioned member model is unavailable', async () => {
    const lead: ChatSession = { id:'blocked-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId:'vision-model'}} }
    const member: ChatSession = { id:'blocked-member', title:'writer', messages:[], teamLeadId:lead.id, teamMemberName:'writer' }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({team:true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'@writer retain this task'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer retain this task')
    expect(readCurrentSessionState()?.messages).toEqual([])
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('keeps an @member draft when its explicitly selected model is no longer available', async () => {
    const lead: ChatSession = {id:'missing-choice-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'missing-choice-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',memberModelChoice:{version:1,profileId:'removed-profile'}}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'@writer retain this draft'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer retain this draft')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)?.messages).toEqual([])
    } finally { page.unmount() }
  })
  it('keeps a new @member draft if that member is already running', async () => {
    const lead: ChatSession = {id:'busy-choice-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'busy-choice-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    let finish!: (value:{content:string}) => void
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      const input = screen.getByTestId('chat-composer-input-mock')
      fireEvent.change(input, {target:{value:'@writer first task'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      fireEvent.change(input, {target:{value:'@writer second task'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('成员正在处理其他请求，请稍后重试。')
      expect(input).toHaveValue('@writer second task')
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      await act(async () => finish({content:'first finished'}))
    } finally { finish?.({content:'cleanup'}); page.unmount() }
  })
  it.each(['attachment','hidden'] as const)('keeps an @member draft with %s rather than silently dropping context', async kind => {
    const attachment: ChatAttachment = {type:'image',url:'data:image/png;base64,AA==',fileName:'fixture.png'}
    const lead: ChatSession = {id:'context-choice-lead',title:'Lead',messages:[],profileId:'base-model',draft:{inputValue:'@writer preserve context',pendingAttachments:kind === 'attachment' ? [attachment] : [],pendingHiddenContext:kind === 'hidden' ? 'private context' : '',updatedAt:1}}
    const member: ChatSession = {id:'context-choice-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer preserve context'))
      if (kind === 'attachment') await waitFor(() => expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1'))
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('团队指派暂不支持附件或隐藏上下文，请先处理后重试。')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer preserve context')
      if (kind === 'attachment') expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { page.unmount() }
  })
  it('retains an @member draft and reports a rejected asynchronous preparation', async () => {
    const lead: ChatSession = {id:'reject-choice-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'reject-choice-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    hoisted.resolveSkillRuntimeResourceEntriesMock.mockRejectedValueOnce(new Error('fixture preparation rejected'))
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'@writer preserve on rejection'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.notifyErrorMock).toHaveBeenCalledWith('fixture preparation rejected'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer preserve on rejection')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)?.messages).toEqual([])
    } finally { page.unmount() }
  })
  it.each(['edit','switch','switch-back'] as const)('does not clear or send an @member draft after a preflight %s', async change => {
    const lead: ChatSession = {id:'draft-race-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'draft-race-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    let release!: () => void
    const gate = {gate:new Promise<void>(resolve => { release = resolve }),entered:false}
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      hoisted.teamPreflightReadGate.value = gate
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'@writer first version'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(gate.entered).toBe(true))
      if (change === 'edit') fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'newer draft'}})
      else {
        fireEvent.click(screen.getByRole('button', {name:'打开 writer'}))
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
        if (change === 'switch-back') {
          fireEvent.click(screen.getByRole('button', {name:/返回组长/}))
          await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
          await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer first version'))
        }
      }
      await act(async () => { hoisted.teamPreflightReadGate.value = null; release() })
      await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(hoisted.storedSessions.value.find(session => session.id === member.id)?.messages).toEqual([])
      if (change === 'edit') expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('newer draft')
      else {
        if (change === 'switch') {
          fireEvent.click(screen.getByRole('button', {name:/返回组长/}))
          await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
        }
        await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@writer first version'))
      }
    } finally { hoisted.teamPreflightReadGate.value = null; release(); page.unmount() }
  })
  it('keeps a newer lead draft durable when background channel delivery begins', async () => {
    const lead: ChatSession = {id:'background-draft-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member: ChatSession = {id:'background-draft-writer',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    let release!: () => void
    const gate = {gate:new Promise<void>(resolve => { release = resolve }),entered:false}
    hoisted.teamPreflightReadGate.value = gate
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      await openTeamManagement()
      await waitFor(() => expect(screen.getByRole('checkbox', {name:'writer'})).toBeChecked())
      fireEvent.change(screen.getByLabelText('频道消息'), {target:{value:'background work'}})
      fireEvent.click(screen.getByRole('button', {name:'广播给订阅成员'}))
      await waitFor(() => expect(gate.entered).toBe(true))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'new lead draft'}})
      await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 100)) })
      await act(async () => { hoisted.teamPreflightReadGate.value = null; release() })
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(hoisted.draftBackups.value[`runtime-flow:${lead.id}`]?.draft?.inputValue).toBe('new lead draft'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('new lead draft')
    } finally { hoisted.teamPreflightReadGate.value = null; release(); page.unmount() }
  })
  it.each([false, true])('rechecks a newly stored marker after member request preparation (stream=%s)', async stream => {
    const lead: ChatSession = { id:'late-marker-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false} }
    const member: ChatSession = { id:'late-marker-member', title:'writer', messages:[], teamLeadId:lead.id, teamMemberName:'writer' }
    hoisted.storedSessions.value = [lead, member]
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    let release!: () => void
    const gate = { gate: new Promise<void>(resolve => { release = resolve }), entered: false }
    hoisted.teamBeforeDispatchGate.value = gate
    const page = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target:{value:'prepare first'}})
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(gate.entered).toBe(true))
      hoisted.storedSessions.value = hoisted.storedSessions.value.map(session => session.id === lead.id
        ? { ...session, teamSettings: { ...session.teamSettings!, memberModelSelection: { version: 1, profileId:'vision-model' } } }
        : session)
      await act(async () => { release() })
      await waitFor(() => expect(hoisted.notifyErrorMock).toHaveBeenCalledWith('Team ended or changed before dispatch.'))
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    } finally { hoisted.teamBeforeDispatchGate.value = null; release(); page.unmount() }
  })
  it.each(['missing','unrunnable','3d'] as const)('fails closed when the confirmed member model is %s', async reason=>{
    const profileId=reason==='3d'?'hunyuan3d-pro':'vision-model'
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model',teamSettings:{maxMembers:6,defaultModel:null,autoCleanup:false,memberModelSelection:{version:1,profileId}}}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value=[lead,member]
    hoisted.currentConfig.value!.llm_config.api_profiles=reason==='unrunnable'?[{id:'vision-model',model_name:'Member',base_url:'',api_key:'',model_use:'vision'}]:[]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'do not send'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it.each(['unset','archived-lead','archived-member','missing','nested','hunyuan'] as const)('denies a member request when team owner is %s',async reason=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:reason==='unset'?undefined:reason==='hunyuan'?'hunyuan3d-pro':'base-model',archived:reason==='archived-lead',teamLeadId:reason==='nested'?'other':undefined}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'vision-model',archived:reason==='archived-member'}
    hoisted.storedSessions.value=reason==='missing'?[member]:[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'should not run'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('lets an admitted member run finish when the lead model changes', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'base-model'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let observedSignal:AbortSignal|undefined
    let finish!:(result:{content:string})=>void
    hoisted.requestChatCompletionMock.mockImplementationOnce(({signal}:{signal:AbortSignal})=>new Promise(resolve=>{
      observedSignal=signal
      finish=resolve
    }))
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@writer assigned work'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(observedSignal).toBeDefined())
    await act(async()=>window.dispatchEvent(new CustomEvent('chat:append-message',{detail:{scope:'runtime-flow',sessionId:lead.id,role:'assistant',content:'ordinary activity'}})))
    fireEvent.click(screen.getByTestId('select-vision-model'))
    expect(observedSignal?.aborted).toBe(false)
    await act(async()=>finish({content:'completed under the original settings'}))
    await waitFor(()=>expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.messages.some(message=>message.content==='completed under the original settings')).toBe(true))
  })
  it('keeps the admitted result if lead settings change away and back', async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'base-model'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let signal:AbortSignal|undefined
    let finish!:(result:{content:string})=>void
    hoisted.requestChatCompletionMock.mockImplementationOnce((input:{signal:AbortSignal})=>new Promise(resolve=>{signal=input.signal;finish=resolve}))
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@writer work'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(signal).toBeDefined())
    fireEvent.click(screen.getByTestId('select-vision-model'))
    fireEvent.click(screen.getByTestId('select-base-model'))
    expect(signal?.aborted).toBe(false)
    await act(async()=>finish({content:'admitted result'}))
    await waitFor(()=>expect(hoisted.storedSessions.value.find(session=>session.id===member.id)?.messages.some(message=>message.content==='admitted result')).toBe(true))
  })
  it('denies explicit member tool commands before dispatch',async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),member.id)
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'/tool session.status'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('成员会话暂不支持直接运行工具'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('refuses remote team member sends before dispatch', async () => {
    const lead: ChatSession = { id: 'team-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'team-member', title: 'writer', messages: [], teamLeadId: lead.id, teamMemberName: 'writer' }
    hoisted.storedSessions.value = [lead, member]
    hoisted.currentConfig.value!.use_remote_llm = true
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Please write copy' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('团队成员暂不支持远程模型'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('refuses an inherited external Agent transport before member dispatch', async () => {
    const lead: ChatSession = { id: 'team-lead', title: 'Lead', messages: [], profileId: 'base-model', skillId: 'external-fixture' }
    const member: ChatSession = { id: 'team-member', title: 'writer', messages: [], teamLeadId: lead.id, teamMemberName: 'writer' }
    const config = createConfig()
    hoisted.currentConfig.value = { ...config, llm_config: { ...config.llm_config, customSkills: [
      { id: 'external-fixture', category: 'fixture', skillName: 'external', prompt: '', type: 'agent', apiAddress: 'http://127.0.0.1/unused' }
    ] } }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    renderChatPage({ team: true })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'Please write copy' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('团队成员暂不支持外部 Agent 传输，请使用组长的本地模型'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('revokes preflight when lead model changes away and back before resources resolve',async()=>{
    const lead:ChatSession={id:'team-lead',title:'Lead',messages:[],profileId:'base-model'}
    const member:ChatSession={id:'team-member',title:'writer',messages:[],teamLeadId:lead.id,teamMemberName:'writer',profileId:'base-model'}
    hoisted.storedSessions.value=[lead,member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    let release!:(value:never[])=>void
    hoisted.resolveSkillRuntimeResourceEntriesMock.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    renderChatPage({team:true})
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'),{target:{value:'@writer preflight'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(()=>expect(release).toBeDefined())
    fireEvent.click(screen.getByTestId('select-vision-model'))
    fireEvent.click(screen.getByTestId('select-base-model'))
    await act(async()=>release([]))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })
  it('revokes a lead preflight when an End notice discovers a conflicting local history', async () => {
    const lead: ChatSession = {id: 'lead-conflict', title: 'Lead', messages: [], profileId: 'base-model', teamSettings: {maxMembers: 6, defaultModel: null, autoCleanup: false}}
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    let release!: (value: never[]) => void
    hoisted.resolveSkillRuntimeResourceEntriesMock.mockImplementationOnce(() => new Promise(resolve => {release = resolve}))
    renderChatPage({team: true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target: {value: 'do not send after conflict'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(release).toBeDefined())
    let releaseSave!: () => void
    hoisted.debouncedSaveAllSessionsGate.value = new Promise(resolve => {releaseSave = resolve})
    await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {detail: {scope: 'runtime-flow', sessionId: lead.id, role: 'assistant', content: 'local edit'}})))
    hoisted.storedSessions.value = [{...lead, messages: [{role: 'user', content: 'other writer'}], teamGeneration: 1, teamLifecycleRevision: 1}]
    await act(async () => window.dispatchEvent(new CustomEvent('chat:team-lifecycle-ended', {detail: {scope: 'runtime-flow', leadId: lead.id}})))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('团队状态冲突，已保留本地更改'))
    await act(async () => release([]))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    expect(readCurrentSessionState()?.messages.some(message => message.content === 'local edit')).toBe(true)
    hoisted.debouncedSaveAllSessionsGate.value = null
    void releaseSave
  })

  it.each([false,true])('fails closed for a member send without consuming its draft (stream=%s)', async stream => {
    const lead: ChatSession = {id: 'ended-lead', title: 'Lead', messages: [], profileId: 'base-model'}
    const member: ChatSession = {id: 'ended-member', title: 'writer', messages: [], teamLeadId: lead.id, teamMemberName: 'writer'}
    hoisted.storedSessions.value = [lead, member]
    hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), member.id)
    renderChatPage({team: true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(member.id))
    hoisted.storedSessions.value = [{...lead,teamGeneration:1,teamLifecycleRevision:1},{...member,teamLifecycleRevision:1}]
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target: {value: 'unsent member draft'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('Team lead unavailable.'))
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('unsent member draft')
    expect(readCurrentSessionState()?.messages).toEqual([])
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    expect(hoisted.storedSessions.value.find(session=>session.id===lead.id)?.teamGeneration).toBe(1)
  })

  it('preserves an @member draft when the named member is unavailable', async () => {
    const lead: ChatSession = {id: 'disabled-lead', title: 'Lead', messages: [], profileId: 'base-model'}
    const member: ChatSession = {id: 'disabled-member', title: 'writer', messages: [], teamLeadId: lead.id, teamMemberName: 'writer'}
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    renderChatPage({team: true})
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {target: {value: '@absent unsent'}})
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('请选择唯一的成员名称并输入任务'))
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('@absent unsent')
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })

  it.each([false, true])('reconciles a dirty scope after missing End; conflicting history=%s', async (conflicting) => {
    const lead: ChatSession = {id:'return-lead', title:'Lead', messages:[], profileId:'base-model', teamSettings:{maxMembers:6, defaultModel:null, autoCleanup:false}}
    const other: ChatSession = {id:'other-scope', title:'Other', messages:[]}
    hoisted.storedSessions.value = [lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'other-scope'), other.id)
    const view = renderChatPage({team:true})
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      // Keep the mock writer gated throughout; this case checks reconciliation, not real CAS.
      hoisted.debouncedSaveAllSessionsGate.value = new Promise(() => {})
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {detail:{scope:'runtime-flow',sessionId:lead.id,role:'assistant',content:'keep locally'}})))
      await waitFor(() => expect(readCurrentSessionState()?.messages.some(message => message.content === 'keep locally')).toBe(true))
      hoisted.storedSessions.value = [other]
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="other-scope" /></ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(other.id))
      const ended = {...lead, messages: conflicting ? [{role:'user' as const, content:'external history'}] : [], teamEnded:true, teamGeneration:1, teamLifecycleRevision:1}
      hoisted.storedSessions.value = [ended]
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter>)
      if (conflicting) {
        await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('团队状态冲突，已保留本地更改'))
        expect(readCurrentSessionState()?.teamLifecycleRevision ?? 0).toBe(0)
      } else {
        await waitFor(() => expect(readCurrentSessionState()?.teamLifecycleRevision).toBe(1))
        expect(readCurrentSessionState()?.teamGeneration).toBe(1)
        expect(readCurrentSessionState()?.teamEnded).toBe(true)
      }
      expect(readCurrentSessionState()?.messages.some(message => message.content === 'keep locally')).toBe(true)
      expect(hoisted.storedSessions.value).toEqual([ended])
    } finally {
      view.unmount()
      hoisted.debouncedSaveAllSessionsGate.value = null
    }
  })

  it('selects a profile without discarding an immediately preceding session update', async () => {
    const lead: ChatSession={id:'profile-race',title:'Lead',messages:[],profileId:'base-model',sessionUrl:'old-continuation',sessionProfileId:'base-model'}
    hoisted.storedSessions.value=[lead]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID,'runtime-flow'),lead.id)
    renderChatPage()
    await waitFor(()=>expect(readCurrentSessionState()?.id).toBe(lead.id))
    await act(async()=>{
      window.dispatchEvent(new CustomEvent('chat:append-message',{detail:{scope:'runtime-flow',sessionId:lead.id,role:'assistant',content:'preserve this update'}}))
      fireEvent.click(screen.getByTestId('select-vision-model'))
    })
    await waitFor(()=>expect(readCurrentSessionState()?.profileId).toBe('vision-model'))
    expect(readCurrentSessionState()?.messages.some(message=>message.content==='preserve this update')).toBe(true)
    expect(readCurrentSessionState()?.sessionUrl).toBeUndefined()
    expect(readCurrentSessionState()?.sessionProfileId).toBeUndefined()
  })

  it('offers video workspace handoff without a model or generation request', async () => {
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/video_gen' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open video generation workspace' })).toBeVisible())
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })
  it('requires explicit slash compaction confirmation and rejects changed model configuration', async () => {
    const session: ChatSession = { id: 'slash-compact', title: 'Long', messages: Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant', content: `message ${index}`
    })) }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" />)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      const open = () => {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '/compact' } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      }
      await waitFor(() => expect(screen.getByTestId('chat-composer-compress-context-mock')).not.toBeDisabled())
      open()
      expect(JSON.stringify(hoisted.notifyWarningMock.mock.calls)).toBe('[]')
      expect(await screen.findByRole('button', { name: 'Confirm model compaction' })).toBeVisible()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      const configured = hoisted.currentConfig.value
      if (!configured) throw new Error('Fixture config missing')
      hoisted.currentConfig.value = { ...configured, llm_config: { ...configured.llm_config } }
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter>)
      fireEvent.click(screen.getByRole('button', { name: 'Confirm model compaction' }))
      expect(hoisted.notifyWarningMock).toHaveBeenLastCalledWith('Compaction unavailable or conversation changed.')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      open()
      fireEvent.click(screen.getByRole('button', { name: 'Confirm model compaction' }))
      await waitFor(() => expect(readCurrentSessionState()?.contextCompression?.manual).toBe(true))
      expect(readCurrentSessionState()?.compactedMessages?.length).toBeGreaterThan(0)
    } finally { view.unmount() }
  })

  it('compresses the current chat context from composer controls', async () => {
    const longSession: ChatSession = {
      id: 'long-session',
      title: 'Long session',
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index + 1}`
      }))
    }
    hoisted.storedSessions.value = [longSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      longSession.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(longSession.id))
    const compressButton = screen.getByTestId('chat-composer-compress-context-mock')
    expect(compressButton).not.toBeDisabled()

    fireEvent.click(compressButton)

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(6)
      expect(currentSession?.messages[0]?.content).toBe('message 7')
      expect(currentSession?.contextCompression?.summary).toContain('default reply')
      expect(currentSession?.contextCompression?.manual).toBe(true)
    })
    expect(hoisted.notifySuccessMock).toHaveBeenCalledWith('Context compressed.')
  })

  it('rejects an old refresh after a compaction commit and preserves compaction in the next save', async () => {
    const session: ChatSession = {
      id: 'compaction-ack-refresh-race', title: 'Compaction acknowledgement', profileId: 'base-model', createdAt: 302,
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant', content: `history ${index + 1}`
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const page = renderChatPage()
    let releaseSave!: () => void
    let releaseRead!: () => void
    let readStarted = false
    const originalDispatchEvent = window.dispatchEvent.bind(window)
    let compactRefreshSuppressed = false
    let dispatchSpy: ReturnType<typeof vi.spyOn> | undefined
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      // Hold the background debounce independently: only the compact job can reach this save gate.
      hoisted.debouncedSaveAllSessionsGate.value = new Promise(() => {})
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { releaseSave = resolve })
      fireEvent.click(screen.getByTestId('chat-composer-compress-context-mock'))
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      expect(readCurrentSessionState()?.contextCompression?.manual).toBe(true)
      expect(hoisted.storedSessions.value[0]?.contextCompression).toBeUndefined()
      hoisted.loadAllSessionsMock.mockImplementationOnce(async () => {
        const snapshot = cloneValue(hoisted.storedSessions.value)
        readStarted = true
        await new Promise<void>(resolve => { releaseRead = resolve })
        return snapshot
      })
      await act(async () => window.dispatchEvent(new CustomEvent('chat:preview-refresh', {
        detail: { scope: 'runtime-flow', reason: 'storage-updated' }
      })))
      await waitFor(() => expect(readStarted).toBe(true))
      // Keep compaction's own preview event from starting another read. This models another valid
      // read source (e.g. polling) remaining pending rather than accidentally being rescued by the
      // compact job's later refresh; it does not change any save or epoch implementation.
      dispatchSpy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
        const detail = event instanceof CustomEvent ? event.detail as { scope?: string; reason?: string } : undefined
        if (event.type === 'chat:preview-refresh' && detail?.scope === 'runtime-flow' && detail.reason === 'storage-updated') {
          compactRefreshSuppressed = true
          return true
        }
        return originalDispatchEvent(event)
      })
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSave() })
      await waitFor(() => expect(hoisted.notifySuccessMock).toHaveBeenCalledWith('Context compressed.'))
      expect(compactRefreshSuppressed).toBe(true)
      expect(hoisted.storedSessions.value[0]?.contextCompression?.manual).toBe(true)
      expect(hoisted.latestSaveCallback.value).not.toBeNull()
      hoisted.saveSessionToDBGateStarted.value = null
      hoisted.saveSessionToDBGate.value = new Promise<void>(resolve => { releaseSave = resolve })
      const pending = hoisted.latestSaveCallback.value!(session.id, 'runtime-flow').catch(() => null)
      await waitFor(() => expect(hoisted.saveSessionToDBGateStarted.value).toBe(session.id))
      // The current compacted snapshot is still marked dirty, so this cannot establish that a
      // clean session is rolled back solely by the compaction acknowledgement.
      expect(hoisted.saveSuccessCount.value).toBe(0)
      await act(async () => releaseRead())
      expect(readCurrentSessionState()?.contextCompression?.manual).toBe(true)
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'after compaction' }
      })))
      await act(async () => { hoisted.saveSessionToDBGate.value = null; releaseSave(); await pending })
      hoisted.debouncedSaveAllSessionsGate.value = null
      // Invoke the actual registered writer for the edited live session, not a captured old clone.
      await act(async () => { await hoisted.latestSaveCallback.value!(session.id, 'runtime-flow') })
      expect(hoisted.storedSessions.value[0]?.contextCompression?.manual).toBe(true)
      expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'after compaction')).toBe(true)
    } finally {
      releaseRead?.(); releaseSave?.()
      dispatchSpy?.mockRestore()
      hoisted.saveSessionToDBGate.value = null
      hoisted.debouncedSaveAllSessionsGate.value = null
      page.unmount()
    }
  })

  it('preserves assistant images through manual compaction and the next request', async () => {
    const assistantImage = createImageAttachment('assistant-generated.png')
    const session: ChatSession = {
      id: 'manual-assistant-image-session',
      title: 'Manual assistant image session',
      profileId: 'base-model',
      messages: Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
        content: `history message ${index + 1}`,
        ...(index === 1 ? { attachments: [assistantImage] } : {})
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.click(screen.getByTestId('chat-composer-compress-context-mock'))

    await waitFor(() => {
      const compression = readCurrentSessionState()?.contextCompression
      expect(compression?.manual).toBe(true)
      expect(compression?.replayImageMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            attachments: [expect.objectContaining({ url: assistantImage.url })]
          })
        ])
      )
    })
    await waitFor(() =>
      expect(hoisted.storedSessions.value[0]?.contextCompression?.replayImageMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            attachments: [expect.objectContaining({ url: assistantImage.url })]
          })
        ])
      )
    )

    await waitFor(() => expect(hoisted.notifySuccessMock).toHaveBeenCalledWith('Context compressed.'))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'edit the generated image' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    let requestMessages: ChatMessage[] | undefined
    await waitFor(() => {
      requestMessages = hoisted.requestChatCompletionMock.mock.calls
        .map(call => call[0]?.messages as ChatMessage[] | undefined)
        .find(messages => messages?.some(message => message.content === 'edit the generated image'))
      expect(requestMessages).toBeDefined()
    })
    expect(requestMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          attachments: [expect.objectContaining({ url: assistantImage.url })]
        })
      ])
    )
  })
  it('sends manual compressed context with the next request', async () => {
    const compressedSession: ChatSession = {
      id: 'compressed-session',
      title: 'Compressed session',
      messages: [
        { role: 'user', content: 'recent question' },
        { role: 'assistant', content: 'recent answer' }
      ],
      contextCompression: {
        summary: 'manual summary context',
        coveredMessageCount: 4,
        sourceHash: 'manual-hash',
        estimatedSourceTokens: 120,
        estimatedSummaryTokens: 8,
        updatedAt: Date.now(),
        manual: true
      }
    }
    hoisted.storedSessions.value = [compressedSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      compressedSession.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(compressedSession.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'continue with compressed context' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const messages = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]?.messages as
      Array<{ role?: string; content?: string; hiddenContext?: string }> | undefined
    expect(messages?.[messages.length - 1]).toEqual(
      expect.objectContaining({
        role: 'user',
        content: 'continue with compressed context',
        hiddenContext: expect.stringContaining('manual summary context')
      })
    )
  })

  it('uses the current chat profile for manual compaction and normal requests', async () => {
    hoisted.availableProfiles.value = [
      { id: 'base-model', model_name: 'GPT-4o', model_use: 'chat' as const },
      { id: 'translation-model', model_name: 'Translation Model', model_use: 'chat' as const }
    ]
    const longSession: ChatSession = {
      id: 'compact-profile-session',
      title: 'Compact profile session',
      profileId: 'base-model',
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `profile message ${index + 1}`
      }))
    }
    hoisted.storedSessions.value = [longSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      longSession.id
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'),
      'base-model'
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(longSession.id))
    fireEvent.click(screen.getByTestId('chat-composer-compress-context-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect(readCurrentSessionState()?.contextCompression?.summary).toContain('default reply')
    )
    const compactCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as
      { profileId?: string; conversationId?: string; maxOutputTokens?: number } | undefined
    expect(compactCall).toEqual(
      expect.objectContaining({
        profileId: 'base-model',
        maxOutputTokens: 4_000
      })
    )
    expect(compactCall?.conversationId).toContain(`${longSession.id}:compact:`)

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'normal request after compact' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    const normalCall = hoisted.requestChatCompletionMock.mock.calls[1]?.[0] as
      | {
          profileId?: string
          messages?: Array<{ hiddenContext?: string; content?: string }>
        }
      | undefined
    expect(normalCall?.profileId).toBe('base-model')
    expect(normalCall?.messages?.[normalCall.messages.length - 1]).toEqual(
      expect.objectContaining({
        content: 'normal request after compact',
        hiddenContext: expect.stringContaining('default reply')
      })
    )
  })

  it('starts background compact from real provider token usage', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'base-model',
        model_name: 'GPT-4o',
        model_use: 'chat' as const,
        context_window_tokens: 20_000,
        context_budget_tokens: 15_000
      }
    ]
    const activityEvents: Array<Record<string, unknown>> = []
    const handleActivity = (event: Event) => {
      activityEvents.push((event as CustomEvent<Record<string, unknown>>).detail)
    }
    window.addEventListener('chat:activity', handleActivity)
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      async ({ conversationId }: { conversationId?: string }) => {
        if (String(conversationId || '').includes(':compact:')) {
          return {
            content: 'usage compact summary',
            usage: { promptTokens: 320, totalTokens: 420 }
          }
        }
        return {
          content: 'main usage response',
          usage: { promptTokens: 16_000, totalTokens: 16_500 }
        }
      }
    )
    const session: ChatSession = {
      id: 'usage-trigger-session',
      title: 'Usage trigger session',
      profileId: 'base-model',
      messages: Array.from({ length: 10 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `usage message ${index + 1}`
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'),
      'base-model'
    )

    try {
      renderChatPage()

      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: 'trigger compact from real usage' }
      })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      const normalCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as
        { profileId?: string } | undefined
      const compactCall = hoisted.requestChatCompletionMock.mock.calls[1]?.[0] as
        { profileId?: string; maxOutputTokens?: number; conversationId?: string } | undefined
      expect(normalCall?.profileId).toBe('base-model')
      expect(compactCall).toEqual(
        expect.objectContaining({
          profileId: 'base-model',
          maxOutputTokens: 512
        })
      )
      expect(compactCall?.conversationId).toContain(`${session.id}:compact:`)

      await waitFor(() => {
        const currentSession = readCurrentSessionState()
        expect(currentSession?.contextCompression?.summary).toContain('usage compact summary')
        expect(currentSession?.contextCompression?.lastPromptTokens).toBe(320)
        expect(currentSession?.contextCompression?.lastTotalTokens).toBe(420)
      })
      await waitFor(() => {
        expect(hoisted.storedSessions.value[0]?.contextCompression?.summary).toContain(
          'usage compact summary'
        )
      })
      await waitFor(() => {
        expect(activityEvents.map((event) => event.type)).toEqual(
          expect.arrayContaining(['send_progress', 'compact_start', 'compact_complete'])
        )
      })
      expect(
        activityEvents.some(
          (event) =>
            event.type === 'send_progress' &&
            event.promptTokens === 16_000 &&
            event.totalTokens === 16_500 &&
            event.triggerTokens === 15_000
        )
      ).toBe(true)
    } finally {
      window.removeEventListener('chat:activity', handleActivity)
    }
  })

  it.each([
    { label: 'short history', historySize: 1, expected: '当前预览无需压缩' },
    { label: 'long history', historySize: 20, expected: '预计需要压缩' }
  ])('shows an estimated next-request context preview for $label, not an executed compression', async ({ historySize, expected }) => {
    hoisted.availableProfiles.value = [{
      id: 'base-model', model_name: 'GPT-4o', model_use: 'chat',
      context_window_tokens: 20_000, context_budget_tokens: 15_000
    }]
    const session: ChatSession = {
      id: 'preview-session', title: 'Preview session', profileId: 'base-model',
      messages: Array.from({ length: historySize }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: historySize > 1 ? `Message ${index} ${'example content '.repeat(350)}` : 'short history'
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    const indicator = await screen.findByTestId('chat-context-compression-indicator')
    expect(indicator).toHaveAttribute('aria-label', expect.stringContaining('预计下次请求'))
    fireEvent.mouseOver(indicator)
    const hint = await screen.findByText(new RegExp(expected))
    expect(hint).toBeVisible()
    expect(screen.getByText(/估算约/)).toBeVisible()
    expect(screen.queryByText(/自动压缩已生效|已用/)).not.toBeInTheDocument()
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('hides the context preview when the selected profile has no known context budget', async () => {
    hoisted.availableProfiles.value = [{ id: 'base-model', model_name: 'unrecognized-fixture-model', model_use: 'chat' }]
    const session: ChatSession = { id: 'unknown-context', title: 'Unknown context', profileId: 'base-model', messages: [] }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    expect(screen.queryByTestId('chat-context-compression-indicator')).not.toBeInTheDocument()
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('labels a budget-only preview as a budget rather than a model window', async () => {
    hoisted.availableProfiles.value = [{ id: 'base-model', model_name: 'unrecognized-fixture-model', model_use: 'chat', context_budget_tokens: 15_000 }]
    const session: ChatSession = { id: 'budget-only', title: 'Budget only', profileId: 'base-model', messages: [] }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    const indicator = await screen.findByTestId('chat-context-compression-indicator')
    expect(indicator).toHaveAttribute('aria-label', expect.stringContaining('上下文预算'))
    expect(indicator).not.toHaveAttribute('aria-label', expect.stringContaining('上下文窗口'))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('updates the context preview when the selected profile configuration changes', async () => {
    const profile = { id: 'base-model', model_name: 'fixture-model', model_use: 'chat' as const, context_window_tokens: 20_000, context_budget_tokens: 15_000 }
    hoisted.availableProfiles.value = [profile]
    const session: ChatSession = { id: 'changing-context', title: 'Changing context', profileId: profile.id, messages: [] }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), profile.id)
    const ui = () => <MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope="runtime-flow" /></ThemeProvider></MemoryRouter>
    const page = render(ui())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    expect(screen.getByTestId('chat-context-compression-indicator')).toBeInTheDocument()
    hoisted.availableProfiles.value = [{ id: profile.id, model_name: 'unrecognized-fixture-model', model_use: 'chat' }]
    page.rerender(ui())
    await waitFor(() => expect(screen.queryByTestId('chat-context-compression-indicator')).not.toBeInTheDocument())
    hoisted.availableProfiles.value = [profile]
    page.rerender(ui())
    await waitFor(() => expect(screen.getByTestId('chat-context-compression-indicator')).toBeInTheDocument())
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('updates the context preview after selecting a different model', async () => {
    hoisted.availableProfiles.value = [
      { id: 'base-model', model_name: 'fixture-base', model_use: 'chat', context_window_tokens: 20_000, context_budget_tokens: 15_000 },
      { id: 'vision-model', model_name: 'unknown-fixture-vision', model_use: 'vision', is_vision_model: true }
    ]
    const session: ChatSession = { id: 'model-preview', title: 'Model preview', profileId: 'base-model', messages: [] }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'), 'base-model')
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('base-model'))
    expect(screen.getByTestId('chat-context-compression-indicator')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('select-vision-model'))
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('vision-model'))
    expect(screen.queryByTestId('chat-context-compression-indicator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('select-base-model'))
    await waitFor(() => expect(readCurrentSessionState()?.profileId).toBe('base-model'))
    expect(screen.getByTestId('chat-context-compression-indicator')).toBeInTheDocument()
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
  })

  it('does not trigger compact from aggregate usage when context usage stays below the threshold', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'base-model',
        model_name: 'GPT-4o',
        model_use: 'chat' as const,
        context_window_tokens: 44,
        context_budget_tokens: 33
      }
    ]
    const activityEvents: Array<Record<string, unknown>> = []
    const handleActivity = (event: Event) => {
      activityEvents.push((event as CustomEvent<Record<string, unknown>>).detail)
    }
    window.addEventListener('chat:activity', handleActivity)
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'below-threshold response',
      usage: { promptTokens: 33, completionTokens: 5, totalTokens: 38 },
      contextUsage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 }
    })
    const session: ChatSession = {
      id: 'below-threshold-session',
      title: 'Below threshold session',
      profileId: 'base-model',
      messages: [{ role: 'user', content: 'previous message' }]
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_SELECTED_PROFILE, 'runtime-flow'),
      'base-model'
    )

    try {
      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: 'stay below the context threshold' }
      })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      await waitFor(() =>
        expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('below-threshold response')
      )
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      expect(activityEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'send_progress',
            promptTokens: 20,
            totalTokens: 23,
            triggerTokens: 33
          })
        ])
      )
      expect(activityEvents.some((event) => event.type === 'compact_start')).toBe(false)
    } finally {
      window.removeEventListener('chat:activity', handleActivity)
    }
  })
  it('aborts in-flight compact without writing a summary or showing an error toast', async () => {
    let observedSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          const abortWithError = () => {
            const error = new Error('aborted compact')
            error.name = 'AbortError'
            reject(error)
          }

          if (!signal) {
            reject(new Error('Expected compact abort signal'))
            return
          }

          if (signal.aborted) {
            abortWithError()
            return
          }

          signal.addEventListener('abort', abortWithError, { once: true })
        })
    )
    const longSession: ChatSession = {
      id: 'abort-compact-session',
      title: 'Abort compact session',
      messages: Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `abort message ${index + 1}`
      }))
    }
    hoisted.storedSessions.value = [longSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      longSession.id
    )

    renderChatPage()

    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(longSession.id))
    fireEvent.click(screen.getByTestId('chat-composer-compress-context-mock'))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-session', {
          detail: {
            scope: 'runtime-flow',
            sessionId: longSession.id
          }
        })
      )
    })

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await waitFor(() => expect(hoisted.notifyErrorMock).not.toHaveBeenCalled())
    const currentSession = readCurrentSessionState()
    expect(currentSession?.id).toBe(longSession.id)
    expect(currentSession?.messages).toHaveLength(12)
    expect(currentSession?.contextCompression).toBeUndefined()
    expect(hoisted.storedSessions.value[0]?.contextCompression).toBeUndefined()
  })

  it('sends the latest composer ref before the delayed input state commit', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'send before debounce commit' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const messages = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]?.messages as
      Array<{ role?: string; content?: string }> | undefined
    expect(messages?.[messages.length - 1]).toEqual(
      expect.objectContaining({ role: 'user', content: 'send before debounce commit' })
    )
    await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
  })

  it('keeps a newer draft after an accepted normal send clears the old draft', async () => {
    let finishRequest: ((value: { content: string }) => void) | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRequest = resolve
        })
    )
    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const input = screen.getByTestId('chat-composer-input-mock')
    fireEvent.change(input, { target: { value: 'accepted old draft' } })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    try {
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(input).toHaveValue(''))
      fireEvent.change(input, { target: { value: 'new draft while the reply is pending' } })
      await act(async () => finishRequest?.({ content: 'accepted old reply' }))
      await waitFor(() =>
        expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('accepted old reply')
      )
      expect(input).toHaveValue('new draft while the reply is pending')
    } finally {
      finishRequest?.({ content: 'accepted old reply' })
    }
  })

  it('preserves an unsendable draft when local validation rejects a normal send', async () => {
    // Finish async session initialization and the composer's inputSyncKey effect
    // before editing. A visible session alone does not flush pending effects.
    await act(async () => {
      renderChatPage()
    })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const sessionId = readCurrentSessionState()!.id
    const input = screen.getByTestId('chat-composer-input-mock')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(input).toHaveValue('   ')
    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    })
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    expect(input).toHaveValue('   ')
    expect(readCurrentSessionState()?.id).toBe(sessionId)
    expect(readCurrentSessionState()?.messages).toEqual([])
  })

  it('clears stale persisted loading placeholders after restart', async () => {
    const staleSession: ChatSession = {
      id: 'stale-loading-session',
      title: 'Restarted request',
      messages: [
        {
          role: 'user',
          content: 'This was interrupted by restart.'
        },
        {
          role: 'assistant',
          content: ''
        }
      ]
    }
    hoisted.storedSessions.value = [staleSession]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      staleSession.id
    )
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_LOADING_IDS, 'runtime-flow'),
      JSON.stringify([staleSession.id])
    )

    renderChatPage()

    await waitFor(() => {
      const calls = hoisted.chatMessageListMock.mock.calls
      const latestProps = calls[calls.length - 1]?.[0] as
        { currentSession?: ChatSession; isLoading?: boolean } | undefined
      expect(latestProps?.currentSession?.id).toBe(staleSession.id)
      expect(latestProps?.isLoading).toBe(false)
    })
    await waitFor(() =>
      expect(localStorage.getItem(scopedStorageKey(STORAGE_KEY_LOADING_IDS, 'runtime-flow'))).toBe(
        '[]'
      )
    )
  })

  it('keeps the current model selection when creating a new session in the same scope', async () => {
    const user = userEvent.setup()

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await user.click(await screen.findByTestId('select-vision-model'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-primary-selection-value').textContent).toBe('vision-model')
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })

    await dispatchNewSession({})

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('stores the responding model name on assistant replies', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      profileId: 'vision-model',
      initialMessage: 'Annotate the responder.'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages[1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: 'default reply',
          modelName: 'Vision Model'
        })
      )
    })
  })

  it('keeps six image-producing new sessions independently in flight and persists their durable results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      }))
    )
    hoisted.saveImageToDirMock.mockImplementation(async ({ fileName }) => ({
      savedPath: `C:/MagicPot/AutoSave/Agent/${fileName}`
    }))
    const requestIds = Array.from({ length: 6 }, (_, index) => `parallel-image-${index + 1}`)
    const completions = new Map<
      string,
      {
        signal?: AbortSignal
        resolve: (value: { content: string; attachments: ChatAttachment[] }) => void
      }
    >()
    const createdSessions = new Map<string, string>()
    const handleSessionCreated = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId?: string; sessionId?: string }>).detail
      if (detail.requestId && detail.sessionId)
        createdSessions.set(detail.requestId, detail.sessionId)
    }
    window.addEventListener('chat:session-created', handleSessionCreated)
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ conversationId, signal }: { conversationId?: string; signal?: AbortSignal }) =>
        new Promise((resolve) => {
          if (!conversationId) throw new Error('Expected a target session conversation id')
          completions.set(conversationId, { signal, resolve })
        })
    )

    try {
      renderChatPage()
      await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

      for (const [index, requestId] of requestIds.entries()) {
        await dispatchNewSession({
          requestId,
          title: `Parallel image ${index + 1}`,
          profileId: 'vision-model',
          initialMessage: `Generate image ${index + 1}`,
          initialAttachments: [createImageAttachment(`source-${index + 1}.png`)]
        })
      }

      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(6))
      await waitFor(() => expect(createdSessions.size).toBe(6))

      const sessionIds = requestIds.map((requestId) => createdSessions.get(requestId))
      expect(sessionIds.every(Boolean)).toBe(true)
      expect(new Set(sessionIds).size).toBe(6)
      expect(completions.size).toBe(6)
      expect(sessionIds.every((sessionId) => completions.has(sessionId!))).toBe(true)
      expect(
        sessionIds.every((sessionId) => completions.get(sessionId!)?.signal?.aborted === false)
      ).toBe(true)
      expect(new Set(readScopedActiveLoadingSessionIds('runtime-flow'))).toEqual(
        new Set(sessionIds)
      )
      const pendingSnapshots = sessionIds.map((sessionId) =>
        hoisted.storedSessions.value.find((session) => session.id === sessionId)
      )
      expect(pendingSnapshots.every(Boolean)).toBe(true)
      expect(
        pendingSnapshots.every(
          (session) =>
            session?.messages[0]?.role === 'user' &&
            session.messages[0]?.content ===
              `Generate image ${
                requestIds.indexOf(
                  requestIds.find((requestId) => createdSessions.get(requestId) === session.id)!
                ) + 1
              }` &&
            session.messages[0]?.attachments?.[0]?.fileName ===
              `source-${
                requestIds.indexOf(
                  requestIds.find((requestId) => createdSessions.get(requestId) === session.id)!
                ) + 1
              }.png` &&
            session.messages.at(-1)?.role === 'assistant'
        )
      ).toBe(true)
      expect(
        pendingSnapshots.every(
          (session) =>
            session?.messages.filter((message) => message.role === 'assistant').length === 1
        )
      ).toBe(true)

      await act(async () => {
        sessionIds.forEach((sessionId, index) => {
          completions.get(sessionId!)?.resolve({
            content: `result ${index + 1}`,
            attachments: [
              {
                type: 'image',
                url: `blob:provider-result-${index + 1}`,
                fileName: `generated-${index + 1}.png`,
                mimeType: 'image/png',
                media: {
                  version: 1,
                  kind: 'managed',
                  relativePath: `originals/${String(index + 1).repeat(64)}.png`,
                  sha256: String(index + 1).repeat(64),
                  mimeType: 'image/png',
                  sizeBytes: index + 1,
                  originalFileName: `generated-${index + 1}.png`
                }
              }
            ]
          })
        })
      })

      await waitFor(() => {
        for (const [index, sessionId] of sessionIds.entries()) {
          const session = hoisted.storedSessions.value.find((item) => item.id === sessionId)
          expect(session?.messages.at(-1)).toEqual(
            expect.objectContaining({
              role: 'assistant',
              content: `result ${index + 1}`,
              attachments: [
                expect.objectContaining({
                  url: expect.stringMatching(
                    new RegExp(
                      `^file://C:/MagicPot/AutoSave/Agent/agent_auto_.*_${sessionId}_1_0\\.png$`
                    )
                  ),
                  fileName: `generated-${index + 1}.png`,
                  media: expect.objectContaining({
                    kind: 'managed',
                    originalFileName: `generated-${index + 1}.png`
                  })
                })
              ]
            })
          )
        }
      })
      expect(readScopedActiveLoadingSessionIds('runtime-flow')).toEqual([])
      expect(hoisted.saveImageToDirMock).toHaveBeenCalledTimes(6)
      expect(
        new Set(hoisted.saveImageToDirMock.mock.calls.map(([request]) => request.fileName)).size
      ).toBe(6)
      const persisted = JSON.stringify(hoisted.storedSessions.value)
      expect(persisted).not.toMatch(/(?:data:[^,]*;base64,|blob:)/)
      expect(
        sessionIds.every((sessionId) => completions.get(sessionId!)?.signal?.aborted === false)
      ).toBe(true)
    } finally {
      window.removeEventListener('chat:session-created', handleSessionCreated)
    }
  })

  it('applies external send-to-agent input only to the matching targetScope', async () => {
    renderWithProviders(
      <>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" />
        </div>
      </>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      await Promise.resolve()
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'inspect just this selection',
            hiddenText: 'selection-only hidden context',
            attachment: createImageAttachment('scope-only.png'),
            targetScope: 'runtime-flow-b'
          }
        })
      )
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
      expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
        'inspect just this selection'
      )
      expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
        'scope-only.png'
      )
    })
  })

  it('routes unscoped send-to-agent input only into the active mounted ChatPage', async () => {
    renderWithProviders(
      <>
        <div data-testid="agent-a">
          <ChatPage
            compact
            storageScope="runtime-flow-a"
            active={false}
            acceptExternalInput={false}
          />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'active agent only',
            attachment: createImageAttachment('active-only.png')
          }
        })
      )
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
      expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
        'active agent only'
      )
      expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
        'active-only.png'
      )
    })
  })

  it('binds dedicated managed pane identity only while the actual original conversation is visible, retiring across Skills, side view and session switches', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'managed-pane', threadId: 'thread' } as const
    const a: ChatSession = { id: 'managed-a', title: 'A', messages: [] }, b: ChatSession = { id: 'managed-b', title: 'B', messages: [] }
    hoisted.storedSessions.value = [a, b]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), a.id)
    const branch = { id: '11111111-1111-4111-8111-111111111111', revision: 1, title: 'Pane side', status: 'completed', busy: false, canContinue: true }
    hoisted.listAgentSidesMock.mockResolvedValue({ branches: [branch] }); hoisted.openAgentSideMock.mockResolvedValue({ branch, messages: [{ role: 'assistant', kind: 'answer', content: 'PANE_SIDE' }] })
    const view = renderWithProviders(<WithThreadSubRows>{host => <ChatPage compact storageScope="runtime-flow" route={route} threadSubRowsHost={host} />}</WithThreadSubRows>)
    const activations = () => hoisted.setManagedFirstRunPaneScopeMock.mock.calls.filter(([req]) => req.active).map(([req]) => req)
    try {
      await waitFor(() => expect(activations()).toHaveLength(1))
      const first = activations()[0]
      expect(first).toEqual({ route, conversationId: a.id, active: true, lifecycleRevision: expect.any(Number) }); expect(first.lifecycleRevision).toBeGreaterThan(50)
      await openSkillTakeover()
      expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...first, active: false })
      fireEvent.click(screen.getByRole('button', { name: 'general.close' })); await waitFor(() => expect(activations()).toHaveLength(2))
      const second = activations()[1]; expect(second.lifecycleRevision).toBeGreaterThan(first.lifecycleRevision)
      fireEvent.click(await screen.findByRole('button', { name: /Pane side/ }))
      await screen.findByText('PANE_SIDE'); expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...second, active: false })
      fireEvent.click(screen.getByRole('button', { name: 'chat.agent_side.main' })); await waitFor(() => expect(activations()).toHaveLength(3))
      const third = activations()[2]
      await dispatchSwitchSession(b.id); await waitFor(() => expect(activations().at(-1)?.conversationId).toBe(b.id))
      expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...third, active: false })
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled(); expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
      expect(readCurrentSessionState()?.messages).toEqual([])
    } finally { view.unmount() }
  })
  it.each(['ordinary', 'remote', 'inactive'] as const)('does not bind managed pane identity when the actual ChatPage is %s', async mode => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'managed-unavailable', threadId: 'thread' } as const
    if (mode === 'remote') hoisted.currentConfig.value!.use_remote_llm = true
    const view = renderWithProviders(<ChatPage compact storageScope="runtime-flow" route={mode === 'ordinary' ? undefined : route} active={mode !== 'inactive'} />)
    try { await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy()); expect(hoisted.managedFirstRunPaneRevisionMock).not.toHaveBeenCalled(); expect(hoisted.setManagedFirstRunPaneScopeMock).not.toHaveBeenCalled() }
    finally { view.unmount() }
  })
  it('retires original managed pane identity immediately when actual ChatPage becomes inactive or remote', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'managed-retire', threadId: 'thread' } as const
    const ui = (active: boolean) => <ChatPage compact storageScope="runtime-flow" route={route} active={active} />
    const view = renderWithProviders(ui(true))
    try {
      await waitFor(() => expect(hoisted.setManagedFirstRunPaneScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      const original = hoisted.setManagedFirstRunPaneScopeMock.mock.calls.find(([req]) => req.active)![0]
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui(false)}</ThemeProvider></MemoryRouter>)
      expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...original, active: false })
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui(true)}</ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(hoisted.setManagedFirstRunPaneScopeMock.mock.calls.filter(([req]) => req.active)).toHaveLength(2))
      const second = hoisted.setManagedFirstRunPaneScopeMock.mock.calls.findLast(([req]) => req.active)![0]
      hoisted.currentConfig.value = { ...hoisted.currentConfig.value!, use_remote_llm: true }
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui(true)}</ThemeProvider></MemoryRouter>)
      expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...second, active: false })
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('retires managed pane identity when a loaded conversation is replaced by the no-API warning', async () => {
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'managed-no-api', threadId: 'thread' } as const
    const session: ChatSession = { id: 'loaded-no-api', title: 'Loaded conversation', messages: [] }
    hoisted.storedSessions.value = [session]; localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const ui = () => <ChatPage compact storageScope="runtime-flow" route={route} />
    const view = renderWithProviders(ui())
    try {
      await waitFor(() => expect(hoisted.setManagedFirstRunPaneScopeMock.mock.calls.some(([req]) => req.active)).toBe(true))
      const original = hoisted.setManagedFirstRunPaneScopeMock.mock.calls.find(([req]) => req.active)![0]
      hoisted.availableProfiles.value = []
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui()}</ThemeProvider></MemoryRouter>)
      expect(screen.queryByTestId('chat-composer-input-mock')).not.toBeInTheDocument()
      expect(hoisted.setManagedFirstRunPaneScopeMock).toHaveBeenCalledWith({ ...original, active: false })
      hoisted.availableProfiles.value = [{ id: 'restored-model', model_name: 'Restored', model_use: 'chat' }]
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui()}</ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(hoisted.setManagedFirstRunPaneScopeMock.mock.calls.filter(([req]) => req.active)).toHaveLength(2))
      expect(hoisted.setManagedFirstRunPaneScopeMock.mock.calls.findLast(([req]) => req.active)![0].lifecycleRevision).toBeGreaterThan(original.lifecycleRevision)
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount() }
  })
  it('keeps a Close control when remote mode revokes the local top Skills entry', async () => {
    const builtInSkills = await import('./builtInSkills')
    const mergedSkills = vi.spyOn(builtInSkills, 'mergeBuiltInSkills').mockReturnValue([])
    const route = { channel: 'canvas', scopeType: 'thread', scopeId: 'remote-skill-close', threadId: 'pane' } as const
    const ui = () => <ChatPage compact storageScope="runtime-flow" route={route} />
    const view = renderWithProviders(ui())
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
      await openSkillTakeover()
      expect(screen.getByTestId('chat-composer-input-mock')).not.toBeVisible()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'DRAFT_ACROSS_REMOTE_CHANGE' } })
      hoisted.currentConfig.value = { ...hoisted.currentConfig.value!, use_remote_llm: true, llm_config: { ...hoisted.currentConfig.value!.llm_config, customSkills: [] } }
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{ui()}</ThemeProvider></MemoryRouter>)
      expect(screen.queryByRole('button', { name: '技能' })).not.toBeInTheDocument()
      fireEvent.click(await screen.findByRole('button', { name: 'general.close' }))
      expect(screen.queryByTestId('chat-skill-picker-mock')).not.toBeInTheDocument()
      expect(screen.getByTestId('chat-composer-input-mock')).toBeVisible()
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('DRAFT_ACROSS_REMOTE_CHANGE')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    } finally { view.unmount(); mergedSkills.mockRestore() }
  })
  it('opens the skill take-over view only in the pane whose composer ran /skills', async () => {
    const a = { channel: 'canvas', scopeType: 'thread', scopeId: 'skill-portal', threadId: 'a' } as const
    const b = { ...a, threadId: 'b' }
    const panes = (firstActive: boolean) => <><ChatPage compact storageScope="runtime-flow-a" route={a} active={firstActive} /><ChatPage compact storageScope="runtime-flow-b" route={b} active={!firstActive} /></>
    const view = renderWithProviders(panes(true))
    try {
      const paneRoot = (scope: string) => document.querySelector<HTMLElement>(`[data-chat-page-root="${scope}"]`)!
      await waitFor(() => expect(readCurrentSessionStateWithin(paneRoot('runtime-flow-a'))?.id).toBeTruthy())
      // No pane publishes a skills button into the workspace header any more.
      expect(screen.queryByRole('button', { name: '技能' })).not.toBeInTheDocument()
      await openSkillTakeover(paneRoot('runtime-flow-a'))
      expect(screen.getByTestId('chat-skill-picker-mock')).toBeVisible()
      expect(screen.getByTestId('chat-skill-picker-mock').closest('[data-chat-page-root]')).toHaveAttribute('data-chat-page-root', 'runtime-flow-a')
      fireEvent.click(screen.getByRole('button', { name: 'general.close' }))
      view.rerender(<MemoryRouter><ThemeProvider theme={theme}>{panes(false)}</ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(readCurrentSessionStateWithin(paneRoot('runtime-flow-b'))?.id).toBeTruthy())
      await openSkillTakeover(paneRoot('runtime-flow-b'))
      expect(screen.getAllByTestId('chat-skill-picker-mock')).toHaveLength(1)
      expect(screen.getByTestId('chat-skill-picker-mock').closest('[data-chat-page-root]')).toHaveAttribute('data-chat-page-root', 'runtime-flow-b')
    } finally { view.unmount() }
  })
  it('materializes blob attachments received from send-to-agent before previewing them', async () => {
    const originalFileReader = globalThis.FileReader
    const originalFetch = globalThis.fetch
    vi.stubGlobal(
      'FileReader',
      class MockFileReader {
        result: string | ArrayBuffer | null = null
        error: DOMException | null = null
        onload: (() => void) | null = null
        onerror: (() => void) | null = null

        readAsDataURL(_blob: Blob) {
          this.result = 'data:image/png;base64,Y2FudmFz'
          void Promise.resolve().then(() => this.onload?.())
        }
      }
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array([99, 97, 110, 118, 97, 115]), {
            status: 200,
            headers: { 'Content-Type': 'image/png' }
          })
      )
    )

    renderChatPage('blob-materialization-test')

    try {
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              scope: 'blob-materialization-test',
              attachment: {
                type: 'image',
                url: 'blob:canvas-source',
                fileName: 'canvas.png',
                mimeType: 'image/png'
              }
            }
          })
        )
      })

      await waitFor(() => {
        expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1')
        expect(globalThis.fetch).toHaveBeenCalledWith('blob:canvas-source')
      })
    } finally {
      vi.stubGlobal('FileReader', originalFileReader)
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  describe('asynchronous drop destination isolation', () => {
    const originalFetch = globalThis.fetch
    const originalFileReader = globalThis.FileReader
    const originalImage = globalThis.Image
    type EditingProps = {
      editingMessageIndex: number | null
      onSendEditedMessage: (content: string, attachments: ChatAttachment[] | undefined, hiddenContext: string | undefined, baseMessages: ChatSession['messages']) => void
      onSetEditingIndex: (index: number | null) => void
      onSetEditingContent: (content: string) => void
      onRegisterEditingAttachmentReceiver: (
        receiver: ((attachment: ChatAttachment) => void) | null
      ) => void
    }
    const editingProps = () => hoisted.chatMessageListMock.mock.lastCall?.[0] as EditingProps
    const dropRoot = () => {
      const root = document.querySelector('[data-chat-page-root="runtime-flow"]')
      if (!(root instanceof HTMLElement)) throw new Error('Chat drop target is not mounted')
      return root
    }

    beforeEach(() => {
      hoisted.storedSessions.value = ['drop-session-a', 'drop-session-b'].map((id) => ({
        id,
        title: id,
        profileId: 'vision-model',
        messages: [
          { role: 'user', content: 'First editable message' },
          { role: 'assistant', content: 'First reply' },
          { role: 'user', content: 'Second editable message' }
        ]
      }))
      localStorage.setItem(
        scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
        'drop-session-a'
      )
    })

    afterEach(() => {
      vi.stubGlobal('fetch', originalFetch)
      vi.stubGlobal('FileReader', originalFileReader)
      vi.stubGlobal('Image', originalImage)
    })

    const startEditing = (receiver: (attachment: ChatAttachment) => void) => {
      act(() => {
        editingProps().onSetEditingIndex(0)
        editingProps().onSetEditingContent('First editable message')
        editingProps().onRegisterEditingAttachmentReceiver(receiver)
      })
    }

    it('submits the current edit using the real form callback order without restoring removed attachments', async () => {
      hoisted.storedSessions.value[0].messages[0].attachments = [createImageAttachment('removed.png')]
      renderWithProviders(<ChatPage compact storageScope="runtime-flow" />)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      expect(readCurrentSessionState()?.messages[0].attachments?.[0].fileName).toBe('removed.png')
      const receiver = vi.fn()
      startEditing(receiver)
      await waitFor(() => expect(editingProps().editingMessageIndex).toBe(0))
      const props = editingProps()
      act(() => {
        props.onSetEditingIndex(null)
        props.onSetEditingContent('')
        props.onSendEditedMessage('Edited local prompt', undefined, undefined, [])
      })
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      const input = hoisted.requestChatCompletionMock.mock.calls[0][0] as { messages: Array<{ role: string; content: string; attachments?: ChatAttachment[] }> }
      expect(input.messages.at(-1)).toMatchObject({ role: 'user', content: 'Edited local prompt' })
      expect(input.messages.at(-1)?.attachments ?? []).toEqual([])
    })

    const imageFiles = () =>
      ['first.png', 'second.png'].map((name) =>
        createLocalFile(name, 'image/png', `C:\\magicpot\\${name}`)
      )
    const stubImageDimensions = () => {
      vi.stubGlobal(
        'Image',
        class {
          naturalWidth = 64
          naturalHeight = 32
          onload: (() => void) | null = null
          set src(_value: string) {
            queueMicrotask(() => this.onload?.())
          }
        }
      )
    }
    const directoryTransfer = (files: File[]) => {
      const entry = {
        name: 'references',
        isDirectory: true,
        isFile: false,
        createReader: () => {
          let read = false
          return {
            readEntries: (callback: (entries: unknown[]) => void) => {
              callback(
                read
                  ? []
                  : files.map((file) => ({
                      name: file.name,
                      fullPath: `/references/${file.name}`,
                      isDirectory: false,
                      isFile: true,
                      file: (receiveFile: (file: File) => void) => receiveFile(file)
                    }))
              )
              read = true
            }
          }
        }
      }
      return {
        files: [],
        items: [{ kind: 'file', webkitGetAsEntry: () => entry }],
        types: ['Files'],
        getData: () => ''
      }
    }

    const beginBlobDrop = () => {
      let releaseFetch!: (response: Pick<Response, 'ok' | 'blob'>) => void
      const readAsDataURL = vi.fn()
      vi.stubGlobal(
        'FileReader',
        class {
          result: string | null = null
          onload: (() => void) | null = null
          onerror: (() => void) | null = null
          readAsDataURL(blob: Blob) {
            readAsDataURL(blob)
            this.result = 'data:image/png;base64,Y2FudmFz'
            queueMicrotask(() => this.onload?.())
          }
        }
      )
      const pendingFetch = new Promise<Pick<Response, 'ok' | 'blob'>>((resolve) => {
        releaseFetch = resolve
      })
      const fetchMock = vi.fn(() => pendingFetch)
      vi.stubGlobal('fetch', fetchMock)
      const payload = JSON.stringify({
        attachments: [{ type: 'image', url: 'blob:delayed-drop', fileName: 'delayed-drop.png' }],
        textContent: 'text from delayed drop'
      })
      fireEvent.drop(dropRoot(), {
        dataTransfer: {
          files: [],
          items: [],
          types: ['application/x-qapp-image'],
          getData: (type: string) => (type === 'application/x-qapp-image' ? payload : '')
        }
      })
      expect(fetchMock).toHaveBeenCalledWith('blob:delayed-drop')
      return async () => {
        await act(async () => {
          releaseFetch({
            ok: true,
            blob: async () => new Blob(['canvas'], { type: 'image/png' })
          })
        })
        await waitFor(() => expect(readAsDataURL).toHaveBeenCalledOnce())
      }
    }

    it('delivers an awaited internal image to the original edit while it remains open', async () => {
      const receiveAttachment = vi.fn()
      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      startEditing(receiveAttachment)

      const finishDrop = beginBlobDrop()
      await finishDrop()

      expect(receiveAttachment).toHaveBeenCalledWith(
        expect.objectContaining({ fileName: 'delayed-drop.png' })
      )
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it('accepts a current drop after StrictMode replays the mount lifecycle', async () => {
      render(
        <React.StrictMode>
          <MemoryRouter>
            <ThemeProvider theme={theme}>
              <ChatPage compact storageScope="runtime-flow" />
            </ThemeProvider>
          </MemoryRouter>
        </React.StrictMode>
      )
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))

      const finishDrop = beginBlobDrop()
      await finishDrop()

      expect(screen.getByTestId('chat-composer-attachment-names')).toHaveTextContent(
        'delayed-drop.png'
      )
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('text from delayed drop')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it.each(['cancel', 'another edit', 'edit round trip'])(
      'discards the old internal drop after %s instead of retargeting it',
      async (change) => {
        const originalReceiver = vi.fn()
        const nextReceiver = vi.fn()
        renderChatPage()
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
        startEditing(originalReceiver)
        const finishDrop = beginBlobDrop()

        act(() => {
          editingProps().onSetEditingIndex(null)
          editingProps().onSetEditingContent('')
          editingProps().onRegisterEditingAttachmentReceiver(null)
        })
        if (change !== 'cancel') {
          act(() => {
            editingProps().onSetEditingIndex(change === 'another edit' ? 2 : 0)
            editingProps().onRegisterEditingAttachmentReceiver(
              change === 'another edit' ? nextReceiver : originalReceiver
            )
          })
        }
        await finishDrop()

        expect(originalReceiver).not.toHaveBeenCalled()
        expect(nextReceiver).not.toHaveBeenCalled()
        expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
        expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      }
    )

    it('discards a delayed send-to-agent attachment after its edit is cancelled', async () => {
      const originalReceiver = vi.fn()
      let releaseFetch!: (response: Pick<Response, 'ok' | 'blob'>) => void
      const readAsDataURL = vi.fn()
      vi.stubGlobal(
        'FileReader',
        class {
          result: string | null = null
          onload: (() => void) | null = null
          onerror: (() => void) | null = null
          readAsDataURL(blob: Blob) {
            readAsDataURL(blob)
            this.result = 'data:image/png;base64,Y2FudmFz'
            queueMicrotask(() => this.onload?.())
          }
        }
      )
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Pick<Response, 'ok' | 'blob'>>((resolve) => {
              releaseFetch = resolve
            })
        )
      )

      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      startEditing(originalReceiver)
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope: 'runtime-flow',
              attachments: [
                { type: 'image', url: 'blob:delayed-send', fileName: 'delayed-send.png' }
              ]
            }
          })
        )
      })

      act(() => {
        editingProps().onSetEditingIndex(null)
        editingProps().onRegisterEditingAttachmentReceiver(null)
      })
      await act(async () => {
        releaseFetch({
          ok: true,
          blob: async () => new Blob(['canvas'], { type: 'image/png' })
        })
      })
      await waitFor(() => expect(readAsDataURL).toHaveBeenCalledOnce())

      expect(originalReceiver).not.toHaveBeenCalled()
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it.each(['switch', 'session round trip'])(
      'discards the old internal drop after a %s even when the session id returns',
      async (change) => {
        renderChatPage()
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
        const finishDrop = beginBlobDrop()

        await dispatchSwitchSession('drop-session-b')
        if (change === 'session round trip') await dispatchSwitchSession('drop-session-a')
        await finishDrop()

        expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
        expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      }
    )

    it('discards a delayed ordinary file import after switching sessions away and back', async () => {
      let finishImport!: () => void
      hoisted.importManagedFileMock.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishImport = () =>
              resolve({
                version: 1,
                reference: {
                  version: 1,
                  kind: 'managed',
                  relativePath: `originals/${'b'.repeat(64)}.glb`,
                  sha256: 'b'.repeat(64),
                  mimeType: 'model/gltf-binary',
                  sizeBytes: 3,
                  originalFileName: 'delayed.glb'
                },
                localMediaUrl: 'media://managed/delayed.glb',
                mimeType: 'model/gltf-binary',
                sizeBytes: 3,
                sha256: 'b'.repeat(64)
              })
          })
      )
      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      fireEvent.drop(dropRoot(), {
        dataTransfer: {
          files: [createLocalFile('delayed.glb', 'model/gltf-binary', 'C:\\magicpot\\delayed.glb')],
          items: [],
          types: ['Files'],
          getData: () => ''
        }
      })
      await waitFor(() => expect(hoisted.importManagedFileMock).toHaveBeenCalledOnce())

      await dispatchSwitchSession('drop-session-b')
      await dispatchSwitchSession('drop-session-a')
      await act(async () => finishImport())

      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it('routes a dropped image directory to the open edit instead of the bottom composer', async () => {
      stubImageDimensions()
      const receiveAttachment = vi.fn()
      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      startEditing(receiveAttachment)

      fireEvent.drop(dropRoot(), { dataTransfer: directoryTransfer(imageFiles()) })

      await waitFor(() => expect(receiveAttachment).toHaveBeenCalledTimes(2))
      expect(receiveAttachment.mock.calls.map(([attachment]) => attachment.fileName)).toEqual([
        'first.png',
        'second.png'
      ])
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it.each(['image files', 'image directory'])(
      'stops a dropped batch of %s after its edit is cancelled',
      async (source) => {
        stubImageDimensions()
        const receiveAttachment = vi.fn()
        const originalImport = hoisted.importManagedFileMock.getMockImplementation()!
        let finishImport!: () => void
        hoisted.importManagedFileMock.mockImplementationOnce(
          (...args: unknown[]) =>
            new Promise((resolve, reject) => {
              finishImport = () => {
                void Promise.resolve(originalImport(...args)).then(resolve, reject)
              }
            })
        )
        renderChatPage()
        await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
        startEditing(receiveAttachment)
        const files = imageFiles()
        fireEvent.drop(dropRoot(), {
          dataTransfer:
            source === 'image directory'
              ? directoryTransfer(files)
              : { files, items: [], types: ['Files'], getData: () => '' }
        })
        await waitFor(() => expect(hoisted.importManagedFileMock).toHaveBeenCalledOnce())

        act(() => {
          editingProps().onSetEditingIndex(null)
          editingProps().onRegisterEditingAttachmentReceiver(null)
        })
        await act(async () => finishImport())

        expect(receiveAttachment).not.toHaveBeenCalled()
        expect(hoisted.importManagedFileMock).toHaveBeenCalledOnce()
        expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
        expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      }
    )

    it('discards an internal drop after the original ChatPage unmounts', async () => {
      const receiveAttachment = vi.fn()
      const { unmount } = renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      startEditing(receiveAttachment)
      const finishDrop = beginBlobDrop()

      unmount()
      await finishDrop()

      expect(receiveAttachment).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    })

    it('invalidates a drop across scope changes even with the same session id', async () => {
      localStorage.setItem(
        scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'other-drop-scope'),
        'drop-session-a'
      )
      const { rerender } = renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      const finishDrop = beginBlobDrop()
      const changeScope = (scope: string) =>
        rerender(
          <MemoryRouter>
            <ThemeProvider theme={theme}>
              <ChatPage compact storageScope={scope} />
            </ThemeProvider>
          </MemoryRouter>
        )

      changeScope('other-drop-scope')
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      changeScope('runtime-flow')
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('drop-session-a'))
      await finishDrop()

      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    })
  })

  it('clears normal-response loading before deferred persistence completes', async () => {
    const scope = 'deferred-response-persistence'
    let releasePersistence: (() => void) | undefined
    let resolveResponse: ((value: { content: string }) => void) | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        })
    )
    const loadingEvents: Array<{ running?: boolean; completed?: boolean }> = []
    const handleLoadingState = (event: Event) => {
      const detail = (
        event as CustomEvent<{ scope?: string; running?: boolean; completed?: boolean }>
      ).detail
      if (detail.scope === scope) loadingEvents.push(detail)
    }
    window.addEventListener(CHAT_SESSION_LOADING_STATE_EVENT, handleLoadingState)

    try {
      renderChatPage(scope)
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: 'finish before persistence' }
      })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      hoisted.saveSessionToDBGate.value = new Promise<void>((resolve) => {
        releasePersistence = resolve
      })
      await act(async () => resolveResponse?.({ content: 'assistant response' }))
      await waitFor(() =>
        expect(readCurrentSessionState()?.messages.at(-1)?.content).toBe('assistant response')
      )

      expect(readScopedActiveLoadingSessionIds(scope)).toEqual([])
      expect(loadingEvents.at(-1)).toMatchObject({ running: false, completed: true })
    } finally {
      releasePersistence?.()
      hoisted.saveSessionToDBGate.value = null
      window.removeEventListener(CHAT_SESSION_LOADING_STATE_EVENT, handleLoadingState)
    }
  })

  it('queues Enter while loading, preserves attachments lazily, and continues after stop', async () => {
    let firstSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock
      .mockImplementationOnce(
        (request: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            firstSignal = request.signal
            request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true
            })
          })
      )
      .mockResolvedValueOnce({ content: 'queued done' })

    renderChatPage('queued-enter-stop')
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'active request' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const queuedAttachment = createImageAttachment('queued.png')
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'queued text',
            attachment: queuedAttachment,
            targetScope: 'queued-enter-stop'
          }
        })
      )
    })
    await waitFor(() =>
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('queued text')
    )
    expect(screen.getByTestId('chat-composer-attachment-names')).toHaveTextContent('queued.png')

    fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
    await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(''))
    expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
    expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('chat-composer-stop-mock'))
    expect(firstSignal?.aborted).toBe(true)

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
    const queuedRequest = hoisted.requestChatCompletionMock.mock.calls[1]?.[0] as {
      messages: ChatMessage[]
    }
    expect(queuedRequest.messages.findLast((message) => message.role === 'user')).toEqual(
      expect.objectContaining({
        content: 'queued text',
        attachments: [expect.objectContaining({ fileName: 'queued.png' })]
      })
    )
  })

  it('drops queued sends when the session is explicitly terminated', async () => {
    let firstSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          firstSignal = signal
          signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true }
          )
        })
    )

    renderChatPage('terminate-clears-queue')
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'active request' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    for (const content of ['queued one', 'queued two']) {
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: content }
      })
      fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
    }
    expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2)

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-session', {
          detail: { scope: 'terminate-clears-queue', sessionId: readCurrentSessionState()?.id }
        })
      )
    })

    await waitFor(() => expect(firstSignal?.aborted).toBe(true))
    await waitFor(() => expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
  })

  it('does not send after explicit termination during attachment preparation', async () => {
    let releaseImport!: (value: unknown) => void
    vi.stubGlobal(
      'Image',
      class {
        naturalWidth = 32
        naturalHeight = 32
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        set src(_value: string) {
          queueMicrotask(() => this.onload?.())
        }
      }
    )
    hoisted.importManagedDataUrlMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseImport = resolve
        })
    )

    renderChatPage('terminate-during-preflight')
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    const sessionId = readCurrentSessionState()!.id

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            targetScope: 'terminate-during-preflight',
            autoSend: true,
            text: 'must not send after termination',
            image: 'data:image/png;base64,ZW1wdHk='
          }
        })
      )
    })
    console.log('DEBUG import/data', hoisted.importManagedDataUrlMock.mock.calls.length)
    await waitFor(() => expect(hoisted.importManagedDataUrlMock).toHaveBeenCalledOnce())

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-session', {
          detail: { scope: 'terminate-during-preflight', sessionId }
        })
      )
    })
    await act(async () => {
      releaseImport({
        localMediaUrl: 'media://managed/delayed.png',
        reference: {
          version: 1,
          kind: 'managed',
          relativePath: `originals/${'d'.repeat(64)}.png`,
          sha256: 'd'.repeat(64),
          mimeType: 'image/png',
          sizeBytes: 5,
          originalFileName: 'delayed.png'
        }
      })
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })

  it('does not clear the draft when a busy enqueue has no sendable content', async () => {
    let resolveFirstRequest: ((value: { content: string }) => void) | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRequest = resolve
        })
    )

    renderChatPage('empty-busy-enqueue')
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'active request' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '   ' } })
    fireEvent.keyDown(screen.getByTestId('chat-composer-input-mock'), { key: 'Enter' })
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('   ')

    await act(async () => resolveFirstRequest?.({ content: 'done' }))
    expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
  })

  it('queues a team lead composer draft normally when completed member context is present', async () => {
    const lead: ChatSession = { id: 'queue-team-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'queue-team-member', title: 'Member', teamLeadId: lead.id, teamMemberName: '设计师', messages: [{ role: 'assistant', content: '设计结果' }] }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const active = Promise.withResolvers<{ content: string }>()
    const queued = Promise.withResolvers<{ content: string }>()
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => active.promise).mockImplementationOnce(() => queued.promise)
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      const send = (text: string) => {
        fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } })
        fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      }
      send('first lead request')
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      send('second lead draft')
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('second lead draft'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'new unsent draft' } })
      await act(async () => active.resolve({ content: 'first lead response' }))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('new unsent draft')
      const messages = hoisted.requestChatCompletionMock.mock.calls[1][0].messages as ChatMessage[]
      const sent = messages.find(message => message.role === 'user' && message.content === 'second lead draft')
      expect(sent?.hiddenContext).toContain('设计结果')
      expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument()
      await act(async () => queued.resolve({ content: 'second lead response' }))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2)
    } finally {
      active.resolve({ content: 'cleanup' })
      queued.resolve({ content: 'cleanup' })
      page.unmount()
    }
  })

  it('retains the original team lead draft without duplicating injected member context after queued preflight fails', async () => {
    const lead: ChatSession = { id: 'queue-team-failure-lead', title: 'Lead', messages: [], profileId: 'base-model' }
    const member: ChatSession = { id: 'queue-team-failure-member', title: 'Member', teamLeadId: lead.id, teamMemberName: '设计师', messages: [{ role: 'assistant', content: '设计结果' }] }
    hoisted.storedSessions.value = [lead, member]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), lead.id)
    const active = Promise.withResolvers<{ content: string }>()
    hoisted.requestChatCompletionMock.mockImplementationOnce(() => active.promise).mockResolvedValueOnce({ content: 'retried response' })
    const page = renderChatPage({ team: true })
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(lead.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'first lead request' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
      const attachment = createFileAttachment('queued.pdf')
      await act(async () => window.dispatchEvent(new CustomEvent('send-to-agent', {
        detail: { targetScope: 'runtime-flow', text: 'queued with context', hiddenText: 'user hidden context', attachment }
      })))
      await waitFor(() => expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('queued with context')
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('queued with context'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      hoisted.preflightFailure.value = true
      await act(async () => active.resolve({ content: 'first response' }))
      await waitFor(() => expect(screen.getByTestId('chat-queue-item')).toHaveTextContent('未发送 · 已暂停'))
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'new lead draft' } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      expect(hoisted.notifyWarningMock).toHaveBeenCalledWith('请先处理暂停的排队消息，再发送当前输入')
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('new lead draft')
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce()
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: '' } })
      fireEvent.click(within(screen.getByTestId('chat-queue-item')).getByRole('button', { name: 'chat.queue_edit' }))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('queued with context')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1')
      expect(screen.queryByTestId('chat-queue-item')).not.toBeInTheDocument()
      hoisted.preflightFailure.value = false
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(2))
      const messages = hoisted.requestChatCompletionMock.mock.calls[1][0].messages as ChatMessage[]
      const sent = messages.find(message => message.role === 'user' && message.content === 'queued with context')
      expect(sent?.attachments).toEqual([attachment])
      expect(sent?.hiddenContext).toContain('user hidden context')
      expect(sent?.hiddenContext?.match(/Team member results for the lead to use in its answer:/g)).toHaveLength(1)
      expect(sent?.hiddenContext?.match(/设计师: 设计结果/g)).toHaveLength(1)
    } finally {
      hoisted.preflightFailure.value = false
      active.resolve({ content: 'cleanup' })
      page.unmount()
    }
  })

  it('edits and cancels queued messages with the compact queue controls', async () => {
    let resolveFirstRequest: ((value: { content: string }) => void) | undefined
    hoisted.requestChatCompletionMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstRequest = resolve
        })
    )

    renderChatPage('queue-controls')
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())
    for (const text of ['active', 'second', 'third']) {
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: text } })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      if (text === 'active') {
        await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
      }
    }

    expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(2)
    expect(screen.getByTestId('chat-queue-panel')).not.toHaveTextContent('待发送 ·')
    expect(screen.queryByRole('button', { name: /再显示/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'chat.queue_edit' })[0])
    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('second')
    expect(screen.getAllByTestId('chat-queue-item')).toHaveLength(1)
    expect(screen.getByTestId('chat-queue-panel')).toHaveTextContent('third')

    fireEvent.click(screen.getByRole('button', { name: 'chat.queue_remove' }))
    expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument()
    await act(async () => resolveFirstRequest?.({ content: 'done' }))
    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
  })

  it('queues concurrent auto-sends without early materialization and drains them FIFO after errors', async () => {
    let rejectFirstRequest: ((error: Error) => void) | undefined
    hoisted.requestChatCompletionMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstRequest = reject
          })
      )
      .mockResolvedValueOnce({ content: 'second done' })
      .mockResolvedValueOnce({ content: 'third done' })
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn(
      async (url: string) => new Response(new Blob([url], { type: 'image/png' }))
    )
    vi.stubGlobal('fetch', fetchMock)

    try {
      renderChatPage('concurrent-auto-send')
      await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

      for (const detail of [
        { text: 'first', requestId: 'first' },
        {
          text: 'second',
          requestId: 'second',
          attachment: { type: 'image', url: 'blob:second-canvas', mimeType: 'image/png' }
        },
        {
          text: 'third',
          requestId: 'third',
          attachment: { type: 'image', url: 'blob:third-canvas', mimeType: 'image/png' }
        }
      ]) {
        await act(async () => {
          window.dispatchEvent(
            new CustomEvent('send-to-agent', {
              detail: { ...detail, autoSend: true, targetScope: 'concurrent-auto-send' }
            })
          )
        })
      }

      expect(fetchMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1)
      const queuedItems = screen.getAllByTestId('chat-queue-item')
      expect(queuedItems).toHaveLength(2)
      expect(queuedItems.map((item) => item.textContent)).toEqual([
        expect.stringContaining('second'),
        expect.stringContaining('third')
      ])
      expect(within(queuedItems[0]).getByLabelText('1 个附件')).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'chat.queue_remove' })).toHaveLength(2)

      await act(async () => rejectFirstRequest?.(new Error('first failed')))

      await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(screen.queryByTestId('chat-queue-panel')).not.toBeInTheDocument())
      expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
        'blob:second-canvas',
        'blob:third-canvas'
      ])
      expect(
        hoisted.requestChatCompletionMock.mock.calls.map(
          ([request]) =>
            request.messages.findLast((message: { role: string }) => message.role === 'user')
              ?.content
        )
      ).toEqual(['first', 'second', 'third'])
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it('auto-sends singular send-to-agent attachments instead of dropping them', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'auto send with one attachment',
            hiddenText: 'auto hidden context',
            attachment: createImageAttachment('auto-single.png'),
            autoSend: true
          }
        })
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const call = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as
      | {
          messages?: Array<{
            content?: string
            hiddenContext?: string
            attachments?: ChatAttachment[]
          }>
        }
      | undefined
    expect(call?.messages?.[call.messages.length - 1]).toEqual(
      expect.objectContaining({
        content: 'auto send with one attachment',
        hiddenContext: 'auto hidden context',
        attachments: [expect.objectContaining({ fileName: 'auto-single.png' })]
      })
    )
  })

  it.each(['targetScope', 'scope'])(
    'allows scoped send-to-agent input into an explicit inactive target with input disabled (%s)',
    async (scopeKey) => {
      renderWithProviders(
        <>
          <div data-testid="agent-a">
            <ChatPage compact storageScope="runtime-flow-a" active />
          </div>
          <div data-testid="agent-b">
            <ChatPage
              compact
              storageScope="runtime-flow-b"
              active={false}
              acceptExternalInput={false}
            />
          </div>
        </>
      )

      const agentA = screen.getByTestId('agent-a')
      const agentB = screen.getByTestId('agent-b')

      await waitFor(() =>
        expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
      )
      await waitFor(() =>
        expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
      )

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              text: 'explicit inactive target',
              attachment: createImageAttachment('inactive-target.png'),
              [scopeKey]: 'runtime-flow-b'
            }
          })
        )
      })

      await waitFor(() => {
        expect(within(agentA).getByTestId('chat-composer-input-mock')).toHaveValue('')
        expect(within(agentA).getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
        expect(within(agentB).getByTestId('chat-composer-input-mock')).toHaveValue(
          'explicit inactive target'
        )
        expect(within(agentB).getByTestId('chat-composer-attachment-names')).toHaveTextContent(
          'inactive-target.png'
        )
      })
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    }
  )

  it.each([
    { active: false, acceptExternalInput: false, targetScope: undefined },
    { active: true, acceptExternalInput: false, targetScope: undefined },
    { active: false, acceptExternalInput: true, targetScope: undefined },
    { active: false, acceptExternalInput: false, targetScope: '' },
    { active: false, acceptExternalInput: false, targetScope: 'other-agent' }
  ])(
    'rejects send-to-agent without matching scope when active=$active, accepts=$acceptExternalInput, target=$targetScope',
    async ({ active, acceptExternalInput, targetScope }) => {
      renderChatPage({ active, acceptExternalInput })
      await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('send-to-agent', {
            detail: {
              targetScope,
              text: 'must not reach this pane',
              attachment: createImageAttachment('wrong-pane.png'),
              autoSend: true
            }
          })
        )
      })

      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
      expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
    }
  )

  it('keeps delayed scoped send-to-agent attachments in their target after switching active panes', async () => {
    function PaneSwitchFixture() {
      const [activePane, setActivePane] = React.useState('b')
      return (
        <>
          <button type="button" onClick={() => setActivePane('a')}>
            switch to pane a
          </button>
          {['a', 'b'].map((pane) => (
            <div key={pane} data-testid={`agent-${pane}`}>
              <ChatPage
                compact
                storageScope={`runtime-flow-${pane}`}
                active={activePane === pane}
                acceptExternalInput={activePane === pane}
              />
            </div>
          ))}
        </>
      )
    }
    renderWithProviders(<PaneSwitchFixture />)
    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')
    await waitFor(() => expect(readCurrentSessionStateWithin(agentB)?.id).toBeTruthy())

    let resolveAttachment!: (attachment: ChatAttachment) => void
    const delivery = new Promise<ChatAttachment>((resolve) => {
      resolveAttachment = resolve
    }).then((attachment) => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: { attachment, targetScope: 'runtime-flow-b' }
        })
      )
    })
    fireEvent.click(screen.getByRole('button', { name: 'switch to pane a' }))
    await act(async () => {
      resolveAttachment(createImageAttachment('delayed-target.png'))
      await delivery
    })

    await waitFor(() => {
      expect(within(agentA).getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(within(agentB).getByTestId('chat-composer-attachment-names')).toHaveTextContent(
        'delayed-target.png'
      )
    })
    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(hoisted.requestChatCompletionStreamMock).not.toHaveBeenCalled()
  })

  it('honors only explicit scoped autoSend in an inactive pane with input disabled', async () => {
    renderChatPage({ active: false, acceptExternalInput: false })
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('send-to-agent', {
          detail: {
            text: 'explicit background send',
            attachment: createImageAttachment('explicit-background.png'),
            targetScope: 'runtime-flow',
            autoSend: true
          }
        })
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledOnce())
    const request = hoisted.requestChatCompletionMock.mock.calls[0][0]
    expect(request.storageScope).toBe('runtime-flow')
    expect(request.messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'explicit background send',
      attachments: [expect.objectContaining({ fileName: 'explicit-background.png' })]
    })
  })

  it('handles unscoped compact chat events only in the active mounted ChatPage', async () => {
    renderWithProviders(
      <>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active={false} />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await waitFor(() => {
      expect(readCurrentSessionStateWithin(agentA)?.id).toBeTruthy()
      expect(readCurrentSessionStateWithin(agentB)?.id).toBeTruthy()
    })

    const initialAgentASessionId = readCurrentSessionStateWithin(agentA)?.id

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:newSession', {
          detail: {
            title: 'active-only session'
          }
        })
      )
    })

    await waitFor(() => {
      expect(readCurrentSessionStateWithin(agentA)?.id).toBe(initialAgentASessionId)
      expect(readCurrentSessionStateWithin(agentB)?.title).toBe('active-only session')
    })
  })

  it('surfaces external confirmations inside the Agent conversation and emits the choice', async () => {
    const user = userEvent.setup()
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    const sessionId = readCurrentSessionState()?.id as string
    const responsePromise = new Promise<{
      scope?: string
      sessionId?: string
      requestId?: string
      confirmed?: boolean
    }>((resolve) => {
      const handleResponse = (event: Event) => {
        window.removeEventListener('chat:confirmation-response', handleResponse)
        resolve(
          (
            event as CustomEvent<{
              scope?: string
              sessionId?: string
              requestId?: string
              confirmed?: boolean
            }>
          ).detail
        )
      }
      window.addEventListener('chat:confirmation-response', handleResponse)
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:request-confirmation', {
          detail: {
            scope: 'runtime-flow',
            sessionId,
            requestId: 'target-confirm-1',
            prompt: '请确认目标执行方案',
            confirmLabel: '确认执行',
            cancelLabel: '取消',
            confirmedUserContent: '确认执行该目标方案。',
            cancelledUserContent: '取消执行该目标方案。'
          }
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-confirmation-mock')).toHaveTextContent(
        '请确认目标执行方案'
      )
    )

    await user.click(screen.getByTestId('chat-pending-confirm'))

    await expect(responsePromise).resolves.toEqual({
      scope: 'runtime-flow',
      sessionId,
      requestId: 'target-confirm-1',
      confirmed: true
    })
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages.at(-1)).toEqual({
        role: 'user',
        content: '确认执行该目标方案。'
      })
    })
  })

  it('cancels pending external confirmations when the session is terminated', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
    await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

    const sessionId = readCurrentSessionState()?.id as string
    const responsePromise = new Promise<{
      scope?: string
      sessionId?: string
      requestId?: string
      confirmed?: boolean
    }>((resolve) => {
      const handleResponse = (event: Event) => {
        window.removeEventListener('chat:confirmation-response', handleResponse)
        resolve(
          (
            event as CustomEvent<{
              scope?: string
              sessionId?: string
              requestId?: string
              confirmed?: boolean
            }>
          ).detail
        )
      }
      window.addEventListener('chat:confirmation-response', handleResponse)
    })

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:request-confirmation', {
          detail: {
            scope: 'runtime-flow',
            sessionId,
            requestId: 'target-confirm-cancel',
            prompt: 'Review target plan',
            confirmLabel: 'Confirm',
            cancelLabel: 'Cancel',
            confirmedUserContent: 'Confirm target plan.',
            cancelledUserContent: 'Cancel target plan.'
          }
        })
      )
    })

    await waitFor(() =>
      expect(screen.getByTestId('chat-pending-confirmation-mock')).toHaveTextContent(
        'Review target plan'
      )
    )

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-session', {
          detail: {
            scope: 'runtime-flow',
            sessionId
          }
        })
      )
    })

    await expect(responsePromise).resolves.toEqual({
      scope: 'runtime-flow',
      sessionId,
      requestId: 'target-confirm-cancel',
      confirmed: false
    })
    await waitFor(() =>
      expect(screen.queryByTestId('chat-pending-confirmation-mock')).not.toBeInTheDocument()
    )
  })

  it('routes document paste attachments only into the active mounted ChatPage', async () => {
    const OriginalImage = globalThis.Image
    class MockImage {
      naturalWidth = 64
      naturalHeight = 32
      width = 64
      height = 32
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }

    vi.stubGlobal('Image', MockImage as unknown as typeof Image)
    hoisted.fileToBlobUrlMock.mockReturnValue('data:image/png;base64,iVBORw0KGgo=')

    renderWithProviders(
      <>
        <div data-testid="agent-a">
          <ChatPage compact storageScope="runtime-flow-a" active={false} />
        </div>
        <div data-testid="agent-b">
          <ChatPage compact storageScope="runtime-flow-b" active />
        </div>
      </>
    )

    const agentA = screen.getByTestId('agent-a')
    const agentB = screen.getByTestId('agent-b')

    await waitFor(() =>
      expect(within(agentA).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )
    await waitFor(() =>
      expect(within(agentB).getByTestId('chat-composer-mock')).toBeInTheDocument()
    )

    await act(async () => {
      await Promise.resolve()
    })

    try {
      await act(async () => {
        const pasteEvent = new Event('paste', {
          bubbles: true,
          cancelable: true
        }) as ClipboardEvent
        Object.defineProperty(pasteEvent, 'clipboardData', {
          value: {
            items: [
              {
                type: 'image/png',
                getAsFile: () => new File(['pasted-image'], 'clipboard.png', { type: 'image/png' })
              }
            ]
          }
        })
        document.dispatchEvent(pasteEvent)
      })

      await waitFor(() => {
        expect(within(agentA).getByTestId('chat-composer-attachment-count').textContent).toBe('0')
        expect(within(agentB).getByTestId('chat-composer-attachment-count').textContent).toBe('1')
        expect(within(agentB).getByTestId('chat-composer-attachment-names').textContent).toContain(
          'pasted-image.png'
        )
      })
    } finally {
      vi.stubGlobal('Image', OriginalImage)
      hoisted.fileToBlobUrlMock.mockImplementation(() => 'blob:chat-draft')
    }
  })

  it('keeps a newer attachment removal when an older blob serialization finishes later', async () => {
    const attachment: ChatAttachment = { type: 'image', url: 'blob:remove-draft-fixture', fileName: 'fixture.png' }
    hoisted.storedSessions.value = [
      { id: 'remove-draft-a', title: 'Draft A', messages: [], draft: { inputValue: 'before removal', pendingAttachments: [attachment], pendingHiddenContext: '', updatedAt: 1 } },
      { id: 'remove-draft-b', title: 'Draft B', messages: [] }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), 'remove-draft-a')
    let releaseBlob!: (response: Response) => void
    const blobGate = new Promise<Response>(resolve => { releaseBlob = resolve })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === 'blob:remove-draft-fixture') return blobGate
      throw new Error('Unexpected non-fixture fetch')
    })
    const view = renderChatPage()
    try {
      await waitFor(() => expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1'))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'keep after removal' } })
      fireEvent.blur(window)
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('blob:remove-draft-fixture'))
      fireEvent.click(screen.getByTestId('chat-composer-remove-0'))
      fireEvent.blur(window)
      await waitFor(() => expect(hoisted.draftBackups.value['runtime-flow:remove-draft-a']?.draft?.pendingAttachments).toHaveLength(0))
      await act(async () => { releaseBlob({ ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) } as Response); await Promise.resolve() })
      await waitFor(() => expect(hoisted.fileToDataUrlMock).toHaveBeenCalled())
      await dispatchSwitchSession('remove-draft-b')
      await dispatchSwitchSession('remove-draft-a')
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('remove-draft-a'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('keep after removal')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('0')
      expect(hoisted.draftBackups.value['runtime-flow:remove-draft-a']?.draft?.pendingAttachments).toHaveLength(0)
    } finally {
      view.unmount()
      fetchSpy.mockRestore()
    }
  })

  it('does not recreate a deleted draft when delayed blob serialization completes', async () => {
    const attachment: ChatAttachment = { type: 'image', url: 'blob:delete-draft-fixture', fileName: 'fixture.png' }
    hoisted.storedSessions.value = [
      { id: 'delete-draft-a', title: 'Draft A', messages: [], draft: { inputValue: 'original', pendingAttachments: [attachment], pendingHiddenContext: '', updatedAt: 1 } },
      { id: 'delete-draft-b', title: 'Draft B', messages: [] }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), 'delete-draft-a')
    let releaseBlob!: (response: Response) => void
    const blobGate = new Promise<Response>(resolve => { releaseBlob = resolve })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === 'blob:delete-draft-fixture') return blobGate
      throw new Error('Unexpected non-fixture fetch')
    })
    const view = renderChatPage()
    try {
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('original'))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'pending deletion' } })
      fireEvent.blur(window)
      await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('blob:delete-draft-fixture'))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:deleteSession', { detail: { scope: 'runtime-flow', sessionId: 'delete-draft-a' } })))
      await waitFor(() => expect(hoisted.storedSessions.value.some(session => session.id === 'delete-draft-a')).toBe(false))
      await act(async () => { releaseBlob({ ok: true, blob: async () => new Blob(['fixture'], { type: 'image/png' }) } as Response); await Promise.resolve() })
      await waitFor(() => expect(hoisted.fileToDataUrlMock).toHaveBeenCalled())
      expect(hoisted.storedSessions.value.some(session => session.id === 'delete-draft-a')).toBe(false)
      expect(hoisted.draftBackups.value['runtime-flow:delete-draft-a']).toBeUndefined()
      expect(readCurrentSessionState()?.id).toBe('delete-draft-b')
    } finally {
      view.unmount()
      fetchSpy.mockRestore()
    }
  })

  it('keeps a blob-failed draft when switching sessions before serialization finishes', async () => {
    const attachments: ChatAttachment[] = [{ type: 'image', url: 'blob:switch-draft-fixture', fileName: 'fixture.png' }]
    hoisted.storedSessions.value = [
      { id: 'draft-switch-a', title: 'Draft A', messages: [], draft: { inputValue: 'original', pendingAttachments: attachments, pendingHiddenContext: '', updatedAt: 1 } },
      { id: 'draft-switch-b', title: 'Draft B', messages: [] }
    ]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), 'draft-switch-a')
    let rejectBlob: ((error: Error) => void) | undefined
    const blobGate = new Promise<Response>((_resolve, reject) => { rejectBlob = reject })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      if (input === 'blob:switch-draft-fixture') return blobGate
      throw new Error('Unexpected non-fixture fetch')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const view = renderChatPage()
    try {
      await waitFor(() => expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('original'))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), { target: { value: 'unsaved switch edit' } })
      await dispatchSwitchSession('draft-switch-b')
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('draft-switch-b'))
      expect(fetchSpy).toHaveBeenCalledWith('blob:switch-draft-fixture')
      await act(async () => { rejectBlob?.(new Error('synthetic blob failure')); await Promise.resolve() })
      await waitFor(() => expect(warning).toHaveBeenCalledWith('[ChatPage] Failed to serialize draft attachment:', expect.any(Error)))
      await dispatchSwitchSession('draft-switch-a')
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe('draft-switch-a'))
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('unsaved switch edit')
      expect(screen.getByTestId('chat-composer-attachment-count')).toHaveTextContent('1')
    } finally {
      view.unmount()
      fetchSpy.mockRestore()
      warning.mockRestore()
    }
  })

  it('restores per-session drafts after switching away and remounting the same scope', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft prompt for mesh')

    hoisted.selectFileMock.mockResolvedValueOnce(
      createLocalFile('mesh.glb', 'model/gltf-binary', 'C:\\magicpot\\mesh.glb')
    )
    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })

    await dispatchNewSession({})

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.id).toBeTruthy()
      expect(currentSession?.id).not.toBe(firstSessionId)
    })

    expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('0')

    await dispatchSwitchSession(firstSessionId as string)

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })

    firstRender.unmount()
    renderChatPage()

    await waitFor(() => {
      expect(
        localStorage.getItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'))
      ).toBe(firstSessionId)
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft prompt for mesh')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain('mesh.glb')
    })
  })

  it('restores the latest draft backup after an immediate remount before session persistence finishes', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage('runtime-flow-race')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft survives remount race')

    hoisted.selectFileMock.mockResolvedValueOnce(
      createLocalFile('draft.glb', 'model/gltf-binary', 'C:\\magicpot\\draft.glb')
    )
    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
        'draft survives remount race'
      )
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'draft.glb'
      )
    })

    let releaseSaveSessionToDB: (() => void) | null = null
    hoisted.saveSessionToDBGate.value = new Promise<void>((resolve) => {
      releaseSaveSessionToDB = resolve
    })

    firstRender.unmount()
    renderChatPage('runtime-flow-race')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
        'draft survives remount race'
      )
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'draft.glb'
      )
    })

    await act(async () => {
      releaseSaveSessionToDB?.()
      hoisted.saveSessionToDBGate.value = null
    })
  })

  it('does not let an older async draft persistence restore over newer composer input', async () => {
    const user = userEvent.setup()
    let releaseImport: (() => void) | null = null
    hoisted.importManagedDataUrlMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseImport = () =>
            resolve({
              version: 1,
              reference: {
                version: 1,
                kind: 'managed',
                relativePath: `originals/${'c'.repeat(64)}.glb`,
                sha256: 'c'.repeat(64),
                mimeType: 'model/gltf-binary',
                sizeBytes: 5,
                originalFileName: 'stale.glb'
              },
              localMediaUrl: 'media://managed/stale.glb',
              mimeType: 'model/gltf-binary',
              sizeBytes: 5,
              sha256: 'c'.repeat(64)
            })
        })
    )

    try {
      renderChatPage('runtime-flow-stale-draft')

      await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())
      await waitFor(() => expect(readCurrentSessionState()?.id).toBeTruthy())

      await user.type(screen.getByTestId('chat-composer-input-mock'), 'stale draft')

      hoisted.selectFileMock.mockResolvedValueOnce(
        new File(['stale'], 'stale.glb', { type: 'model/gltf-binary' })
      )
      await user.click(screen.getByTestId('chat-composer-upload-mock'))

      await waitFor(() => expect(hoisted.importManagedDataUrlMock).toHaveBeenCalled())

      await user.type(screen.getByTestId('chat-composer-input-mock'), 'plus fresh edit')

      await act(async () => {
        ;(releaseImport as (() => void) | null)?.()
        await Promise.resolve()
      })

      await waitFor(() => {
        expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue(
          'stale draftplus fresh edit'
        )
      })

      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 250))
      })
    } finally {
      ;(releaseImport as (() => void) | null)?.()
    }
  })

  it('does not keep another session draft when returning to a session with an empty draft', async () => {
    const user = userEvent.setup()
    renderChatPage('runtime-flow-empty-draft')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    const input = screen.getByTestId('chat-composer-input-mock')
    await user.type(input, 'temporary draft')
    await user.clear(input)

    await dispatchNewSession({}, 'runtime-flow-empty-draft')
    await waitFor(() => {
      expect(readCurrentSessionState()?.id).not.toBe(firstSessionId)
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'second session draft')

    await dispatchSwitchSession(firstSessionId as string, 'runtime-flow-empty-draft')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('')
    })
  })

  it('reuses the remembered session id when the initial session has not finished debounced persistence', async () => {
    const user = userEvent.setup()
    let releaseDebouncedSave: (() => void) | null = null
    hoisted.debouncedSaveAllSessionsGate.value = new Promise<void>((resolve) => {
      releaseDebouncedSave = resolve
    })

    const firstRender = renderChatPage('runtime-flow-initial-race')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    let firstSessionId: string | undefined
    await waitFor(() => {
      firstSessionId = readCurrentSessionState()?.id
      expect(firstSessionId).toBeTruthy()
    })

    await user.type(screen.getByTestId('chat-composer-input-mock'), 'draft on unsaved session')

    hoisted.selectFileMock.mockResolvedValueOnce(
      Object.assign(new File(['glb'], 'unsaved.glb', { type: 'model/gltf-binary' }), {
        path: 'C:\\magicpot\\unsaved.glb'
      })
    )

    await user.click(screen.getByTestId('chat-composer-upload-mock'))

    await waitFor(() => {
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(hoisted.storedSessions.value).toEqual([])
    })

    firstRender.unmount()

    renderChatPage('runtime-flow-initial-race')

    await waitFor(() => {
      expect(readCurrentSessionState()?.id).toBe(firstSessionId)
      expect(screen.getByTestId('chat-composer-input-mock')).toHaveValue('draft on unsaved session')
      expect(screen.getByTestId('chat-composer-attachment-count').textContent).toBe('1')
      expect(screen.getByTestId('chat-composer-attachment-names').textContent).toContain(
        'unsaved.glb'
      )
    })

    await act(async () => {
      releaseDebouncedSave?.()
      hoisted.debouncedSaveAllSessionsGate.value = null
    })
  })

  it('reuses the last selected model when a new scope has no scoped profile record yet', async () => {
    const user = userEvent.setup()
    const firstRender = renderChatPage('runtime-flow-a')

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await user.click(await screen.findByTestId('select-vision-model'))

    await waitFor(() => {
      expect(localStorage.getItem(STORAGE_KEY_SELECTED_PROFILE)).toBe('vision-model')
    })

    firstRender.unmount()

    renderChatPage('runtime-flow-b')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.profileId).toBe('vision-model')
    })
  })

  it('runs image interrogation on the same runtime foundation with qapp image settings', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
      initialMessage: 'Inspect this image',
      initialAttachments: [createImageAttachment('hero.png')]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.profileId).toBe('vision-model')
    expect(firstCall.systemPrompt).toBe('qapp vision system')
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
        execution: expect.objectContaining({
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'chat',
          fallbackStrategy: 'default',
          persistSessionUrl: false
        }),
        bindings: [
          expect.objectContaining({
            appId: 'qapp.image-interrogation',
            resourceUris: [
              'qapp.imageInterrogation.systemPrompt',
              'qapp.imageInterrogation.userPrompt'
            ]
          })
        ]
      })
    )
    expect(firstCall.messages[0].hiddenContext).toContain('qapp vision user')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.skillId).toBe(BUILT_IN_IMAGE_INTERROGATION_SKILL_ID)
      expect(currentSession?.messages).toHaveLength(2)
    })
  })

  it('runs prompt translation on the same runtime foundation with explicit translation defaults', async () => {
    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Translate this prompt into English'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.profileId).toBe('translation-model')
    expect(firstCall.systemPrompt).toBe('qapp translate system')
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
        execution: expect.objectContaining({
          mode: 'isolated',
          allowHistory: false,
          outputMode: 'chat',
          fallbackStrategy: 'default',
          persistSessionUrl: false
        }),
        bindings: [
          expect.objectContaining({
            appId: 'qapp.prompt-translation',
            resourceUris: [
              'qapp.promptTranslation.systemPrompt',
              'qapp.promptTranslation.userPrompt'
            ]
          })
        ]
      })
    )
    expect(firstCall.messages[0].hiddenContext).toContain('qapp translate user')

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.skillId).toBe(BUILT_IN_PROMPT_TRANSLATION_SKILL_ID)
      expect(currentSession?.messages).toHaveLength(2)
    })
  })

  it('forwards bound MCP tool capabilities in compact ChatPage sessions', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'github-mcp-skill',
            category: 'agent',
            skillName: 'GitHub MCP Skill',
            prompt: 'Use GitHub MCP when needed.',
            type: 'normal',
            bindings: [
              {
                appId: 'mcp.github',
                toolNames: ['mcp.github.issues.list']
              }
            ]
          }
        ]
      },
      mcp_config: {
        ...config.mcp_config,
        client: {
          ...config.mcp_config.client,
          servers: [
            {
              id: 'github',
              enabled: true,
              transport: 'stdio',
              command: 'github-mcp'
            }
          ]
        }
      }
    }

    hoisted.runtimeMcpStatus.value = {
      client: {
        connections: [
          {
            id: 'github',
            aliasPrefix: 'mcp.github',
            status: 'connected',
            toolCount: 1,
            toolAliases: ['mcp.github.issues.list'],
            transport: 'stdio'
          }
        ],
        discoveredToolCount: 1
      },
      server: {
        enabled: true,
        path: '/api/mcp',
        exposeResources: true,
        authRequired: false
      }
    }

    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'Fetched GitHub issue summary.'
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'github-mcp-skill',
      initialMessage: 'Show open GitHub issues for this repo.'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.skillRuntime).toEqual(
      expect.objectContaining({
        skillId: 'github-mcp-skill',
        bindings: [
          expect.objectContaining({
            appId: 'mcp.github',
            toolNames: ['mcp.github.issues.list'],
            transport: 'mcp',
            source: 'mcp-client'
          })
        ]
      })
    )
  })

  it('accepts attachment-only assistant results without treating them as empty responses', async () => {
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: '',
      attachments: [
        {
          type: 'image',
          url: 'https://example.com/generated-armor.png',
          mimeType: 'image/png'
        }
      ]
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: '直接出图，不要出文字'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(2)
      expect(currentSession?.messages[1]).toEqual(
        expect.objectContaining({
          role: 'assistant',
          content: '',
          attachments: [
            expect.objectContaining({
              type: 'image',
              mimeType: 'image/png'
            })
          ]
        })
      )
      const attachmentUrl = currentSession?.messages[1]?.attachments?.[0]?.url
      expect(attachmentUrl).toEqual(expect.any(String))
      expect(
        attachmentUrl === 'https://example.com/generated-armor.png' ||
          (attachmentUrl?.startsWith('file://') && attachmentUrl.includes('AutoSave/Agent'))
      ).toBe(true)
    })
  })

  it('preserves an external edit made after an assistant attachment CAS commits but before its acknowledgement', async () => {
    const session: ChatSession = {
      id: 'attachment-commit-ack-race', title: 'Attachment acknowledgement', profileId: 'base-model',
      messages: [{ role: 'user', content: 'initial' }], createdAt: 298
    }
    const sourceUrl = 'https://example.com/own-fixture.png'
    const savedPath = 'C:/MagicPot/AutoSave/Agent/own-fixture.png'
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })))
    let releaseImage!: (value: { savedPath: string }) => void
    let releaseCompare!: () => void
    hoisted.saveImageToDirMock.mockReset()
    hoisted.saveImageToDirMock.mockImplementationOnce(() => new Promise(resolve => { releaseImage = resolve }))
    hoisted.storedSessions.value = [session]
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'), session.id)
    const page = renderChatPage()
    try {
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'image output',
          attachments: [{ type: 'image', url: sourceUrl, mimeType: 'image/png' }] }
      })))
      await waitFor(() => expect(hoisted.saveImageToDirMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(hoisted.storedSessions.value[0]?.messages.at(-1)?.attachments?.[0]?.url).toBe(sourceUrl))
      hoisted.compareCommitted.value = null
      hoisted.compareCommitResultGate.value = new Promise<void>(resolve => { releaseCompare = resolve })
      await act(async () => releaseImage({ savedPath }))
      await waitFor(() => expect(hoisted.compareCommitted.value?.messages.at(-1)?.attachments?.[0]?.url).toBe(`file://${savedPath}`))
      expect(hoisted.storedSessions.value[0]?.messages.at(-1)?.attachments?.[0]?.url).toBe(`file://${savedPath}`)
      // The CAS has committed. Simulate an independent writer committing an additional message
      // before this window receives the old CAS acknowledgement.
      const external = cloneValue(hoisted.storedSessions.value[0])
      external.messages.push({ role: 'user', content: 'external committed edit' })
      hoisted.storedSessions.value = [external]
      await act(async () => { hoisted.compareCommitResultGate.value = null; releaseCompare() })
      await waitFor(() => expect(readCurrentSessionState()?.messages.at(-1)?.attachments?.[0]?.url).toBe(`file://${savedPath}`))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: 'runtime-flow', sessionId: session.id, role: 'assistant', content: 'local edit after ack' }
      })))
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/session save conflict/i))
      expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'external committed edit')).toBe(true)
      expect(hoisted.storedSessions.value[0]?.messages.some(message => message.content === 'local edit after ack')).toBe(false)
      expect(readCurrentSessionState()?.messages.some(message => message.content === 'local edit after ack')).toBe(true)
    } finally {
      releaseCompare?.()
      hoisted.compareCommitResultGate.value = null
      vi.stubGlobal('fetch', originalFetch)
      page.unmount()
    }
  })

  it('isolates a committed attachment acknowledgement across scopes with the same session id', async () => {
    const id = 'attachment-same-id-scope-race'
    const scopeA = 'runtime-flow', scopeB = 'attachment-scope-b'
    const a: ChatSession = { id, title: 'scope A', profileId: 'base-model', createdAt: 300, messages: [{ role: 'user', content: 'A initial' }] }
    const b: ChatSession = { id, title: 'scope B', profileId: 'base-model', createdAt: 300, messages: [{ role: 'user', content: 'B initial' }] }
    const sourceUrl = 'https://example.com/scope-a-fixture.png'
    const savedPath = 'C:/MagicPot/AutoSave/Agent/scope-a-fixture.png'
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }) })))
    let releaseImage!: (value: { savedPath: string }) => void
    let releaseCompare!: () => void
    hoisted.saveImageToDirMock.mockReset()
    hoisted.saveImageToDirMock.mockImplementationOnce(() => new Promise(resolve => { releaseImage = resolve }))
    hoisted.scopedTestSessions.value = { [scopeA]: [a], [scopeB]: [b] }
    hoisted.loadAllSessionsMock.mockImplementation(async (scope: string) => cloneValue(hoisted.scopedTestSessions.value?.[scope] ?? []))
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scopeA), id)
    localStorage.setItem(scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, scopeB), id)
    const page = renderChatPage(scopeA)
    try {
      await waitFor(() => expect(readCurrentSessionState()?.messages[0]?.content).toBe('A initial'))
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: scopeA, sessionId: id, role: 'assistant', content: 'A image', attachments: [{ type: 'image', url: sourceUrl, mimeType: 'image/png' }] }
      })))
      await waitFor(() => expect(hoisted.saveImageToDirMock).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(hoisted.scopedTestSessions.value?.[scopeA][0]?.messages.at(-1)?.attachments?.[0]?.url).toBe(sourceUrl))
      hoisted.compareCommitted.value = null
      hoisted.compareCommitResultGate.value = new Promise<void>(resolve => { releaseCompare = resolve })
      await act(async () => releaseImage({ savedPath }))
      await waitFor(() => expect(hoisted.compareCommitted.value?.messages.at(-1)?.attachments?.[0]?.url).toBe(`file://${savedPath}`))
      expect(hoisted.scopedTestSessions.value?.[scopeA][0]?.messages.at(-1)?.attachments?.[0]?.url).toBe(`file://${savedPath}`)
      const external = cloneValue(hoisted.scopedTestSessions.value![scopeA][0])
      external.messages.push({ role: 'user', content: 'A external edit' })
      hoisted.scopedTestSessions.value![scopeA] = [external]
      page.rerender(<MemoryRouter><ThemeProvider theme={theme}><ChatPage compact storageScope={scopeB} /></ThemeProvider></MemoryRouter>)
      await waitFor(() => expect(readCurrentSessionState()?.messages[0]?.content).toBe('B initial'))
      await act(async () => { hoisted.compareCommitResultGate.value = null; releaseCompare() })
      expect(readCurrentSessionState()?.title).toBe('scope B')
      expect(hoisted.scopedTestSessions.value?.[scopeB][0]?.messages).toEqual(b.messages)
      await act(async () => window.dispatchEvent(new CustomEvent('chat:append-message', {
        detail: { scope: scopeB, sessionId: id, role: 'assistant', content: 'B later edit' }
      })))
      await waitFor(() => expect(hoisted.scopedTestSessions.value?.[scopeB][0]?.messages.at(-1)?.content).toBe('B later edit'))
      expect(readCurrentSessionState()?.messages[0]?.content).toBe('B initial')
      expect(hoisted.scopedTestSessions.value?.[scopeB][0]?.messages.some(m => m.content === 'A image')).toBe(false)
      expect(hoisted.scopedTestSessions.value?.[scopeA][0]?.messages.some(m => m.content === 'A external edit')).toBe(true)
      expect(hoisted.scopedTestSessions.value?.[scopeA][0]?.messages[1]?.attachments?.[0]?.url).toBe(`file://${savedPath}`)
    } finally {
      releaseCompare?.()
      hoisted.compareCommitResultGate.value = null
      vi.stubGlobal('fetch', originalFetch)
      page.unmount()
    }
  })

  it('does not overwrite a replaced assistant attachment after a delayed auto-save', async () => {
    const sourceUrl = 'https://example.com/stale-generated.png'
    const savedPath = 'C:/MagicPot/AutoSave/Agent/stale.png'
    const originalFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () =>
          new Blob([new Uint8Array([137, 80, 78, 71])], {
            type: 'image/png'
          })
      }))
    )
    let releaseSave!: (value: { savedPath: string }) => void
    hoisted.fileExistsBatchMock.mockReset(); hoisted.fileExistsBatchMock.mockImplementation(async (paths: string[]) => paths.map(() => true))
    hoisted.saveImageToDirMock.mockReset()
    hoisted.saveImageToDirMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseSave = resolve
        })
    )

    try {
      renderChatPage()
      await dispatchNewSession({
        skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID
      })
      let currentSession = readCurrentSessionState()
      expect(currentSession?.id).toBeTruthy()
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('chat:append-message', {
            detail: {
              scope: 'runtime-flow',
              sessionId: currentSession?.id,
              role: 'assistant',
              content: '',
              attachments: [
                {
                  type: 'image',
                  url: sourceUrl,
                  mimeType: 'image/png'
                }
              ]
            }
          })
        )
      })
      await waitFor(() => expect(hoisted.saveImageToDirMock).toHaveBeenCalledTimes(1))

      currentSession = readCurrentSessionState()
      expect(currentSession?.id).toBeTruthy()
      const replacementSession = cloneValue(currentSession!)
      replacementSession.messages = replacementSession.messages.map((message, messageIndex) =>
        messageIndex === replacementSession.messages.length - 1
          ? {
              ...message,
              attachments: [
                {
                  type: 'image' as const,
                  url: 'file:///replacement.png',
                  mimeType: 'image/png',
                  fileName: 'replacement.png'
                }
              ]
            }
          : message
      )
      hoisted.storedSessions.value = [replacementSession]
      await act(async () => {
        window.dispatchEvent(
          new CustomEvent('chat:preview-refresh', {
            detail: { scope: 'runtime-flow', reason: 'storage-updated' }
          })
        )
      })
      await waitFor(() =>
        expect(readCurrentSessionState()?.messages.at(-1)?.attachments?.[0]?.url).toBe(
          'file:///replacement.png'
        )
      )

      await act(async () => {
        releaseSave({ savedPath })
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(readCurrentSessionState()?.messages.at(-1)?.attachments?.[0]?.url).toBe(
        'file:///replacement.png'
      )
      expect(hoisted.storedSessions.value[0]?.messages.at(-1)?.attachments?.[0]?.url).toBe(
        'file:///replacement.png'
      )
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it.each([false, true])(
    'carries selected remote routing metadata to the request entrypoint (stream wrapper=%s)',
    async (stream) => {
      const remoteProfile = {
        id: 'base-model',
        model_name: 'Remote opaque model',
        model_use: 'chat' as const,
        provider: 'openai',
        api_mode: 'responses' as const
      }
      hoisted.currentConfig.value!.use_remote_llm = true
      hoisted.currentConfig.value!.llm_config.api_profiles = [
        {
          id: 'base-model',
          model_name: 'Local conflicting image model',
          base_url: 'https://api.openai.com/v1',
          api_key: 'fixture-not-a-credential',
          api_mode: 'images'
        }
      ]
      hoisted.availableProfiles.value = [remoteProfile]
      hoisted.supportsStreamingChatCompletionMock.mockReturnValue(stream)
      hoisted.requestChatCompletionStreamMock.mockResolvedValue({
        result: { content: 'fixture remote response.' },
        response: 'fixture remote response.'
      })
      const session: ChatSession = {
        id: 'remote-routing-metadata',
        title: 'Remote routing metadata',
        profileId: remoteProfile.id,
        messages: []
      }
      hoisted.storedSessions.value = [session]
      localStorage.setItem(
        scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
        session.id
      )
      renderChatPage()
      await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
      fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
        target: { value: 'Send using the selected remote route.' }
      })
      fireEvent.click(screen.getByTestId('chat-composer-send-mock'))
      const target = stream
        ? hoisted.requestChatCompletionStreamMock
        : hoisted.requestChatCompletionMock
      await waitFor(() => expect(target).toHaveBeenCalledTimes(1))
      expect(target.mock.calls[0][0]).toMatchObject({
        profileId: remoteProfile.id,
        remoteProfile
      })
      expect(target.mock.calls[0][0].apiMode).toBeUndefined()
    }
  )

  it('dispatches historical image references for image generation requests', async () => {
    const session: ChatSession = {
      id: 'image-generation-history',
      title: 'Image generation history',
      profileId: 'vision-model',
      messages: Array.from({ length: 11 }, (_, index) => ({
        role: 'user' as const,
        content: `historical reference ${index + 1}`,
        attachments: [createImageAttachment(`historical-${index + 1}.png`)]
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    localStorage.setItem(
      scopedStorageKey('chat.imageGenerationOptions', 'runtime-flow'),
      JSON.stringify({
        enabled: true,
        action: 'generate',
        outputFormat: 'png',
        quality: 'high',
        background: 'auto',
        size: 'auto'
      })
    )
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'generated' })

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'Generate a new image without old references.' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as {
      imageHistoryPolicy?: string
      messages?: ChatMessage[]
    }
    expect(firstCall.imageHistoryPolicy).toBe('all')
    expect(
      firstCall.messages?.flatMap((message) =>
        (message.attachments || []).filter((attachment) => attachment.type === 'image')
      )
    ).toHaveLength(11)
    expect(firstCall.messages?.at(-1)?.content).toBe('Generate a new image without old references.')
  })

  it('dispatches historical image history automatically for GPT Image profiles', async () => {
    hoisted.availableProfiles.value = [
      {
        id: 'gpt-image-profile',
        model_name: 'gpt-image-2.5-sunburst',
        model_use: 'image' as const,
        api_mode: 'images' as const,
        provider: 'openai',
        is_vision_model: true
      }
    ]
    const session: ChatSession = {
      id: 'gpt-image-history',
      title: 'GPT Image history',
      profileId: 'gpt-image-profile',
      messages: Array.from({ length: 11 }, (_, index) => ({
        role: 'user' as const,
        content: `historical reference ${index + 1}`,
        attachments: [createImageAttachment(`gpt-history-${index + 1}.png`)]
      }))
    }
    hoisted.storedSessions.value = [session]
    localStorage.setItem(
      scopedStorageKey(STORAGE_KEY_CURRENT_SESSION_ID, 'runtime-flow'),
      session.id
    )
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'generated' })

    renderChatPage()
    await waitFor(() => expect(readCurrentSessionState()?.id).toBe(session.id))
    fireEvent.change(screen.getByTestId('chat-composer-input-mock'), {
      target: { value: 'Generate with GPT Image.' }
    })
    fireEvent.click(screen.getByTestId('chat-composer-send-mock'))

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.profileId).toBe('gpt-image-profile')
    expect(firstCall.apiMode).toBeUndefined()
    expect(firstCall.imageHistoryPolicy).toBe('all')
    expect(
      firstCall.messages.flatMap((message) =>
        (message.attachments || []).filter((attachment) => attachment.type === 'image')
      )
    ).toHaveLength(11)
  })

  it('keeps multiple image references together for image generation requests', async () => {
    localStorage.setItem(
      scopedStorageKey('chat.imageGenerationOptions', 'runtime-flow'),
      JSON.stringify({
        enabled: true,
        action: 'edit',
        outputFormat: 'png',
        quality: 'high',
        background: 'auto',
        size: 'auto'
      })
    )
    hoisted.resolveAttachmentBatchCapabilityMock.mockClear()
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'generated from both references'
    })

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      profileId: 'vision-model',
      initialMessage: 'Use both references together.',
      initialAttachments: [
        { ...createImageAttachment('role.png'), sourceWidth: 610, sourceHeight: 610 },
        createImageAttachment('ghost.png')
      ]
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.resolveAttachmentBatchCapabilityMock).not.toHaveBeenCalled()

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(firstCall.imageGenerationOptions).toMatchObject({
      enabled: true,
      action: 'edit',
      size: '1024x1024'
    })
    expect(firstCall.imageHistoryPolicy).toBe('all')
    const lastRequestMessage = firstCall.messages[firstCall.messages.length - 1]
    expect(lastRequestMessage.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'role.png'
      }),
      expect.objectContaining({
        type: 'image',
        fileName: 'ghost.png'
      })
    ])
  })

  it('keeps ordinary multi-image chat in one request without attachment batching', async () => {
    hoisted.resolveAttachmentBatchCapabilityMock.mockClear()
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({ content: 'ordinary multimodal reply' })

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      profileId: 'vision-model',
      initialMessage: '把图一改的这层黄光减弱一点，参考其他图的风格，但是氛围不变',
      initialAttachments: Array.from({ length: 6 }, (_, index) =>
        createImageAttachment(`reference-${index + 1}.png`)
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    expect(hoisted.resolveAttachmentBatchCapabilityMock).not.toHaveBeenCalled()
    const request = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    expect(request.messages.at(-1)?.attachments).toHaveLength(6)
    await waitFor(() =>
      expect(
        readCurrentSessionState()?.messages.filter((message) => message.role === 'assistant')
      ).toHaveLength(1)
    )
  })

  it('sends current-turn image references without triggering a local image-count guard', async () => {
    localStorage.setItem(
      scopedStorageKey('chat.imageGenerationOptions', 'runtime-flow'),
      JSON.stringify({
        enabled: true,
        action: 'edit',
        outputFormat: 'png',
        quality: 'high',
        background: 'auto',
        size: 'auto'
      })
    )
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockResolvedValue({
      content: 'generated from ten current-turn references'
    })

    renderChatPage()
    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      profileId: 'vision-model',
      initialMessage: 'Use all ten references together.',
      initialAttachments: Array.from({ length: 10 }, (_, index) =>
        createImageAttachment(`current-${index + 1}.png`)
      )
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))
    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0] as {
      imageHistoryPolicy?: string
      messages?: ChatMessage[]
    }
    expect(firstCall.imageHistoryPolicy).toBe('all')
    expect(firstCall.messages?.at(-1)?.attachments).toHaveLength(10)
    expect(
      firstCall.messages?.at(-1)?.attachments?.map((attachment) => attachment.fileName)
    ).toEqual(Array.from({ length: 10 }, (_, index) => `current-${index + 1}.png`))
  })

  it('warns and blocks skill execution when the selected model supports neither images nor documents', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the uploaded references.',
            type: 'normal'
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      initialMessage: 'Check these references',
      initialAttachments: [createImageAttachment('hero.png'), createFileAttachment('brief.pdf')]
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '不支持图片和文档输入，仅支持文本输入'
    )

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(0)
    })
  })

  it('warns about document input when the selected model supports images only', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the uploaded references.',
            type: 'normal'
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      profileId: 'vision-model',
      initialMessage: 'Check these references',
      initialAttachments: [createImageAttachment('hero.png'), createFileAttachment('brief.pdf')]
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '仅支持图片输入，不支持文档输入'
    )
  })

  it('injects locked skill reference attachments into the outgoing user message', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the locked references first.',
            type: 'normal',
            referenceAttachments: [createSkillReferenceImageAttachment('locked-reference.png')]
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      profileId: 'vision-model',
      initialMessage: 'Please review'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const firstCall = hoisted.requestChatCompletionMock.mock.calls[0]?.[0]
    const lastRequestMessage = firstCall.messages[firstCall.messages.length - 1]
    expect(lastRequestMessage.attachments).toEqual([
      expect.objectContaining({
        type: 'image',
        fileName: 'locked-reference.png',
        hiddenFromChatView: true
      })
    ])

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages[0]?.attachments).toEqual([
        expect.objectContaining({
          type: 'image',
          fileName: 'locked-reference.png',
          hiddenFromChatView: true
        })
      ])
    })
  })

  it('warns and blocks skill execution when locked references require unsupported image and document input', async () => {
    const config = createConfig()
    hoisted.currentConfig.value = {
      ...config,
      llm_config: {
        ...config.llm_config,
        customSkills: [
          {
            id: 'asset-review',
            category: 'Design',
            skillName: 'Asset Review',
            prompt: 'Review the locked references.',
            type: 'normal',
            referenceAttachments: [
              createSkillReferenceImageAttachment('hero.png'),
              createSkillReferenceFileAttachment('brief.pdf')
            ]
          }
        ]
      }
    }

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: 'asset-review',
      initialMessage: 'Check these locked references'
    })

    await waitFor(() => expect(hoisted.notifyWarningMock).toHaveBeenCalledTimes(1))

    expect(hoisted.requestChatCompletionMock).not.toHaveBeenCalled()
    expect(String(hoisted.notifyWarningMock.mock.calls[0]?.[0] || '')).toContain(
      '不支持图片和文档输入，仅支持文本输入'
    )

    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(0)
    })
  })

  it('treats scope termination as a real cancellation for an in-flight request', async () => {
    let observedSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          const abortWithError = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }

          if (!signal) {
            reject(new Error('Expected abort signal'))
            return
          }

          if (signal.aborted) {
            abortWithError()
            return
          }

          signal.addEventListener('abort', abortWithError, { once: true })
        })
    )

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Cancel me'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:terminate-scope', {
          detail: {
            scope: 'runtime-flow'
          }
        })
      )
    })

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.messages).toHaveLength(1)
      expect(currentSession?.messages[0]).toEqual(
        expect.objectContaining({ role: 'user', content: 'Cancel me' })
      )
    })
  })

  it('treats session deletion as a real cancellation for an in-flight request', async () => {
    let observedSignal: AbortSignal | undefined
    hoisted.requestChatCompletionMock.mockReset()
    hoisted.requestChatCompletionMock.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = signal
          const abortWithError = () => {
            const error = new Error('aborted')
            error.name = 'AbortError'
            reject(error)
          }

          if (!signal) {
            reject(new Error('Expected abort signal'))
            return
          }

          if (signal.aborted) {
            abortWithError()
            return
          }

          signal.addEventListener('abort', abortWithError, { once: true })
        })
    )

    renderChatPage()

    await waitFor(() => expect(screen.getByTestId('chat-composer-mock')).toBeInTheDocument())

    await dispatchNewSession({
      skillId: BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
      initialMessage: 'Cancel on delete'
    })

    await waitFor(() => expect(hoisted.requestChatCompletionMock).toHaveBeenCalledTimes(1))

    const sessionBeforeDelete = readCurrentSessionState()
    expect(sessionBeforeDelete?.id).toBeTruthy()

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('chat:deleteSession', {
          detail: {
            scope: 'runtime-flow',
            sessionId: sessionBeforeDelete?.id
          }
        })
      )
    })

    await waitFor(() => expect(observedSignal?.aborted).toBe(true))
    await waitFor(() => {
      const currentSession = readCurrentSessionState()
      expect(currentSession?.id).not.toBe(sessionBeforeDelete?.id)
    })
  })
})
