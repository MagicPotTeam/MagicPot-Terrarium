// AIEngineElectron/packages/app/src/renderer/src/pages/SettingsPage/components/SettingSection.tsx
import React from 'react'
import { Box, Stack, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'

interface SettingSectionProps {
  title?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  surface?: boolean
}

const SettingSection: React.FC<SettingSectionProps> = ({
  title,
  action,
  children,
  surface = true
}) => {
  const theme = useTheme()
  const hasTitle = Boolean(title)
  const isLight = theme.palette.mode === 'light'
  const sectionSurface = isLight ? '#eef0f7' : '#1d1d1d'
  const shouldRenderSurface =
    surface &&
    !(
      typeof title === 'string' &&
      /Agent API|Agent设置|Agent配置|Agent线程配置|Custom Skills|Quick App|Hunyuan3D|快应用|自定义技能/i.test(
        title
      )
    )

  return (
    <Box
      sx={{
        // 只有有标题时才留上下外边距；无标题=不留空白
        mt: hasTitle ? 3.5 : 0,
        mb: hasTitle ? 1.5 : 0
      }}
    >
      {hasTitle && (
        <Box
          sx={{
            mb: 1.25,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2
          }}
        >
          <Typography
            variant="h6"
            sx={{
              fontWeight: 700,
              color: 'inherit',
              fontSize: 18
            }}
          >
            {title}
          </Typography>
          {action ? <Box>{action}</Box> : null}
        </Box>
      )}

      {shouldRenderSurface ? (
        <Box
          sx={{
            px: 2.75,
            py: 2.5,
            borderRadius: 3,
            bgcolor: sectionSurface
          }}
        >
          <Stack spacing={2.5}>{children}</Stack>
        </Box>
      ) : (
        <Stack spacing={2.5}>{children}</Stack>
      )}
    </Box>
  )
}

export default SettingSection
