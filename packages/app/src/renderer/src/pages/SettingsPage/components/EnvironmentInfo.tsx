// packages/app/src/renderer/src/pages/SettingsPage/components/EnvironmentInfo.tsx

import { Box, Button, Card, CardContent, Typography, Stack } from '@mui/material'
import { Code as CodeIcon, Refresh as RefreshIcon, Info as InfoIcon } from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { TFunction } from 'i18next'

// 用“状态枚举 + 原始值”的方式避免把英文直接塞进 state
type DetectStatus = 'idle' | 'ok' | 'failed' | 'notfound'

type DetectState = {
  status: DetectStatus
  raw?: string
}

function useDetectItem() {
  const [state, setState] = useState<DetectState>({ status: 'idle', raw: undefined })

  const update = (v?: string) => {
    if (v && v.trim()) {
      setState({ status: 'ok', raw: v.trim() })
    }
  }

  const setFailed = () => {
    setState((prev) => (prev.status === 'ok' ? prev : { status: 'failed' }))
  }

  const finish = () => {
    setState((prev) => (prev.status === 'ok' ? prev : { status: 'notfound' }))
  }

  const reset = () => setState({ status: 'idle', raw: undefined })

  return [state, update, { setFailed, finish, reset }] as const
}

function useDetectInfo(
  ...items: {
    setFailed: () => void
    finish: () => void
    reset: () => void
  }[]
) {
  const setFailedDetect = () => items.forEach((i) => i.setFailed())
  const finishDetect = () => items.forEach((i) => i.finish())
  const resetDetect = () => items.forEach((i) => i.reset())
  return { setFailedDetect, finishDetect, resetDetect }
}

// 根据状态 + 语言，得到展示字符串（切语言时会自动重算）
function displayValue(state: DetectState, t: TFunction) {
  switch (state.status) {
    case 'ok':
      return state.raw ?? ''
    case 'failed':
      return t('environment.status_failed')
    case 'notfound':
      return t('environment.status_not_found')
    case 'idle':
    default:
      return t('environment.status_untested')
  }
}

const EnvironmentInfo: React.FC = () => {
  const { t } = useTranslation()

  const [pythonState, updatePython, pythonOps] = useDetectItem()
  const [pytorchState, updatePytorch, pytorchOps] = useDetectItem()
  const [gpuState, updateGpu, gpuOps] = useDetectItem()

  const { setFailedDetect, finishDetect, resetDetect } = useDetectInfo(
    pythonOps,
    pytorchOps,
    gpuOps
  )
  const [isDetecting, setIsDetecting] = useState(false)

  const detectEnvironment = async () => {
    setIsDetecting(true)
    resetDetect()

    try {
      await api().svcHyper.environmentDetect(
        {},
        {
          onData: (data) => {
            updatePython(data.pythonVersion)
            updatePytorch(data.pytorchVersion)
            updateGpu(data.gpuInfo)
          }
        }
      )
    } catch (error) {
      console.error(t('environment.err_detect_env') + ':', error)
      setFailedDetect()
      setIsDetecting(false)
    } finally {
      finishDetect()
      setIsDetecting(false)
    }
  }

  const cards = [
    {
      title: t('environment.python_title'),
      value: displayValue(pythonState, t),
      icon: <CodeIcon fontSize="small" />
    },
    {
      title: t('environment.pytorch_title'),
      value: displayValue(pytorchState, t),
      icon: <CodeIcon fontSize="small" />
    },
    {
      title: t('environment.gpu_title'),
      value: displayValue(gpuState, t),
      icon: <InfoIcon fontSize="small" />
    }
  ]

  return (
    <Box sx={{ mb: 2 }}>
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 2 }}>
        <Typography variant="h6">{t('environment.detect_title')}</Typography>
        <Button
          variant="outlined"
          startIcon={<RefreshIcon />}
          onClick={detectEnvironment}
          disabled={isDetecting}
          size="small"
        >
          {isDetecting ? t('environment.action_detecting') : t('environment.action_detect')}
        </Button>
      </Stack>

      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {cards.map((item, idx) => (
          <Card key={idx} variant="outlined" sx={{ minWidth: 200 }}>
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                {item.icon}
                <Typography variant="subtitle2" color="text.secondary">
                  {item.title}
                </Typography>
              </Stack>
              <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                {item.value}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Box>
  )
}

export default EnvironmentInfo
