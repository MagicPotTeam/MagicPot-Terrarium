import { useEffect, useState } from 'react'
import { useInputLabel } from './components/InputLabel'
import { QAppDesignComponent, QAppDesignProps } from './types'
import { QAppCfgDescription } from '@shared/qApp/cfgTypes'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputSelect from '@renderer/components/inputs/InputSelect'
import InputText from '@renderer/components/inputs/InputText'

const DsnDescription: QAppDesignComponent<'Description'> = ({
  value,
  setValue,
  id,
  onDelete
}: QAppDesignProps<'Description'>) => {
  const { label, InputLabel } = useInputLabel(value?.label, id, 'Description', onDelete)
  const [title, setTitle] = useState(value?.title || '')
  const [variant, setVariant] = useState(value?.variant || 'info')
  const [description, setDescription] = useState(value?.description || 'Put your description here')

  useEffect(() => {
    setValue({
      label,
      component: 'Description',
      title,
      variant,
      description
    } satisfies QAppCfgDescription)
  }, [label, title, variant, description, setValue])

  return (
    <DsnComponentLayout>
      <InputLabel />
      <InputText value={title} onChange={setTitle} label="标题" placeholder="标题" />
      <InputSelect
        value={variant}
        onChange={(value) => setVariant(value as 'info' | 'warning' | 'error' | 'success')}
        label="样式"
        items={['info', 'warning', 'error', 'success'].map((value) => ({
          label: value,
          value
        }))}
      />
      <InputText value={description} onChange={setDescription} label="描述" placeholder="描述" />
    </DsnComponentLayout>
  )
}

export default DsnDescription
