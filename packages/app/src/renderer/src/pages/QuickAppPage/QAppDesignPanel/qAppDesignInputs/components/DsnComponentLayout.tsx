import React from 'react'
import { Card, CardContent, Stack } from '@mui/material'

type DsnComponentLayoutProps = {
  children: React.ReactNode
}

const DsnComponentLayout: React.FC<DsnComponentLayoutProps> = ({ children }) => {
  return (
    <Card>
      <CardContent>
        <Stack spacing={2}>{children}</Stack>
      </CardContent>
    </Card>
  )
}

export default DsnComponentLayout
