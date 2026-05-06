import { QAppDesignComponent } from './types'
import { conditionFieldComfySelect } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const DsnInputComfySelect: QAppDesignComponent<'InputComfySelect'> = buildDesignComponent({
  inputType: 'InputComfySelect',
  allowFieldCondition: conditionFieldComfySelect
})

export default DsnInputComfySelect
