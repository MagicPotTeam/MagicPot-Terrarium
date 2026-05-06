import { useEffect, useState } from 'react'
import { QAppDesignComponent, QAppDesignProps } from './types'
import { useInputLabel } from './components/InputLabel'
import InputSelect from '@renderer/components/inputs/InputSelect'
import InputSwitch from '@renderer/components/inputs/InputSwitch'
import { Box, Divider, Stack, Typography } from '@mui/material'
import { QAppCfgSection } from '@shared/qApp/cfgTypes'

const DsnSection: QAppDesignComponent<'Section'> = ({
  workflow,
  objectInfos,
  config,
  buildEnv,
  id,
  value,
  setValue,
  onDelete
}: QAppDesignProps<'Section'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'Section', onDelete)
  const [defaultExpanded, setDefaultExpanded] = useState<boolean>(value?.defaultExpanded ?? true)
  const [gridStyle, setGridStyle] = useState<'wide' | 'split'>(value?.gridStyle || 'split')

  useEffect(() => {
    if (!label) {
      return
    }
    setValue({
      label,
      component: 'Section',
      defaultExpanded,
      gridStyle
    } satisfies QAppCfgSection)
  }, [label, setValue, defaultExpanded, gridStyle])

  return (
    <Box>
      <Divider textAlign="left" sx={{ my: 2 }}>
        <Typography variant="h6">分组：{label}</Typography>
      </Divider>
      <Box border={1} borderColor={'divider'} borderRadius={1} sx={{ p: 2 }}>
        <Stack spacing={2}>
          <InputLabel />
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 2
            }}
          >
            <InputSwitch value={defaultExpanded} onChange={setDefaultExpanded} label="默认展开" />
            <InputSelect
              value={gridStyle}
              onChange={(value) => setGridStyle(value as 'wide' | 'split')}
              label="网格样式"
              items={['wide', 'split'].map((value) => ({
                label: value,
                value
              }))}
            />
          </Box>
        </Stack>
      </Box>
    </Box>
  )
}

DsnSection.displayName = 'QAppDsnSection'

export default DsnSection
