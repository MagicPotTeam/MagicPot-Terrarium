// packages/app/src/renderer/src/components/MainArea.tsx
import React, { Suspense } from 'react'
import { Box, CircularProgress } from '@mui/material'
import { Routes, Route, useLocation } from 'react-router-dom'
import { routes } from '../routes'

const MainArea: React.FC = () => {
  const location = useLocation()

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minWidth: 0,
        minHeight: 0
      }}
    >
      {/* 内容区 */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          bgcolor: 'background.default',
          minHeight: 0
        }}
      >
        <Routes>
          {routes.map((route) => (
            <Route
              key={route.id}
              path={route.path}
              element={
                <Suspense
                  fallback={
                    <Box
                      sx={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        minHeight: 0
                      }}
                    >
                      <CircularProgress size={28} />
                    </Box>
                  }
                >
                  <route.Page key={location.pathname + location.search} />
                </Suspense>
              }
            />
          ))}
        </Routes>
      </Box>
    </Box>
  )
}

export default MainArea
