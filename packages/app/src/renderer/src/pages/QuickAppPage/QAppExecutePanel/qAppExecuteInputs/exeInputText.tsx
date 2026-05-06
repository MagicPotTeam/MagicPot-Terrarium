import { ExeInputBuilder } from './types'
import InputText from '@renderer/components/inputs/InputText'
import baseQAppInputBuilder from './baseBuilder'

const buildExeInputText: ExeInputBuilder<'InputText'> = baseQAppInputBuilder({
  typeofValue: '',
  inputType: 'InputText',
  InputComponent: InputText
})

export default buildExeInputText
