import { QAppDesignComponent } from './types'
import { conditionFieldImageUpload } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const DsnInputComfyImage: QAppDesignComponent<'InputComfyImage'> = buildDesignComponent({
  inputType: 'InputComfyImage',
  allowFieldCondition: conditionFieldImageUpload
})

export default DsnInputComfyImage
