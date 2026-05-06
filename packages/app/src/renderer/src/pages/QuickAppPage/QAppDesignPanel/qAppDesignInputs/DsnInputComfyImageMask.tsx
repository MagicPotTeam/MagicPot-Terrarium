import { QAppDesignComponent } from './types'
import { conditionFieldImageUpload } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const DsnInputComfyImageMask: QAppDesignComponent<'InputComfyImageMask'> = buildDesignComponent({
  inputType: 'InputComfyImageMask',
  allowFieldCondition: conditionFieldImageUpload
})

export default DsnInputComfyImageMask
