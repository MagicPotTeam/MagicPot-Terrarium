import { QAppDesignComponent } from './types'
import { conditionFieldTypeIs } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const allowFieldCondition = conditionFieldTypeIs('STRING')

const DsnInputText: QAppDesignComponent<'InputText'> = buildDesignComponent({
  inputType: 'InputText',
  allowFieldCondition: allowFieldCondition
})

export default DsnInputText
