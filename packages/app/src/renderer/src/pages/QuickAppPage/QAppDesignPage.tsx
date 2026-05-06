import { Box, Paper } from '@mui/material'
import React from 'react'
import QAppDesignPanel from './QAppDesignPanel/QAppDesignPanel'
import CustomWorkshopTabs from './components/CustomWorkshopTabs'
import { QAppContextProvider } from './components/QAppContext'

const QAppDesignPage: React.FC = () => {
  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        bgcolor: 'background.default'
      }}
    >
      <Paper
        sx={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          bgcolor: 'background.default',
          boxShadow: 'none'
        }}
      >
        <QAppContextProvider qAppKey="__design_temp__" skipServerFetch>
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              overflow: 'hidden'
            }}
          >
            <CustomWorkshopTabs />
            <QAppDesignPanel />
          </Box>
        </QAppContextProvider>
      </Paper>
    </Box>
  )
}

export default QAppDesignPage
