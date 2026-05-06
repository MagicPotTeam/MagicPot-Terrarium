import { ObjectInfo, ObjectInfoInputField } from '@shared/comfy/types'
import { QAppCfgAllComponentTypeMap } from '@shared/qApp/cfgTypes'
import { HaveSlotCfgAutoType, HaveSlotCfgInputType } from '../../baseBuilderTypes'
import { QAppDesignComponent, QAppDesignProps } from './types'
import { useEffect, useState } from 'react'
import useInputLabel from './components/InputLabel'
import DsnComponentLayout from './components/DsnComponentLayout'
import InputNodeSelect from './components/InputNodeSelect'
import { QAppCfgComponentNameMap } from '@shared/qApp/consts'

type BuildDesignComponentArgs<InputType extends HaveSlotCfgInputType | HaveSlotCfgAutoType> = {
  inputType: InputType
  allowFieldCondition: (objInfoNode: ObjectInfo, objInfoField: ObjectInfoInputField) => boolean
}

const buildDesignComponent = <InputType extends HaveSlotCfgInputType | HaveSlotCfgAutoType>(
  args: BuildDesignComponentArgs<InputType>
): QAppDesignComponent<InputType> => {
  const DesignComponent = ({
    value,
    setValue,
    id,
    onDelete,
    workflow,
    objectInfos
  }: QAppDesignProps<InputType>) => {
    // 输入组件的 label
    const { label, InputLabel } = useInputLabel(value?.label, id, args.inputType, onDelete)
    // 输入组件的 slot
    const [slot, setSlot] = useState<string | null>(value?.slot || null)

    useEffect(() => {
      if (!slot) {
        return
      }
      setValue({
        label,
        slot,
        component: args.inputType
      } as QAppCfgAllComponentTypeMap[InputType])
    }, [label, slot, setValue])

    return (
      <DsnComponentLayout>
        <InputLabel />
        <InputNodeSelect
          label={`${QAppCfgComponentNameMap[args.inputType]}字段`}
          value={slot}
          onChange={setSlot}
          workflow={workflow}
          objectInfos={objectInfos}
          mode="field"
          allowFieldCondition={args.allowFieldCondition}
        />
      </DsnComponentLayout>
    )
  }

  DesignComponent.displayName = `QAppDsn${args.inputType}`

  return DesignComponent
}

export default buildDesignComponent
