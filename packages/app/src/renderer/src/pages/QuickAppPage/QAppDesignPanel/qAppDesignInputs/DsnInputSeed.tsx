import { QAppDesignComponent } from './types'
import { conditionFieldSeed } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const DsnInputSeed: QAppDesignComponent<'InputSeed'> = buildDesignComponent({
  inputType: 'InputSeed',
  allowFieldCondition: conditionFieldSeed
})

export default DsnInputSeed
