import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  List,
  ListItemButton,
  Stack,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import {
  AGENT_LOCAL_FILE_ERRORS,
  AGENT_LOCAL_FILE_LIMITS,
  type AgentLocalFileErrorCode,
  type AgentLocalFileGrant,
  type AgentLocalFileScope,
  type AgentLocalFilesSvc,
  type ListLocalFilesResponse,
  type ReadLocalFileResponse
} from '@shared/api/svcAgentLocalFiles'
import { formatLocalFilePreview, formatLocalDocumentPreview } from '../localFilePreview'

export type AgentLocalFilesPanelProps = {
  scope: AgentLocalFileScope
  service: AgentLocalFilesSvc
  disabled?: boolean
  onAttach: (file: ReadLocalFileResponse) => void | boolean | Promise<void | boolean>
}

type Owner = {
  scope: AgentLocalFileScope
  service: AgentLocalFilesSvc
  live: boolean
  version: number
  busy: boolean
  requests: Set<string>
  activation: 'pending' | 'active' | 'failed'
  activationReady: Promise<void>
  revision: number
}

type View = {
  owner: Owner
  path: string
  grant: AgentLocalFileGrant | null
  directory: string
  listing: ListLocalFilesResponse | null
  preview: ReadLocalFileResponse | null
  acknowledged: boolean
  busy: boolean
  error: AgentLocalFileErrorCode | null
  attachPending: boolean
  attachFeedback: 'success' | 'failure' | null
}

const emptyView = (owner: Owner): View => ({
  owner,
  path: '',
  grant: null,
  directory: '',
  listing: null,
  preview: null,
  acknowledged: false,
  busy: false,
  error: null,
  attachPending: false,
  attachFeedback: null
})

function publicError(error: unknown): AgentLocalFileErrorCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(AGENT_LOCAL_FILE_ERRORS, code)
    ? (code as AgentLocalFileErrorCode)
    : publicErrorFromMessage(error)
}

function publicErrorFromMessage(error: unknown): AgentLocalFileErrorCode {
  // Electron invoke preserves the message, but custom Error properties may be lost.
  // Match only fixed public messages; never show arbitrary main-process error text.
  const message = (error instanceof Error ? error.message : '')
    .replace(
      /^Error invoking remote method 'svcAgentLocalFiles\.(?:setScope|choose|read|list|revoke|cancel)':\s*/,
      ''
    )
    .replace(/^(?:AgentLocalFileError|Error):\s*/, '')
  return (
    (Object.entries(AGENT_LOCAL_FILE_ERRORS).find(([, value]) => value === message)?.[0] as
      AgentLocalFileErrorCode | undefined) ?? 'IO_ERROR'
  )
}

// Cleanup must not surface service errors (which may contain local paths) or update an old scope.
function quietly(action: () => Promise<void>) {
  try {
    void action().catch(() => {})
  } catch {
    // A disconnected service may also throw synchronously during teardown.
  }
}

