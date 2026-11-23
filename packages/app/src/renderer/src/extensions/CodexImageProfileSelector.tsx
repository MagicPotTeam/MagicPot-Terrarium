import React from 'react'
import { Box, Stack, Typography } from '@mui/material'
import type { AgentApiProfileCardRenderOptions } from '@renderer/extensions/generatedRegistry'
import { resolveProfileModelUse } from '@shared/llm'
import { resolveCodexImageBackend } from '@shared/extensions/codexImageProfile'
import enCodex from '@shared/locales/en-US/codex.json'
import zhCodex from '@shared/locales/zh-CN/codex.json'

/** Existing settings-card control only; selection never performs auth or discovery. */
export default function CodexImageProfileSelector({
  profile,
  profiles,
  onUpdate,
  isChineseUi
}: AgentApiProfileCardRenderOptions) {
  const selectId = React.useId()
  if (['image', 'video', 'ocr'].includes(resolveProfileModelUse(profile))) return null
  const copy = (key: keyof typeof enCodex) => (isChineseUi ? zhCodex : enCodex)[key] ?? enCodex[key]
  const counts = new Map<string, number>()
  for (const candidate of profiles) counts.set(candidate.id, (counts.get(candidate.id) ?? 0) + 1)
  const eligible = profiles.filter(
    (candidate) => counts.get(candidate.id) === 1 && resolveCodexImageBackend(candidate)
  )
  const selected =
    typeof profile.codex_image_profile_id === 'string' ? profile.codex_image_profile_id : ''
  const unavailable = selected && !eligible.some((candidate) => candidate.id === selected)
  return (
    <Stack spacing={1}>
      <Box component="label" htmlFor={selectId}>
        {copy('image_backend_label')}
      </Box>
      <Box
        component="select"
        id={selectId}
        value={selected}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
          onUpdate(profile.id, {
            ...profile,
            codex_image_profile_id: event.target.value || undefined
          })
        }
        sx={{
          p: 1,
          borderRadius: 1,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderColor: 'divider',
          width: '100%'
        }}
      >
        <option value="">
          {resolveCodexImageBackend(profile)
            ? copy('image_backend_own')
            : copy('image_backend_none')}
        </option>
        {unavailable && (
          <option value={selected} disabled>
            {copy('image_backend_unavailable')}: {selected}
          </option>
        )}
        {eligible.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.model_name || 'Codex'} ({candidate.id})
          </option>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {copy('image_backend_hint')}
      </Typography>
    </Stack>
  )
}
