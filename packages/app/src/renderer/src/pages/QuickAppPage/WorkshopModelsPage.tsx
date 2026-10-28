import { Box, Paper } from '@mui/material'
import { Navigate, useLocation } from 'react-router-dom'
import ModelPage from '../FileBrowserPage/ModelPage'
import CustomWorkshopTabs from './components/CustomWorkshopTabs'
import { LEGACY_MODEL_ROUTE_PATH, WORKSHOP_MODELS_ROUTE_PATH } from './workshopRouting'

const WorkshopModelsPage: React.FC = () => {
  const { pathname, search, hash } = useLocation()

  if (pathname === LEGACY_MODEL_ROUTE_PATH) {
    return <Navigate to={{ pathname: WORKSHOP_MODELS_ROUTE_PATH, search, hash }} replace />
  }

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
        <CustomWorkshopTabs />
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <ModelPage />
        </Box>
      </Paper>
    </Box>
  )
}

export default WorkshopModelsPage
