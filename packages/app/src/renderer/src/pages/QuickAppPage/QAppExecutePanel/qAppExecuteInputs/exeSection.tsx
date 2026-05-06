import React from 'react'
import { QAppCfgSection } from '@shared/qApp/cfgTypes'
import { Accordion, AccordionDetails, AccordionSummary, Box, Typography } from '@mui/material'
import { ExpandMore } from '@mui/icons-material'
import { useQAppLabel } from '../../hooks/useQAppLabel'

export type ExecuteSectionProps = {
  children: React.ReactNode
}

const buildExeSection = (cfg: QAppCfgSection) => {
  const { label, defaultExpanded = true, gridStyle = 'split' } = cfg
  const id = `QAppInputSection-${label}`

  const QAppInputSection: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const translatedLabel = useQAppLabel(label)

    return (
      <Accordion disableGutters defaultExpanded={defaultExpanded}>
        <AccordionSummary expandIcon={<ExpandMore />} sx={{ padding: 0 }}>
          <Typography variant="h6">{translatedLabel}</Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ padding: 0 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: gridStyle === 'wide' ? '1fr' : { xs: '1fr', sm: '1fr 1fr' },
              gap: 2
            }}
          >
            {children}
          </Box>
        </AccordionDetails>
      </Accordion>
    )
  }

  QAppInputSection.displayName = id

  return QAppInputSection
}

export default buildExeSection
