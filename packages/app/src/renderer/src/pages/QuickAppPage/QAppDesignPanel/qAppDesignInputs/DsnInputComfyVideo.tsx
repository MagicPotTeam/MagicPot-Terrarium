import { QAppDesignComponent } from './types'
import { conditionFieldVideoUpload } from './conditions'
import buildDesignComponent from './buildDesignComponent'

const DsnInputComfyVideo: QAppDesignComponent<'InputComfyVideo'> = buildDesignComponent({
  inputType: 'InputComfyVideo',
  allowFieldCondition: conditionFieldVideoUpload
})

export default DsnInputComfyVideo
