import React, { useImperativeHandle } from 'react'
import { ExeAutoBuilder, ExeAutoProps } from './types'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'

const buildExeAutoSeed: ExeAutoBuilder<'AutoSeed'> = (cfg, workflow) => {
  const { label, slot } = cfg
  const id = `QAppAutoSeed-${label}`
  const defaultValue = getJsonPath(slot, workflow)
  if (typeof defaultValue !== 'number') {
    throw new Error(`defaultValue of slot ${slot} is not a number`)
  }

  const QAppAutoSeed: React.FC<ExeAutoProps> = ({ ref, ...props }) => {
    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          const value = Math.floor(Math.random() * 0xffffffff)
          setJsonPath(slot, workflow, value)
        },
        validate: (workflow) => ''
      }),
      []
    )
    return null
  }

  QAppAutoSeed.displayName = id

  return QAppAutoSeed
}

export default buildExeAutoSeed
