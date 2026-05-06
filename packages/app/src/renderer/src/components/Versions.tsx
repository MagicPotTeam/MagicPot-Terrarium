import React from 'react'
import { Box, Typography, Chip, Stack } from '@mui/material'

const Versions: React.FC = () => {
  const versions = [
    { name: 'Electron', version: '37.2.3' },
    { name: 'React', version: '19.1.0' },
    { name: 'TypeScript', version: '5.8.3' },
    { name: 'MUI', version: '7.3.1' }
  ]

  return (
    <Box
      sx={{
        position: 'absolute',
        bottom: 30,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        p: 2,
        borderRadius: 3,
        bgcolor: 'background.paper',
        border: 1,
        borderColor: 'divider',
        boxShadow: 2
      }}
    >
      {versions.map((item, index) => (
        <React.Fragment key={item.name}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {item.name}
            </Typography>
            <Chip
              label={item.version}
              size="small"
              variant="outlined"
              sx={{ fontSize: '0.75rem' }}
            />
          </Stack>
          {index < versions.length - 1 && (
            <Box
              sx={{
                width: 1,
                height: 20,
                bgcolor: 'divider',
                mx: 1
              }}
            />
          )}
        </React.Fragment>
      ))}
    </Box>
  )
}

export default Versions
