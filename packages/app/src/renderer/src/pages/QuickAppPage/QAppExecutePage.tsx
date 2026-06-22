import React, { useEffect, useState } from 'react'
import { Box, Paper, Container, Typography, CircularProgress } from '@mui/material'
import { SmartButton } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import { Workflow } from '@shared/comfy/types'
import StatusBar from './components/StatusBar'
import ResultSection from './ResultList/ResultSection'
import QAppPanel from './QAppExecutePanel/QAppInputPanel'
import QAppMenu from './components/QAppMenu'
import { QAppContextProvider, dispatchQAppFillParams } from './components/QAppContext'
import DuplicateCheckWorkspace from './duplicateCheck/DuplicateCheckWorkspace'
import { isBuiltinDuplicateCheckQApp } from './duplicateCheck/builtin'
import VideoGenerationWorkspace from './videoGeneration/VideoGenerationWorkspace'
import { isBuiltinVideoGenerationQApp } from './videoGeneration/builtin'

const STORAGE_KEY = 'qapp.currentQAppKey'

type SwitchQAppDetail = {
  qAppKey: string
  workflow?: Workflow
}

const readStoredQAppKey = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) || ''
  } catch {
    return ''
  }
}

const persistQAppKey = (qAppKey: string): void => {
  try {
    if (qAppKey) {
      localStorage.setItem(STORAGE_KEY, qAppKey)
    } else {
      localStorage.removeItem(STORAGE_KEY)
    }
  } catch {
    /* ignore storage failures */
  }
}

const emitWorkflowFill = (qAppKey: string, workflow: Workflow): void => {
  dispatchQAppFillParams({ qAppKey, workflow })
}

const EmptyState: React.FC<{ message: string }> = ({ message }) => (
  <Box
    sx={{
      flex: 1,
      minHeight: 240,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 1.5
    }}
  >
    <SmartButton sx={{ fontSize: 64, color: 'text.disabled' }} />
    <Typography variant="h6" color="text.secondary" textAlign="center">
      {message}
    </Typography>
  </Box>
)

const QAppExecutePage: React.FC = () => {
  const { t } = useTranslation()
  const [currentQAppKey, setCurrentQAppKey] = useState<string>(readStoredQAppKey)
  const isDuplicateCheckPage = isBuiltinDuplicateCheckQApp(currentQAppKey)
  const isVideoGenerationPage = isBuiltinVideoGenerationQApp(currentQAppKey)

  useEffect(() => {
    persistQAppKey(currentQAppKey)
  }, [currentQAppKey])

  useEffect(() => {
    const handleSwitchQApp = (event: Event) => {
      const detail = (event as CustomEvent<SwitchQAppDetail>).detail
      setCurrentQAppKey(detail.qAppKey)

      if (detail.workflow) {
        emitWorkflowFill(detail.qAppKey, detail.workflow)
      }
    }

    window.addEventListener('qapp:switch', handleSwitchQApp)
    return () => {
      window.removeEventListener('qapp:switch', handleSwitchQApp)
    }
  }, [])

  return (
    <Box sx={{ flex: 1, display: 'flex', bgcolor: 'background.default', minHeight: 0 }}>
      <QAppMenu currentQAppKey={currentQAppKey} setCurrentQAppKey={setCurrentQAppKey} />

      <Paper sx={{ flex: 1, m: 2, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {isDuplicateCheckPage ? (
          <Container
            sx={{
              flex: 1,
              overflowY: 'auto',
              overflowX: 'hidden',
              py: 2,
              overscrollBehavior: 'contain',
              scrollbarGutter: 'stable'
            }}
          >
            <DuplicateCheckWorkspace />
          </Container>
        ) : isVideoGenerationPage ? (
          <VideoGenerationWorkspace />
        ) : (
          <QAppContextProvider key={currentQAppKey} qAppKey={currentQAppKey}>
            <Box
              sx={{
                py: 2,
                display: 'grid',
                gridTemplateColumns: '3fr 2fr',
                gap: 1,
                flex: 1,
                minHeight: 0
              }}
            >
              <Box
                sx={{
                  m: 2,
                  px: 0,
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden'
                }}
              >
                <Container
                  sx={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    py: 2,
                    overscrollBehavior: 'contain',
                    scrollbarGutter: 'stable'
                  }}
                >
                  {currentQAppKey ? (
                    <QAppPanel fallback={<CircularProgress />} />
                  ) : (
                    <EmptyState message={t('qapp.select_prompt')} />
                  )}
                </Container>
              </Box>

              <Box
                sx={{
                  m: 2,
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: 0,
                  overflow: 'hidden'
                }}
              >
                <Container
                  sx={{
                    flex: 1,
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    py: 0,
                    overscrollBehavior: 'contain',
                    scrollbarGutter: 'stable'
                  }}
                >
                  <ResultSection />
                </Container>
              </Box>
            </Box>
          </QAppContextProvider>
        )}

        <StatusBar />
      </Paper>
    </Box>
  )
}

export default QAppExecutePage
