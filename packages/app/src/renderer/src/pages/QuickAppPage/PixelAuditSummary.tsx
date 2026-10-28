import { Alert, Box, Stack, Typography } from '@mui/material'
import { useTranslation } from 'react-i18next'
import type { FigPluginPixelAudit } from '@shared/figplugin/pixelAudit'

export default function PixelAuditSummary({ audit }: { audit?: FigPluginPixelAudit }) {
  const { t } = useTranslation()
  if (!audit) return <Alert severity="info">{t('figplugin.pixelAudit.pending')}</Alert>
  return (
    <Stack spacing={1} data-testid="figplugin-pixel-audit">
      <Alert severity={audit.outcome === 'match' ? 'success' : 'warning'}>
        {t(`figplugin.pixelAudit.${audit.outcome}`, {
          count: audit.targets.length,
          changed: audit.changedTargets,
          unavailable: audit.unavailableTargets
        })}
      </Alert>
      {audit.targets.map((target) => (
        <Box key={target.targetId}>
          <Typography variant="body2">
            {target.targetId}:{' '}
            {target.status === 'compared'
              ? t('figplugin.pixelAudit.metrics', {
                  changed: target.changedPixels,
                  total: target.pixelCount,
                  percent: ((100 * target.changedPixels) / target.pixelCount).toFixed(3),
                  max: target.maxChannelDelta,
                  mean: (target.absoluteDelta / (4 * target.pixelCount)).toFixed(3)
                })
              : t(
                  target.status === 'dimensions-changed'
                    ? 'figplugin.pixelAudit.dimensions'
                    : 'figplugin.pixelAudit.unavailable'
                )}
          </Typography>
          {target.status === 'compared' && target.changedBounds && (
            <Typography variant="body2">
              {t('figplugin.pixelAudit.bounds', target.changedBounds)}
            </Typography>
          )}
        </Box>
      ))}
      <Typography variant="body2">{t('figplugin.pixelAudit.boundary')}</Typography>
    </Stack>
  )
}