export function AgentLocalFilesPanel({
  scope,
  service,
  disabled = false,
  onAttach
}: AgentLocalFilesPanelProps) {
  const { t } = useTranslation()
  const { projectId, paneId, sessionId } = scope
  const lifecycleRevision = useRef(0)
  const owner = useMemo<Owner>(
    () => ({
      scope: { projectId, paneId, sessionId },
      service,
      live: true,
      version: 0,
      busy: false,
      requests: new Set(),
      activation: 'pending',
      activationReady: Promise.resolve(),
      revision: 0
    }),
    [projectId, paneId, sessionId, service]
  )
  const [state, setState] = useState<View>(() => emptyView(owner))
  // Hide old content during the scope-changing render, before effect cleanup runs.
  const view = state.owner === owner ? state : emptyView(owner)
  const visualPreview = useMemo(
    () => formatLocalFilePreview(view.preview ? formatLocalDocumentPreview(view.preview) : ''),
    [view.preview]
  )

  const update = useCallback(
    (patch: Partial<View>) => {
      if (!owner.live) return
      setState((previous) => ({
        ...(previous.owner === owner ? previous : emptyView(owner)),
        ...patch
      }))
    },
    [owner]
  )

  useEffect(() => {
    owner.live = true
    owner.busy = false
    owner.activation = 'pending'
    owner.revision = ++lifecycleRevision.current
    const activationRevision = owner.revision
    const markActive = () => {
      if (owner.live && owner.revision === activationRevision) {
        owner.activation = 'active'
        update({})
      }
    }
    const markFailed = (error: unknown) => {
      if (!owner.live || owner.revision !== activationRevision) return
      owner.activation = 'failed'
      update({ error: publicError(error) })
    }
    setState(emptyView(owner))
    // Activation is an IPC side effect; operations await this owner-scoped promise before
    // starting chooser/read/list work. The owner revision also rejects StrictMode or stale
    // activation completions after a scope lifecycle changes.
    try {
      const activation = owner.service.setScope({
        scope: owner.scope,
        active: true,
        revision: owner.revision
      })
      if (activation && typeof (activation as PromiseLike<void>).then === 'function') {
        owner.activationReady = Promise.resolve(activation).then(markActive, markFailed)
      } else {
        owner.activation = 'active'
        owner.activationReady = Promise.resolve()
        update({})
      }
    } catch (error) {
      markFailed(error)
      owner.activationReady = Promise.resolve()
    }
    return () => {
      owner.live = false
      owner.version++
      owner.activation = 'failed'
      for (const requestId of owner.requests) {
        quietly(() => owner.service.cancel({ scope: owner.scope, requestId }))
      }
      owner.requests.clear()
      quietly(() => owner.service.revoke({ scope: owner.scope }))
      quietly(() =>
        owner.service.setScope({ scope: owner.scope, active: false, revision: owner.revision })
      )
    }
  }, [owner, update])

  const current = (version: number) => owner.live && owner.version === version
  const begin = () => {
    if (disabled || !owner.live || owner.busy || owner.activation !== 'active') return undefined
    owner.busy = true
    const version = ++owner.version
    update({ busy: true, preview: null, acknowledged: false, error: null })
    return version
  }
  const finish = (version: number) => {
    if (!current(version)) return
    owner.busy = false
    update({ busy: false })
  }
  const request = async <T,>(action: (requestId: string) => Promise<T>): Promise<T> => {
    const requestId = crypto.randomUUID()
    owner.requests.add(requestId)
    try {
      return await action(requestId)
    } finally {
      owner.requests.delete(requestId)
    }
  }

  const load = async (
    grant: AgentLocalFileGrant,
    kind: AgentLocalFileGrant['kind'],
    relativePath: string,
    version: number
  ) => {
    const base = { scope: owner.scope, grantId: grant.id, relativePath }
    if (kind === 'directory') {
      const listing = await request((requestId) => service.list({ ...base, requestId }))
      if (current(version)) update({ listing, directory: relativePath })
    } else {
      const preview = await request((requestId) => service.read({ ...base, requestId }))
      if (current(version)) update({ preview, acknowledged: false })
    }
  }

  const ensureActive = async () => {
    if (!owner.live) return false
    try {
      await owner.activationReady
    } catch {
      return false
    }
    return owner.live && owner.activation === 'active'
  }

  const choose = async (kind: AgentLocalFileGrant['kind'], suggestedPath?: string) => {
    if (!(await ensureActive())) return
    const version = begin()
    if (version === undefined) return
    update({ grant: null, listing: null, directory: '' })
    try {
      if (view.grant) await service.revoke({ scope: owner.scope, grantId: view.grant.id })
      if (!current(version)) return
      const grant = await request((requestId) =>
        service.choose({
          scope: owner.scope,
          kind,
          requestId,
          ...(suggestedPath ? { suggestedPath } : {})
        })
      )
      if (!current(version)) {
        if (grant) quietly(() => service.revoke({ scope: owner.scope, grantId: grant.id }))
        return
      }
      if (!grant) return
      update({ grant })
      await load(grant, grant.kind, '', version)
    } catch (error) {
      if (current(version)) update({ error: publicError(error) })
    } finally {
      finish(version)
    }
  }

  const browse = async (kind: AgentLocalFileGrant['kind'], relativePath: string) => {
    if (!view.grant) return
    if (!(await ensureActive())) return
    const version = begin()
    if (version === undefined) return
    try {
      await load(view.grant, kind, relativePath, version)
    } catch (error) {
      if (current(version)) update({ error: publicError(error) })
    } finally {
      finish(version)
    }
  }

  const clearAccess = async () => {
    const version = ++owner.version
    owner.busy = true
    const requests = [...owner.requests]
    const grantId = view.grant?.id
    owner.requests.clear()
    update({ ...emptyView(owner), busy: true })
    try {
      await Promise.all([
        ...requests.map((requestId) => service.cancel({ scope: owner.scope, requestId })),
        service.revoke({ scope: owner.scope, ...(grantId ? { grantId } : {}) })
      ])
    } catch (error) {
      if (current(version)) update({ error: publicError(error) })
    } finally {
      finish(version)
    }
  }

  const stopDrop = (event: React.DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }
  const drop = (event: React.DragEvent) => {
    stopDrop(event)
    if (disabled || owner.busy || !owner.live || owner.activation !== 'active') return
    const file = event.dataTransfer.files?.[0]
    if (!file) return
    let suggestedPath: string | undefined
    try {
      suggestedPath = window.electronFile?.getPathForFile?.(file) || undefined
    } catch {
      // Without a bridge path, still require the user to choose in the native dialog.
    }
    void choose('file', suggestedPath)
  }

  const blocked = disabled || view.busy || view.attachPending || owner.activation !== 'active'
  return (
    <Stack
      component="section"
      aria-label={t('chat.local_files.title', { defaultValue: 'Local files' })}
      aria-busy={view.busy}
      spacing={1}
      onDragOverCapture={stopDrop}
      onDropCapture={drop}
    >
      <Typography variant="subtitle2">
        {t('chat.local_files.title', { defaultValue: 'Local files' })}
      </Typography>
      <Typography variant="caption">
        {t('chat.local_files.text_only', {
          defaultValue:
            'UTF-8 text, PDF, DOCX, XLSX and PPTX, up to {{limit}} KiB of extracted text. Document input up to 1 MiB. Only supported passive text is extracted, not layout or images. Reading only previews content; nothing is attached or uploaded.',
          limit: AGENT_LOCAL_FILE_LIMITS.returnedBytes / 1024
        })}
      </Typography>
      <Typography variant="caption">
        {t('chat.local_files.preview_formatting', {
          defaultValue:
            'Hidden formatting characters are shown as [U+XXXX] for directional and selected invisible controls. Original names, paths and text are unchanged.'
        })}
      </Typography>
      <TextField
        size="small"
        label={t('chat.local_files.path', { defaultValue: 'Optional local path' })}
        helperText={t('chat.local_files.native_confirmation', {
          defaultValue:
            'A path or dropped file does not grant access or navigate automatically. Select or re-enter the intended path in the native chooser.'
        })}
        value={view.path}
        onChange={(event) => update({ path: event.target.value })}
        inputProps={{ maxLength: 4096 }}
        disabled={blocked}
      />
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        <Button disabled={blocked} onClick={() => void choose('file', view.path)}>
          {t('chat.local_files.choose_file', { defaultValue: 'Choose file' })}
        </Button>
        <Button disabled={blocked} onClick={() => void choose('directory', view.path)}>
          {t('chat.local_files.choose_directory', { defaultValue: 'Choose directory' })}
        </Button>
        <Button disabled={!view.busy} onClick={() => void clearAccess()}>
          {t('chat.local_files.cancel', { defaultValue: 'Cancel request' })}
        </Button>
        <Button disabled={!view.grant && !view.busy} onClick={() => void clearAccess()}>
          {t('chat.local_files.revoke', { defaultValue: 'Revoke access' })}
        </Button>
      </Stack>
      {view.error && (
        <Alert severity="error">
          {t(`chat.local_files.errors.${view.error}`, {
            defaultValue: AGENT_LOCAL_FILE_ERRORS[view.error]
          })}
        </Alert>
      )}
      {view.grant && (
        <Stack spacing={1}>
          <Typography variant="body2">{formatLocalFilePreview(view.grant.name).text}</Typography>
          <Typography variant="caption">
            {t('chat.local_files.read_only', { defaultValue: 'Read-only access' })}
            {' · '}
            {t('chat.local_files.expires', {
              defaultValue: 'Expires: {{expiry}}',
              expiry: new Date(view.grant.expiresAt).toLocaleString()
            })}
          </Typography>
          {view.grant.kind === 'directory' && (
            <>
              <Typography variant="body2">
                {view.directory
                  ? formatLocalFilePreview(view.directory).text
                  : t('chat.local_files.root', { defaultValue: 'Granted directory' })}
              </Typography>
              <Button
                disabled={blocked || !view.directory}
                onClick={() =>
                  void browse('directory', view.directory.split('/').slice(0, -1).join('/'))
                }
              >
                {t('chat.local_files.back', { defaultValue: 'Back' })}
              </Button>
              <List
                dense
                aria-label={t('chat.local_files.entries', { defaultValue: 'Directory entries' })}
              >
                {view.listing?.entries.map((entry) => (
                  <ListItemButton
                    key={entry.name}
                    disabled={blocked}
                    onClick={() =>
                      void browse(
                        entry.kind,
                        [view.directory, entry.name].filter(Boolean).join('/')
                      )
                    }
                  >
                    {entry.kind === 'directory'
                      ? t('chat.local_files.directory_entry', {
                          defaultValue: '{{name}} (directory)',
                          name: formatLocalFilePreview(entry.name).text
                        })
                      : t('chat.local_files.file_entry', {
                          defaultValue: '{{name}} (file)',
                          name: formatLocalFilePreview(entry.name).text
                        })}
                  </ListItemButton>
                ))}
              </List>
              {view.listing?.truncated && (
                <Typography variant="caption">
                  {t('chat.local_files.list_truncated', {
                    defaultValue:
                      'Only the first directory entries are shown. This list is not recursive.'
                  })}
                </Typography>
              )}
            </>
          )}
        </Stack>
      )}
      {view.preview && (
        <>
          {view.preview.document ? (
            <Typography variant="body2">
              {t('chat.local_files.document_details', {
                defaultValue:
                  '{{name}} · {{format}} · {{returnedBytes}} extracted bytes · {{sizeBytes}} source bytes',
                name: formatLocalFilePreview(view.preview.name).text,
                format: view.preview.document.format.toUpperCase(),
                returnedBytes: view.preview.returnedBytes,
                sizeBytes: view.preview.sizeBytes
              })}
            </Typography>
          ) : (
            <Typography variant="body2">
              {t('chat.local_files.file_details', {
                defaultValue: '{{name}} · UTF-8 · {{returnedBytes}} bytes of {{sizeBytes}} bytes',
                name: formatLocalFilePreview(view.preview.name).text,
                returnedBytes: view.preview.returnedBytes,
                sizeBytes: view.preview.sizeBytes
              })}
            </Typography>
          )}
          {view.preview.document?.warnings.includes('reading-order-unverified') && (
            <Alert severity="info">
              {t('chat.local_files.reading_order', {
                defaultValue:
                  'PDF page numbers are preserved; text reading order is not guaranteed. Scanned images are not OCR.'
              })}
            </Alert>
          )}
          {view.preview.truncated && (
            <Alert severity="warning">
              {t('chat.local_files.extraction_truncated', {
                defaultValue:
                  'Extraction was limited. Only the displayed extracted portion and its locators will be attached.'
              })}
            </Alert>
          )}
          <Box
            component="pre"
            role="region"
            aria-label={t('chat.local_files.preview', { defaultValue: 'Text preview' })}
            sx={{
              m: 0,
              p: 1,
              maxHeight: 240,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere'
            }}
          >
            {visualPreview.text}
          </Box>
          {visualPreview.truncated && (
            <Alert severity="warning">
              {t('chat.local_files.preview_shortened', {
                defaultValue:
                  'The visual preview is shortened. The full original text will still be added after confirmation.'
              })}
            </Alert>
          )}
          <FormControlLabel
            disabled={blocked}
            control={
              <Checkbox
                checked={view.acknowledged}
                onChange={(_, acknowledged) => update({ acknowledged })}
              />
            }
            label={t('chat.local_files.disclosure', {
              defaultValue:
                'I understand: this text will be placed in the draft and chat history, and sent to the selected model (which may be remote and cost tokens) only when I send. Files are untrusted data. Nothing is sent automatically. Revoking read access does not remove text already added to the draft or history.'
            })}
          />
          <Button
            disabled={blocked || !view.acknowledged}
            onClick={() => {
              if (
                disabled ||
                owner.busy ||
                !owner.live ||
                !view.preview ||
                !view.acknowledged ||
                owner.activation !== 'active'
              )
                return
              const preview = view.preview
              const attachVersion = owner.version
              update({ attachPending: true, attachFeedback: null })
              void (async () => {
                try {
                  const result = await onAttach(preview)
                  if (!owner.live || owner.version !== attachVersion) return
                  if (result === true) {
                    update({
                      attachPending: false,
                      acknowledged: false,
                      attachFeedback: 'success'
                    })
                  } else {
                    update({ attachPending: false, attachFeedback: 'failure' })
                  }
                } catch {
                  if (!owner.live || owner.version !== attachVersion) return
                  update({ attachPending: false, attachFeedback: 'failure' })
                }
              })()
            }}
          >
            {t('chat.local_files.attach', { defaultValue: 'Use this text in the conversation' })}
          </Button>
          {view.attachFeedback === 'success' && (
            <Alert severity="success">
              {t('chat.local_files.attach_success', {
                defaultValue: 'Added to the conversation draft. Nothing was sent yet.'
              })}
            </Alert>
          )}
          {view.attachFeedback === 'failure' && (
            <Alert severity="error">
              {t('chat.local_files.attach_failure', {
                defaultValue:
                  'Could not add this text to the conversation draft. Review it and try again.'
              })}
            </Alert>
          )}
        </>
      )}
    </Stack>
  )
}

export default AgentLocalFilesPanel
