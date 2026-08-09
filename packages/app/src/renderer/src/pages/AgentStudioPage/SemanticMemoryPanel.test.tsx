import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SemanticMemoryPanel } from './SemanticMemoryPanel'

const svc = vi.hoisted(() => ({
  ingestMemoryScope: vi.fn(),
  ingestSessionMemory: vi.fn(),
  linkMemoryAgentSession: vi.fn(),
  unlinkMemoryAgentSession: vi.fn(),
  listMemoryAgentSessions: vi.fn(),
  searchMemory: vi.fn(),
  inspectMemory: vi.fn(),
  deleteMemory: vi.fn(),
  setMemoryDisabled: vi.fn(),
  setMemoryVisibility: vi.fn(),
  clearMemoryScope: vi.fn(),
  rebuildMemory: vi.fn()
}))

vi.mock('@renderer/utils/windowUtils', () => ({
  api: () => ({ svcMagicAgentPlatform: svc })
}))

const route = {
  channel: 'generic',
  scopeType: 'dm',
  scopeId: 'owner-1',
  senderId: 'owner-1'
}
const memory = {
  id: 'memory-1',
  scope: { kind: 'session' as const, id: 'private-session-id' },
  importance: 0.8,
  lifetime: 'durable' as const,
  visibility: 'private' as const,
  disabled: false,
  sensitive: true,
  redacted: true,
  preview: 'Safe <script>alert(1)</script> preview',
  provenance: {
    sourceKind: 'assistant-session',
    sourceId: 'message:1',
    sourceSessionKey: 'private-session-id',
    sourceRunId: 'run-1',
    contentHash: 'abc123',
    recordedAt: 1
  },
  createdAt: 1,
  updatedAt: 2
}

