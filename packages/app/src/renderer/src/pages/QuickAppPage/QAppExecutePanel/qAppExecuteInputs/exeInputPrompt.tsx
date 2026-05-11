import React from 'react'
import { QAppCfgInputPrompt } from '@shared/qApp/cfgTypes'
import { ExeInputBuilder, ExeInputProps } from './types'
import { useImperativeHandle } from 'react'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { Workflow } from '@shared/comfy/types'
import { Box } from '@mui/material'
import InputTextAreaFunctional from '@renderer/components/inputs/InputTextAreaFunctional'
import { useQAppInputState } from '../../components/QAppContext'
import { useTranslation } from 'react-i18next'
import { useMessage } from '@renderer/hooks/useMessage'
import { useConfig } from '@renderer/hooks/useConfig'
import { defaultCliFromProfile } from './api/LLM'
import { fileToDataUrl, selectFile } from '@renderer/utils/fileUtils'
import { getQAppPromptSettings } from './qAppPromptSettings'
import { getDroppedImageDropError, getDroppedImageFile } from '@renderer/utils/droppedImageUtils'

const REPLACE_DESCRIPTION = '{{description}}'
const REPLACE_PROMPT = '{{prompt}}'

const buildPromptWithPreset = (presetPrompt: string, value: string): string => {
  const trimmedPresetPrompt = presetPrompt.trim()
  const trimmedValue = value.trim()

  if (!trimmedPresetPrompt) return value
  if (!trimmedValue) return trimmedPresetPrompt

  return `${trimmedPresetPrompt}, ${trimmedValue}`
}

const buildTranslationRequest = (
  systemPromptTemplate: string,
  userPromptTemplate: string,
  promptValue: string
) => {
  const trimmedSystemPromptTemplate = systemPromptTemplate.trim()
  const trimmedUserPromptTemplate = userPromptTemplate.trim()
  const trimmedPromptValue = promptValue.trim()

  if (trimmedUserPromptTemplate) {
    return {
      prompt: resolveTemplate(userPromptTemplate, REPLACE_PROMPT, trimmedPromptValue),
      systemPrompt: trimmedSystemPromptTemplate || undefined
    }
  }

  if (trimmedSystemPromptTemplate.includes(REPLACE_PROMPT)) {
    return {
      prompt: resolveTemplate(systemPromptTemplate, REPLACE_PROMPT, trimmedPromptValue)
    }
  }

  return {
    prompt: trimmedPromptValue,
    systemPrompt: trimmedSystemPromptTemplate || undefined
  }
}

const resolveTemplate = (template: string, placeholder: string, value: string) =>
  template.trim().split(placeholder).join(value)

const buildImageInterrogationRequest = (
  systemPromptTemplate: string,
  userPromptTemplate: string,
  promptDescription: string
) => {
  const systemPrompt = resolveTemplate(systemPromptTemplate, REPLACE_DESCRIPTION, promptDescription)
  const prompt = resolveTemplate(userPromptTemplate, REPLACE_DESCRIPTION, promptDescription)

  return {
    prompt,
    systemPrompt: systemPrompt || undefined
  }
}

