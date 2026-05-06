import React from 'react'
import { Box, Container, Paper } from '@mui/material'
import ResultSection from './ResultList/ResultSection'

/**
 * 画板页面 — 独立标签页，用于展示生成的图片结果
 */
const CanvasPage: React.FC = () => {
  return (
    <Box sx={{ flex: 1, display: 'flex', bgcolor: 'background.default', minHeight: 0 }}>
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
        <Box
          sx={{
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
              overflowY: 'overlay',
              overflowX: 'hidden',
              py: 2
            }}
          >
            <ResultSection />
          </Container>
        </Box>
      </Paper>
    </Box>
  )
}

export default CanvasPage
