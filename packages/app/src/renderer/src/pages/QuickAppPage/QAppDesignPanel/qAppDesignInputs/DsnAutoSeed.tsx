import { conditionFieldSeed } from './conditions'
import { QAppDesignComponent } from './types'
import buildDesignComponent from './buildDesignComponent'

const DsnAutoSeed: QAppDesignComponent<'AutoSeed'> = buildDesignComponent({
  inputType: 'AutoSeed',
  allowFieldCondition: conditionFieldSeed
})

export default DsnAutoSeed
