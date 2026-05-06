import React, { useRef, useImperativeHandle, useState, useEffect } from 'react'
import { ExeInputBuilder, ExeInputProps } from './types'
import InputNumberRandom from '@renderer/components/inputs/InputNumberRandom'
import { useConfig } from '@renderer/hooks/useConfig'
import { getJsonPath, setJsonPath } from '@shared/utils/jsonPath'
import { IconButton, InputAdornment } from '@mui/material'
import { Lock, LockOpen } from '@mui/icons-material'
import { useQAppInputState } from '../../components/QAppContext'

const buildExeInputSeed: ExeInputBuilder<'InputSeed'> = (cfg, workflow) => {
  const { label, slot } = cfg
  const id = `QAppInputSeed-${label}`

  const defaultValue = getJsonPath(slot, workflow)
  if (typeof defaultValue !== 'number') {
    throw new Error(`defaultValue of slot ${slot} is not a number`)
  }

  const QAppInputSeed: React.FC<ExeInputProps> = ({ ref }) => {
    const { config, updateConfig } = useConfig()
    const [value, setValue] = useQAppInputState<number>(slot, defaultValue)

    // 种子锁定状态（默认解锁）
    const [isLocked, setIsLocked] = useState<boolean>(config?.seedLocked ?? false)
    const isLockedRef = useRef<boolean>(config?.seedLocked ?? false)
    const valueRef = useRef<number>(value)

    useEffect(() => {
      isLockedRef.current = isLocked
    }, [isLocked])

    useEffect(() => {
      valueRef.current = value
    }, [value])

    // 切换锁定状态
    const toggleLock = () => {
      const newLocked = !isLocked
      setIsLocked(newLocked)
      isLockedRef.current = newLocked
      updateConfig({ seedLocked: newLocked })
    }

    useImperativeHandle(
      ref,
      () => ({
        id,
        modifyWorkflow: (workflow) => {
          let finalSeed: number

          if (isLockedRef.current) {
            finalSeed = valueRef.current
          } else {
            finalSeed = Math.floor(Math.random() * 0xffffffff)
            valueRef.current = finalSeed
            setValue(finalSeed)
          }

          setJsonPath(slot, workflow, finalSeed)
        },
        validate: () => ''
      }),
      [setValue]
    )

    // 自定义的锁定按钮
    const lockButton = (
      <InputAdornment position="end">
        <IconButton onClick={toggleLock} edge="end">
          {isLocked ? <Lock /> : <LockOpen />}
        </IconButton>
      </InputAdornment>
    )

    return (
      <InputNumberRandom
        label={label}
        value={value}
        onChange={(v) => {
          valueRef.current = v
          setValue(v)
        }}
        placeholder={`${label}...`}
        randomFlag={-1}
        randomMax={0xffffffff}
        showRefreshButton={false}
        endAdornment={lockButton}
      />
    )
  }

  QAppInputSeed.displayName = id
  return QAppInputSeed
}

export default buildExeInputSeed
