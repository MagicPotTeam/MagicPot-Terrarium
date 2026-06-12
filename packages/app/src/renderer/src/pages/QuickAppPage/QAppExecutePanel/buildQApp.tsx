import { type QAppCfg } from '@shared/qApp/cfgTypes'
import { type Workflow } from '@shared/comfy/types'
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { PanelProps } from './PanelProps'
import { ExeAutoRef, ExeInputRef } from './qAppExecuteInputs/types'
import { deepCopy } from '@shared/utils/utilTypes'
import { Alert, Stack, TextField } from '@mui/material'
import { sectionize } from './sectionize'
import { useMessage } from '@renderer/hooks/useMessage'
import { CalloutNodeNotInstalled } from '../components/CalloutNodeNotInstalled'
import { CalloutMissingModels } from '../components/CalloutMissingModels'
import { CalloutComfyAPINotAvailable } from '../components/CalloutComfyAPINotAvailable'
import { useQAppContext, useQAppInputState } from '../components/QAppContext'
import { useTranslation } from 'react-i18next'
import {
  buildComfyOrgExtraData,
  QAPP_COMFY_ORG_API_KEY_FORM_KEY,
  workflowRequiresComfyOrgAuth
} from '../utils/qAppComfyApiAuth'
import { getQAppSessionKey } from '../utils/qAppSessionIdentity'

