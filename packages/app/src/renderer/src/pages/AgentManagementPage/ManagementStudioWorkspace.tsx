import StudioSshConfiguration from './StudioSshConfiguration'
import StudioDockerConfiguration from './StudioDockerConfiguration'
import StudioExecutionPreparation from './StudioExecutionPreparation'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, FormControl, InputLabel, MenuItem, Paper, Select, Stack, TextField, Typography } from '@mui/material'
import type { Config } from '@shared/config/config'
import {
  createStudioCreatureBundle, emptyStudioWorkspace, parseStudioWorkspaceText,
  STUDIO_WORKSPACE_MAX_BYTES, studioWorkspaceSchema,
  type StudioCreature, type StudioNode, type StudioWorkspace
} from '@shared/studioWorkspace'

const newCreature = (): StudioCreature => ({ id: '', name: '', modelProfileId: '', systemPrompt: '' })
const newNode = (): StudioNode => ({ id: '', name: '', address: '' })

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export default function ManagementStudioWorkspace({ config, onSave, onOpenPlugins, onOpenSkills }: {
  config: Config
  onSave: (value: { studio_workspace?: StudioWorkspace; project_trace_config?: Config['project_trace_config'] }) => Promise<void>
  onOpenPlugins: () => void
  onOpenSkills: () => void
}) {
  const [open, setOpen] = useState(false)
  const [workspace, setWorkspace] = useState(emptyStudioWorkspace)
  const [draft, setDraft] = useState(newCreature)
  const [node, setNode] = useState(newNode)
  const [editing, setEditing] = useState<string | null>(null)
  const [editingNode, setEditingNode] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const [bundleCreature, setBundleCreature] = useState('')
  const [restore, setRestore] = useState<StudioWorkspace | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState(false)
  const pending = useRef(false)
  const alive = useRef(false)
  const revision = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false; revision.current++ } }, [])
  useEffect(() => {
    revision.current++
    if (!open) return
    setRestore(null)
    const parsed = studioWorkspaceSchema.safeParse(config.studio_workspace ?? emptyStudioWorkspace())
    if (parsed.success) { setWorkspace(parsed.data); setError(false); setMessage('') }
    else { setError(true); setMessage('Stored Studio workspace is invalid. Restore a valid Studio JSON file to replace it.') }
  }, [config.studio_workspace, open])

  const fail = (value: string) => { setError(true); setMessage(value) }
  const save = async (next: StudioWorkspace) => {
    if (pending.current) return
    const valid = studioWorkspaceSchema.safeParse(next)
    if (!valid.success) { fail('Invalid or duplicate ID, missing name, or invalid node address.'); return }
    pending.current = true
    setBusy(true)
    const currentRevision = revision.current
    try {
      await onSave({ studio_workspace: valid.data })
      if (alive.current && revision.current === currentRevision) {
        setWorkspace(valid.data); setRestore(null); setError(false); setMessage('Studio workspace saved.')
      }
    } catch {
      if (alive.current && revision.current === currentRevision) fail('Studio save failed. Your draft is retained; no automatic retry.')
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const readRestore = async (file: File) => {
    if (pending.current) return
    if (file.size > STUDIO_WORKSPACE_MAX_BYTES) { fail('Studio file exceeds 1 MiB.'); return }
    pending.current = true
    setBusy(true)
    const currentRevision = revision.current
    try {
      const parsed = parseStudioWorkspaceText(await file.text())
      if (alive.current && revision.current === currentRevision) {
        setRestore(parsed); setError(false); setMessage('Review the counts, then confirm replacement of Studio metadata only.')
      }
    } catch {
      if (alive.current && revision.current === currentRevision) fail('Invalid Studio JSON. Existing data was not changed.')
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const profiles = open ? config.llm_config.api_profiles : []
  return <Paper component="section" aria-label="Studio workspace (basic)" variant="outlined" sx={{ p: 2 }}>
    <Typography component="h2" variant="h6">Studio workspace (basic) / Studio 基础版</Typography>
    <Button disabled={busy} onClick={() => setOpen(value => !value)}>{open ? 'Close Studio workspace' : 'Open Studio workspace'}</Button>
    {open && <Stack spacing={2}>
      {message && <Alert severity={error ? 'error' : 'success'}>{message}</Alert>}
      <Stack direction="row" spacing={1}>
        <Button onClick={onOpenPlugins}>Open plugin center</Button>
        <Button onClick={onOpenSkills}>Open custom-skill manager</Button>
      </Stack>
      <Typography component="h3" variant="subtitle1">Creature templates / Creature 模板</Typography>
      <Stack component="ul" spacing={1}>
        {workspace.creatures.map(item => <li key={item.id}>
          <Typography>{item.name} · {item.id} · model: {item.modelProfileId || '(not assigned)'}</Typography>
          <Button disabled={busy} onClick={() => { setDraft({ ...item }); setEditing(item.id) }} aria-label={`Edit creature ${item.id}`}>Edit</Button>
          <Button disabled={busy} onClick={() => void save({ ...workspace, creatures: workspace.creatures.filter(value => value.id !== item.id) })} aria-label={`Delete creature ${item.id}`}>Delete template</Button>
        </li>)}
      </Stack>
      <TextField label="Creature ID" value={draft.id} disabled={!!editing || busy} onChange={event => setDraft({ ...draft, id: event.target.value })} />
      <TextField label="Creature name" value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} />
      <FormControl><InputLabel id="studio-creature-model-label">Model profile</InputLabel>
        <Select labelId="studio-creature-model-label" label="Model profile" value={draft.modelProfileId} disabled={busy} onChange={event => setDraft({ ...draft, modelProfileId: event.target.value })}>
          <MenuItem value="">Not assigned</MenuItem>
          {draft.modelProfileId && !profiles.some(profile => profile.id === draft.modelProfileId) && <MenuItem value={draft.modelProfileId}>{draft.modelProfileId} (missing profile)</MenuItem>}
          {profiles.map((profile, index) => <MenuItem key={`${index}:${profile.id}`} value={profile.id}>{profile.model_name} · {profile.id}</MenuItem>)}
        </Select>
      </FormControl>
      <TextField label="System prompt" multiline minRows={3} value={draft.systemPrompt} disabled={busy} onChange={event => setDraft({ ...draft, systemPrompt: event.target.value })} />
      <Stack direction="row" spacing={1}>
        <Button disabled={busy} onClick={() => {
          if (!editing && workspace.creatures.some(item => item.id === draft.id)) { fail('Creature ID already exists. Use Edit.'); return }
          void save({ ...workspace, creatures: editing ? workspace.creatures.map(item => item.id === editing ? draft : item) : [...workspace.creatures, draft] })
        }}>Save creature</Button>
        <Button disabled={busy} onClick={() => { setDraft(newCreature()); setEditing(null) }}>New creature</Button>
      </Stack>
      <Typography component="h3" variant="subtitle1">Model and account labels / 模型与账号标记</Typography>
      <Stack component="ul">{profiles.map((profile, index) => <li key={`${index}:${profile.id}`}>
        {profile.model_name} · {profile.id} · {profile.provider ?? 'default'} · {profile.call_type ?? 'default'} · account: {profile.auth_account_email || 'not configured'} (unverified)
      </li>)}</Stack>
      <Typography component="h3" variant="subtitle1">Deployment nodes / 部署节点</Typography>
      <Stack component="ul">{workspace.nodes.map(item => <li key={item.id}>
        <Typography>{item.name} · {item.id} · {item.address}</Typography>
        <Button disabled={busy} aria-label={`Edit node ${item.id}`} onClick={() => { setNode({ ...item }); setEditingNode(item.id) }}>Edit</Button>
        <Button disabled={busy} aria-label={`Delete node ${item.id}`} onClick={() => void save({ ...workspace, nodes: workspace.nodes.filter(value => value.id !== item.id) })}>Delete node</Button>
      </li>)}</Stack>
      <TextField label="Node ID" value={node.id} disabled={!!editingNode || busy} onChange={event => setNode({ ...node, id: event.target.value })} />
      <TextField label="Node name" value={node.name} disabled={busy} onChange={event => setNode({ ...node, name: event.target.value })} />
      <TextField label="Node address (no credentials)" value={node.address} disabled={busy} onChange={event => setNode({ ...node, address: event.target.value })} />
      <Stack direction="row" spacing={1}>
        <Button disabled={busy} onClick={() => {
          if (!editingNode && workspace.nodes.some(item => item.id === node.id)) { fail('Node ID already exists. Use Edit.'); return }
          void save({ ...workspace, nodes: editingNode ? workspace.nodes.map(item => item.id === editingNode ? node : item) : [...workspace.nodes, node] })
        }}>Save node</Button>
        <Button disabled={busy} onClick={() => { setNode(newNode()); setEditingNode(null) }}>New node</Button>
      </Stack>
      <FormControl><InputLabel id="studio-bundle-creature-label">Bundle creature</InputLabel>
        <Select labelId="studio-bundle-creature-label" label="Bundle creature" value={bundleCreature} onChange={event => setBundleCreature(event.target.value)}>
          <MenuItem value="">Choose creature</MenuItem>{workspace.creatures.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
        </Select>
      </FormControl>
      <FormControl><InputLabel id="studio-target-label">Target node</InputLabel>
        <Select labelId="studio-target-label" label="Target node" value={target} onChange={event => setTarget(event.target.value)}>
          <MenuItem value="">Choose target</MenuItem>{workspace.nodes.map(item => <MenuItem key={item.id} value={item.id}>{item.name}</MenuItem>)}
        </Select>
      </FormControl>
      <Button disabled={busy || !bundleCreature || !target} onClick={() => {
        try { downloadJson('magicpot-creature-bundle.json', createStudioCreatureBundle(workspace, bundleCreature, target)); setError(false); setMessage('Bundle download requested.') }
        catch { fail('Unable to export bundle. Check the selected creature and node.') }
      }}>Export deployment bundle</Button>
      <StudioSshConfiguration config={config} onSave={onSave} />
      <StudioDockerConfiguration config={config} onSave={onSave} />
      <StudioExecutionPreparation />
      <Typography component="h3" variant="subtitle1">Save / restore Studio JSON / 保存恢复</Typography>
      <Button disabled={busy} onClick={() => {
        try { downloadJson('magicpot-studio.json', studioWorkspaceSchema.parse(workspace)); setError(false); setMessage('Studio JSON download requested.') }
        catch { fail('Unable to export Studio JSON.') }
      }}>Export Studio JSON</Button>
      <Button component="label" disabled={busy}>Choose Studio JSON<input hidden aria-label="Studio JSON file" type="file" accept=".json,application/json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void readRestore(file)
      }} /></Button>
      {restore && <Alert severity="warning">
        Replace with {restore.creatures.length} creature templates and {restore.nodes.length} nodes? Existing Studio metadata will be replaced.
        <Button disabled={busy} onClick={() => void save(restore)}>Confirm Studio restore</Button>
        <Button disabled={busy} onClick={() => setRestore(null)}>Cancel restore</Button>
      </Alert>}
    </Stack>}
  </Paper>
}
