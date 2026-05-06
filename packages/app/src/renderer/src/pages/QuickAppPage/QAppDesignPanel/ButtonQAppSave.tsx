import { Alert, Button, MenuItem, Paper, Select, Stack, Typography } from '@mui/material'
import { clearCachedQAppState, useQAppContext } from '../components/QAppContext'
import { useMessage } from '@renderer/hooks/useMessage'
import ModalLayout from '@renderer/components/ModalLayout'
import { useCallback, useEffect, useState } from 'react'
import InputText from '@renderer/components/inputs/InputText'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import { inferQAppCategory, normalizeQAppCategory, type QAppCategory } from '@shared/qApp/category'
import { getQAppCategoryOptions } from './qAppCategoryOptions'

type ButtonQAppSaveProps = {
  onSaveSuccess?: () => void
  initialKey?: string
  initialName?: string
  selectedCategory?: QAppCategory
  onSelectedCategoryChange?: (category: QAppCategory) => void
  showCategoryField?: boolean
}

const replaceQAppBaseName = (key: string, name: string): string => {
  const normalized = key.replace(/\\/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash >= 0 ? `${normalized.slice(0, lastSlash + 1)}${name}` : name
}

export const ButtonQAppSave = ({
  onSaveSuccess,
  initialKey,
  initialName,
  selectedCategory: selectedCategoryProp,
  onSelectedCategoryChange,
  showCategoryField = true
}: ButtonQAppSaveProps) => {
  const { t } = useTranslation()
  const { notifyError, notifyInfo } = useMessage()
  const { qAppCfg, workflow, currentQAppKey } = useQAppContext()
  const [open, setOpen] = useState<boolean>(false)
  const [inputName, setInputName] = useState<string>('')
  const [internalSelectedCategory, setInternalSelectedCategory] = useState<QAppCategory>('image')
  const isCategoryControlled = selectedCategoryProp !== undefined
  const selectedCategory = selectedCategoryProp ?? internalSelectedCategory

  const setSelectedCategory = useCallback(
    (category: QAppCategory) => {
      setInternalSelectedCategory(category)
      onSelectedCategoryChange?.(category)
    },
    [onSelectedCategoryChange]
  )

  useEffect(() => {
    if (!open || !qAppCfg || !workflow) {
      return
    }

    setInputName(initialName || '')
    if (isCategoryControlled) {
      return
    }

    const inferred = inferQAppCategory({
      key: initialKey ?? currentQAppKey,
      cfg: qAppCfg,
      workflow
    })
    setSelectedCategory(inferred)

    let cancelled = false
    if (!currentQAppKey) {
      return
    }

    void api()
      .svcQApp.getQAppCfg({ key: currentQAppKey })
      .then((res) => {
        const explicitCategory = normalizeQAppCategory(res.manifest?.category)
        if (!cancelled && explicitCategory) {
          setSelectedCategory(explicitCategory)
        }
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [
    open,
    qAppCfg,
    workflow,
    currentQAppKey,
    initialKey,
    initialName,
    isCategoryControlled,
    setSelectedCategory
  ])

  const categoryOptions = getQAppCategoryOptions(t)

  if (!workflow) {
    return null
  }

  const validate = () => {
    if (!qAppCfg || !workflow) {
      return t('qapp.design.save.error_config')
    }
    if (!inputName.trim()) {
      return t('qapp.design.save.error_name')
    }
    return ''
  }

  const handleSave = async () => {
    const errorText = validate()
    if (errorText) {
      notifyError(errorText)
      return
    }

    const saveKey = initialKey
      ? replaceQAppBaseName(initialKey, inputName.trim())
      : inputName.trim()
    await api().svcQApp.saveQAppCfg({
      key: saveKey,
      cfg: qAppCfg!,
      workflow: workflow!,
      manifest: {
        category: selectedCategory
      }
    })
    clearCachedQAppState(saveKey)

    notifyInfo(t('qapp.design.save.success'))
    onSaveSuccess?.()
    setOpen(false)
  }

  return (
    <>
      <Button
        variant="contained"
        onClick={() => setOpen(true)}
        sx={{
          width: '100%',
          height: '100%',
          fontSize: '1rem',
          bgcolor: '#8275fe',
          color: '#fff',
          boxShadow: 'none',
          '&:hover': {
            bgcolor: '#6b60d9',
            boxShadow: 'none'
          }
        }}
      >
        {t('qapp.design.save.button')}
      </Button>

      <ModalLayout
        buttonText=""
        open={open}
        setOpen={setOpen}
        width="30vw"
        height={showCategoryField ? '50vh' : '42vh'}
        maxWidth="700px"
        maxHeight="600px"
        // @ts-ignore: ModalLayout forwards sx at runtime even though its local type omits it.
        sx={{ display: 'none' }}
      >
        <Paper sx={{ p: 3, width: '100%', height: '100%' }}>
          <Stack spacing={3}>
            <Typography variant="h3">{t('qapp.design.save.title')}</Typography>
            <InputText
              label={t('qapp.design.save.label')}
              placeholder="App 1"
              value={inputName}
              onChange={(e) => setInputName(e)}
              errorText={validate() || undefined}
            />
            {showCategoryField && (
              <Stack spacing={1}>
                <Typography variant="body1" fontWeight={600}>
                  {t('qapp.design.save.category_label', { defaultValue: '快应用分类' })}
                </Typography>
                <Select<QAppCategory>
                  size="small"
                  value={selectedCategory}
                  onChange={(event) => setSelectedCategory(event.target.value as QAppCategory)}
                >
                  {categoryOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
              </Stack>
            )}
            <Alert severity="info">
              <Typography variant="body1">
                {t('qapp.design.save.info_line1')}
                <br />
                {t('qapp.design.save.info_line2')}
              </Typography>
            </Alert>

            <Button
              variant="contained"
              sx={{
                bgcolor: '#8275fe',
                color: '#fff',
                '&:hover': { bgcolor: '#6b60d9' }
              }}
              onClick={handleSave}
              disabled={!!validate()}
            >
              {t('qapp.design.save.button')}
            </Button>
          </Stack>
        </Paper>
      </ModalLayout>
    </>
  )
}