const buildQApp = (cfg: QAppCfg, workflowTemplate: Workflow): React.FC<PanelProps> => {
  const customNodeUrls = cfg.customNodeUrls
  const requiredModels = cfg.requiredModels

  const QApp: React.FC<PanelProps> = ({ objectInfos, config, buildEnv, clientId }: PanelProps) => {
    const { t } = useTranslation()
    const { notifyError } = useMessage()
    const {
      currentQAppKey,
      setValidate,
      setBuildWorkflow,
      setBuildSubmitExtraData,
      setSubmitClientId,
      setSubmitSessionKey
    } = useQAppContext()
    const autoRefs = useRef<ExeAutoRef[]>([])
    const inputRefs = useRef<ExeInputRef[]>([])
    const [comfyOrgApiKey, setComfyOrgApiKey] = useQAppInputState<string>(
      QAPP_COMFY_ORG_API_KEY_FORM_KEY,
      ''
    )

    const requiresComfyOrgAuth = useMemo(
      () => workflowRequiresComfyOrgAuth(workflowTemplate, objectInfos),
      [objectInfos]
    )

    const structedInput = useMemo(() => sectionize(cfg, workflowTemplate), [])
    const submitSessionKey = useMemo(
      () => getQAppSessionKey({ qAppKey: currentQAppKey }),
      [currentQAppKey]
    )

    const validate = useCallback((): boolean => {
      const errorTexts: string[] = []

      if (requiresComfyOrgAuth && !comfyOrgApiKey.trim()) {
        errorTexts.push(t('qapp.comfy_org_api.validation_required'))
      }

      for (const autoRef of autoRefs.current) {
        const errorText = autoRef.validate(workflowTemplate)
        if (errorText) {
          errorTexts.push(errorText)
        }
      }
      for (const inputRef of inputRefs.current) {
        const errorText = inputRef.validate(workflowTemplate)
        if (errorText) {
          errorTexts.push(errorText)
        }
      }
      if (errorTexts.length > 0) {
        notifyError(errorTexts.join('\n'))
        return false
      }
      return true
    }, [comfyOrgApiKey, notifyError, requiresComfyOrgAuth, t])

    const buildWorkflow = useCallback((): Workflow => {
      const workflow = deepCopy(workflowTemplate)
      for (const autoRef of autoRefs.current) {
        autoRef.modifyWorkflow(workflow)
      }
      for (const inputRef of inputRefs.current) {
        inputRef.modifyWorkflow(workflow)
      }
      return workflow
    }, [])

    const buildSubmitExtraData = useCallback(() => {
      if (!requiresComfyOrgAuth) {
        return undefined
      }
      return buildComfyOrgExtraData(comfyOrgApiKey)
    }, [comfyOrgApiKey, requiresComfyOrgAuth])

    // Register stable functions in QAppContext. The implementations above can
    // legitimately change when input values, i18n, or notification callbacks
    // change; pushing those changing function identities into parent state can
    // create a render/effect/update loop. Stable wrappers keep the parent state
    // steady while still invoking the latest implementation.
    const validateRef = useRef(validate)
    const buildWorkflowRef = useRef(buildWorkflow)
    const buildSubmitExtraDataRef = useRef(buildSubmitExtraData)
    validateRef.current = validate
    buildWorkflowRef.current = buildWorkflow
    buildSubmitExtraDataRef.current = buildSubmitExtraData

    const stableValidate = useCallback((): boolean => validateRef.current(), [])
    const stableBuildWorkflow = useCallback((): Workflow => buildWorkflowRef.current(), [])
    const stableBuildSubmitExtraData = useCallback(() => buildSubmitExtraDataRef.current(), [])

    useEffect(() => {
      setValidate(stableValidate)
      setBuildWorkflow(stableBuildWorkflow)
      setBuildSubmitExtraData(stableBuildSubmitExtraData)
      return () => {
        setValidate(undefined)
        setBuildWorkflow(undefined)
        setBuildSubmitExtraData(undefined)
      }
    }, [
      setBuildSubmitExtraData,
      setBuildWorkflow,
      setValidate,
      stableBuildSubmitExtraData,
      stableBuildWorkflow,
      stableValidate
    ])

    useEffect(() => {
      setSubmitClientId(clientId)
      return () => setSubmitClientId(undefined)
    }, [clientId, setSubmitClientId])

    useEffect(() => {
      setSubmitSessionKey(submitSessionKey)
      return () => setSubmitSessionKey(undefined)
    }, [setSubmitSessionKey, submitSessionKey])

    return (
      <Stack
        spacing={3.25}
        sx={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', overflowY: 'visible' }}
      >
        <CalloutMissingModels requiredModels={requiredModels} />
        <CalloutNodeNotInstalled
          workflow={workflowTemplate}
          objectInfos={objectInfos}
          customNodeUrls={customNodeUrls}
        />
        <CalloutComfyAPINotAvailable isDesignMode={false} objectInfos={objectInfos} />
        {requiresComfyOrgAuth && (
          <Stack spacing={1.5}>
            <Alert severity="info">{t('qapp.comfy_org_api.alert')}</Alert>
            <TextField
              type="password"
              fullWidth
              label={t('qapp.comfy_org_api.label')}
              placeholder={t('qapp.comfy_org_api.placeholder')}
              value={comfyOrgApiKey}
              onChange={(event) => setComfyOrgApiKey(event.target.value)}
              helperText={t('qapp.comfy_org_api.helper')}
              autoComplete="off"
            />
          </Stack>
        )}
        {structedInput.autoInputs.map((autoInput) => (
          <autoInput.Component
            key={autoInput.componentIndex}
            ref={(ref) => {
              autoRefs.current[autoInput.componentIndex] = ref as unknown as ExeAutoRef
            }}
            objectInfos={objectInfos}
            config={config}
            buildEnv={buildEnv}
          />
        ))}
        {structedInput.headInputs.map((input) => (
          <input.Component
            ref={(ref) => {
              inputRefs.current[input.componentIndex] = ref as unknown as ExeInputRef
            }}
            key={input.componentIndex}
            objectInfos={objectInfos}
            config={config}
            buildEnv={buildEnv}
          />
        ))}
        {structedInput.sections.map((section) => (
          <section.Component key={section.sectionIndex}>
            {section.inputs.map((input) => (
              <input.Component
                ref={(ref) => {
                  inputRefs.current[input.componentIndex] = ref as unknown as ExeInputRef
                }}
                key={input.componentIndex}
                objectInfos={objectInfos}
                config={config}
                buildEnv={buildEnv}
              />
            ))}
          </section.Component>
        ))}
      </Stack>
    )
  }

  return QApp
}

export default buildQApp