const fillRoute = () => {
  fireEvent.change(screen.getByLabelText('Scope ID'), { target: { value: 'owner-1' } })
  fireEvent.change(screen.getByLabelText('Owner user ID'), { target: { value: 'owner-1' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  svc.ingestMemoryScope.mockResolvedValue({ discovered: 3, upserted: 2 })
  svc.ingestSessionMemory.mockResolvedValue({ discovered: 3, upserted: 2 })
  svc.linkMemoryAgentSession.mockResolvedValue([
    { agentId: 'agent-1', sessionId: 'generic:dm:owner-1', createdAt: 1 }
  ])
  svc.unlinkMemoryAgentSession.mockResolvedValue([])
  svc.listMemoryAgentSessions.mockResolvedValue([
    { agentId: 'agent-1', sessionId: 'generic:dm:owner-1', createdAt: 1 }
  ])
  svc.searchMemory.mockResolvedValue({
    hits: [{ memory, score: 0.9, lexicalScore: 0.4, semanticScore: 0.8 }],
    requestedMode: 'semantic',
    effectiveMode: 'lexical',
    degraded: true,
    degradationReason: 'provider unavailable',
    content: 'must never render',
    vector: [1, 2, 3]
  })
  svc.inspectMemory.mockResolvedValue({
    memory,
    content: 'must never render',
    vector: { providerId: 'secret', dimension: 3 }
  })
  svc.deleteMemory.mockResolvedValue({ affected: 1 })
  svc.setMemoryDisabled.mockResolvedValue({ affected: 1 })
  svc.setMemoryVisibility.mockResolvedValue({ affected: 1 })
  svc.clearMemoryScope.mockResolvedValue({ affected: 4 })
  svc.rebuildMemory.mockResolvedValue({
    id: 'rebuild-1',
    providerId: 'local',
    status: 'pending',
    processed: 0,
    createdAt: 1,
    updatedAt: 1
  })
})

describe('SemanticMemoryPanel', () => {
  it('ingests and queries an owned route with mode/provider and renders safe degraded metadata only', async () => {
    render(<SemanticMemoryPanel />)
    fillRoute()
    fireEvent.change(screen.getByLabelText('Embedding provider ID (optional)'), {
      target: { value: 'local' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Ingest scope' }))
    await waitFor(() =>
      expect(svc.ingestMemoryScope).toHaveBeenCalledWith({
        scope: { kind: 'session', route },
        providerId: 'local'
      })
    )
    expect(await screen.findByText(/3 discovered, 2 upserted/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Memory query'), { target: { value: 'launch plan' } })
    fireEvent.change(screen.getByLabelText('Query mode'), { target: { value: 'semantic' } })
    fireEvent.click(screen.getByRole('button', { name: 'Query memory' }))
    await waitFor(() =>
      expect(svc.searchMemory).toHaveBeenCalledWith({
        query: 'launch plan',
        scopes: [{ kind: 'session', route }],
        mode: 'semantic',
        limit: 25,
        providerId: 'local'
      })
    )
    expect(await screen.findByText('degraded: yes')).toBeInTheDocument()
    expect(screen.getByText('provider unavailable')).toBeInTheDocument()
    expect(screen.getByText('ID: memory-1')).toBeInTheDocument()
    expect(screen.getByText(/sensitive: yes · redacted: yes/)).toBeInTheDocument()
    expect(screen.getByText('Safe <script>alert(1)</script> preview')).toBeInTheDocument()
    expect(screen.getByText(/assistant-session · message:1/)).toBeInTheDocument()
    expect(document.querySelector('script')).toBeNull()
    expect(screen.queryByText('must never render')).not.toBeInTheDocument()
    expect(screen.queryByText(/\[1,2,3\]/)).not.toBeInTheDocument()
  })

  it('controls Agent scope links and ingests through the scope API', async () => {
    render(<SemanticMemoryPanel />)
    fillRoute()
    fireEvent.change(screen.getByLabelText('Memory scope'), { target: { value: 'agent' } })
    fireEvent.change(screen.getByLabelText('agent ID'), { target: { value: 'agent-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Link session' }))
    await waitFor(() =>
      expect(svc.linkMemoryAgentSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        sourceRoute: route
      })
    )
    expect(await screen.findByText('Agent has 1 linked session(s).')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'List links' }))
    await waitFor(() =>
      expect(svc.listMemoryAgentSessions).toHaveBeenCalledWith({ agentId: 'agent-1' })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ingest scope' }))
    await waitFor(() =>
      expect(svc.ingestMemoryScope).toHaveBeenCalledWith({
        scope: { kind: 'agent', id: 'agent-1', sourceRoute: route }
      })
    )

    fireEvent.click(screen.getByRole('button', { name: 'Unlink session' }))
    await waitFor(() =>
      expect(svc.unlinkMemoryAgentSession).toHaveBeenCalledWith({
        agentId: 'agent-1',
        sourceRoute: route
      })
    )
    expect(await screen.findByText('Agent has 0 linked session(s).')).toBeInTheDocument()
  })

  it('inspects an ID and dispatches enable/disable, visibility, and confirmed delete', async () => {
    render(<SemanticMemoryPanel />)
    fillRoute()
    fireEvent.change(screen.getByLabelText('Memory / provenance ID'), {
      target: { value: 'memory-1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Inspect safe metadata' }))
    await waitFor(() =>
      expect(svc.inspectMemory).toHaveBeenCalledWith({ id: 'memory-1', sourceRoute: route })
    )
    expect(await screen.findByLabelText('Inspected safe metadata')).toHaveTextContent('ID memory-1')
    expect(screen.queryByText('must never render')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await waitFor(() =>
      expect(svc.setMemoryDisabled).toHaveBeenCalledWith({
        id: 'memory-1',
        sourceRoute: route,
        disabled: true
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }))
    await waitFor(() =>
      expect(svc.setMemoryDisabled).toHaveBeenCalledWith({
        id: 'memory-1',
        sourceRoute: route,
        disabled: false
      })
    )
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'shared' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply visibility' }))
    await waitFor(() =>
      expect(svc.setMemoryVisibility).toHaveBeenCalledWith({
        id: 'memory-1',
        sourceRoute: route,
        visibility: 'shared'
      })
    )

    const deleteButton = screen.getByRole('button', { name: 'Delete memory' })
    expect(deleteButton).toBeDisabled()
    fireEvent.click(screen.getByLabelText('I understand: delete this record'))
    fireEvent.click(deleteButton)
    await waitFor(() =>
      expect(svc.deleteMemory).toHaveBeenCalledWith({ id: 'memory-1', sourceRoute: route })
    )
  })

  it('requires explicit destructive confirmation for clear scope and rebuild', async () => {
    render(<SemanticMemoryPanel />)
    fillRoute()
    fireEvent.change(screen.getByLabelText('Embedding provider ID (optional)'), {
      target: { value: 'local' }
    })
    expect(screen.getByText(/Destructive actions are irreversible/)).toBeInTheDocument()
    const clear = screen.getByRole('button', { name: 'Clear session scope' })
    const rebuild = screen.getByRole('button', { name: 'Rebuild embeddings' })
    expect(clear).toBeDisabled()
    expect(rebuild).toBeDisabled()

    fireEvent.click(screen.getByLabelText('I understand: clear the entire session scope'))
    fireEvent.click(clear)
    await waitFor(() =>
      expect(svc.clearMemoryScope).toHaveBeenCalledWith({
        scope: { kind: 'session', route }
      })
    )
    fireEvent.click(screen.getByLabelText('I understand: rebuild provider embeddings'))
    fireEvent.click(rebuild)
    await waitFor(() =>
      expect(svc.rebuildMemory).toHaveBeenCalledWith({ sourceRoute: route, providerId: 'local' })
    )
    expect(await screen.findByText(/Rebuild job rebuild-1: pending/)).toBeInTheDocument()
  })
})