const buildExeInputPrompt: ExeInputBuilder<'InputPrompt'> = (
  cfg: QAppCfgInputPrompt,
  workflow: Workflow
) => {
  const { label, slot, placeholder, suffixPrompt, maxLength, promptDescription } = cfg
  const defaultValue = getJsonPath(slot, workflow)
  if (typeof defaultValue !== 'string') {
    throw new Error(`defaultValue of slot ${slot} is not a string`)
  }
  const defaultInputValue = buildPromptWithPreset(suffixPrompt || '', defaultValue)
  const id = `QAppInputPrompt-${label}`

  const QAppPromptInput: React.FC<ExeInputProps> = ({ ref, ...props }) => {
    const [value, setValue] = useQAppInputState<string>(slot, defaultInputValue)
    const { config } = useConfig()
    const { notifyWarning } = useMessage()
    const { t } = useTranslation()
    const qAppPromptSettings = getQAppPromptSettings(config)

    const resolveError = (error: unknown) =>
      error instanceof Error ? error.message : String(error)

    const resolvedPromptDescription =
      promptDescription || (t('qapp.prompt.default_description') as string)

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          setJsonPath(slot, workflow, value)
        },
        validate: (workflow) => {
          if (maxLength && maxLength > 0 && value.length > maxLength) {
            return t('qapp.prompt.errors.max_length', { maxLength }) as string
          }
          return ''
        }
      }),
      [t, value]
    )

    const resolveImageInterrogationCli = () => {
      const cli = defaultCliFromProfile(
        config,
        true,
        qAppPromptSettings.imageInterrogationProfileId
      )
      if (!cli) {
        notifyWarning(t('qapp.prompt.errors.missing_profile_with_vision') as string)
        return null
      }
      return cli
    }

    const runImageInterrogation = async (
      imageFile: File,
      cli: ReturnType<typeof defaultCliFromProfile>
    ) => {
      if (!cli) return
      if (!imageFile.type.startsWith('image/')) {
        notifyWarning(t('qapp.prompt.errors.image_required') as string)
        return
      }

      let imageDataUrl = ''
      try {
        imageDataUrl = await fileToDataUrl(imageFile)
      } catch {
        imageDataUrl = ''
      }
      if (!imageDataUrl) {
        notifyWarning(t('qapp.prompt.errors.image_convert_failed') as string)
        return
      }

      try {
        const prompt = await cli.generatePrompt({
          ...buildImageInterrogationRequest(
            qAppPromptSettings.imageInterrogationSystemPrompt,
            qAppPromptSettings.imageInterrogationUserPrompt,
            resolvedPromptDescription
          ),
          imageObjUrl: imageDataUrl
        })
        setValue(prompt)
      } catch (error) {
        notifyWarning(
          t('qapp.prompt.errors.image_interrogation_failed', {
            error: resolveError(error)
          }) as string
        )
      }
    }

    const buttons: {
      text: string
      onClick: () => Promise<void>
      onDrop?: (event: React.DragEvent<HTMLDivElement>) => Promise<void>
    }[] = []
    if (qAppPromptSettings.useImageInterrogation) {
      buttons.push({
        text: t('qapp.prompt.buttons.image_interrogation') as string,
        onClick: async () => {
          const cli = resolveImageInterrogationCli()
          if (!cli) return
          const selectedImage = await selectFile(['png', 'jpg', 'jpeg', 'webp'])
          if (!selectedImage) {
            notifyWarning(t('qapp.prompt.errors.image_required') as string)
            return
          }
          await runImageInterrogation(selectedImage, cli)
        },
        onDrop: async (event) => {
          const cli = resolveImageInterrogationCli()
          if (!cli) return

          const dropError = getDroppedImageDropError(event.dataTransfer)
          if (dropError) {
            notifyWarning(dropError)
            return
          }

          let droppedImage: File | null = null
          try {
            droppedImage = await getDroppedImageFile(event.dataTransfer)
          } catch {
            notifyWarning(t('qapp.prompt.errors.image_convert_failed') as string)
            return
          }

          if (!droppedImage) {
            notifyWarning(t('qapp.prompt.errors.image_required') as string)
            return
          }

          await runImageInterrogation(droppedImage, cli)
        }
      })
    }
    if (qAppPromptSettings.usePromptTranslation) {
      buttons.push({
        text: t('qapp.prompt.buttons.translation') as string,
        onClick: async () => {
          if (!value.trim()) {
            notifyWarning(t('qapp.prompt.errors.prompt_required') as string)
            return
          }
          const cli = defaultCliFromProfile(
            config,
            false,
            qAppPromptSettings.promptTranslationProfileId
          )
          if (!cli) {
            notifyWarning(t('qapp.prompt.errors.missing_profile') as string)
            return
          }
          try {
            const translatedPrompt = await cli.generatePrompt(
              buildTranslationRequest(
                qAppPromptSettings.promptTranslationSystemPrompt,
                qAppPromptSettings.promptTranslationUserPrompt,
                value
              )
            )
            setValue(translatedPrompt)
          } catch (error) {
            notifyWarning(
              t('qapp.prompt.errors.translation_failed', {
                error: resolveError(error)
              }) as string
            )
          }
        }
      })
    }

    return (
      <Box sx={{ width: '100%', overflowX: 'hidden', overflowY: 'visible' }}>
        <InputTextAreaFunctional
          label={label}
          value={value}
          onChange={(v) => setValue(v)}
          placeholder={placeholder || `${label}...`}
          buttons={buttons}
          maxLength={maxLength}
          tagEditorStorageKey={`qapp.promptTags.${slot}`}
        />
      </Box>
    )
  }

  QAppPromptInput.displayName = id
  return QAppPromptInput
}

export default buildExeInputPrompt
