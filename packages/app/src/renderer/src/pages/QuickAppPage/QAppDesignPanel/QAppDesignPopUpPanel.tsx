import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
  Divider,
  IconButton,
  CircularProgress,
  FormControl,
  InputLabel,
  MenuItem,
  Select
} from '@mui/material'
import { DragDropContext, Draggable, Droppable, DropResult } from '@hello-pangea/dnd'
import { useTranslation } from 'react-i18next'
import { CalloutNodeNotInstalled } from '../components/CalloutNodeNotInstalled'
import { CalloutComfyAPINotAvailable } from '../components/CalloutComfyAPINotAvailable'
import DsnIcon from './qAppDesignInputs/DsnIcon'
import DsnCustomNodeUrls from './qAppDesignInputs/DsnCustomNodeUrls'
import DsnRequiredModels from './qAppDesignInputs/DsnRequiredModels'
import { ButtonAddAutoItem } from './ButtonAddAutoItem'
import { ButtonAddInputItem } from './ButtonAddInputItem'
import DsnOutput from './qAppDesignInputs/DsnOutput'
import { qAppDesignAutoMap, qAppDesignInputMap, qAppDesignMetaMap } from './qAppDesignInputs'
import { QAppDesignComponent } from './qAppDesignInputs/types'
import {
  QAppCfgAutoType,
  QAppCfgInputType,
  QAppCfgAllComponentType,
  QAppCfgAllComponentTypeMap,
  QAppCfgAutoTypeMap
} from '@shared/qApp/cfgTypes'
import { Workflow, ObjectInfoMap } from '@shared/comfy/types'
import { Config } from '@shared/config/config'
import { BuildEnv } from '@shared/config/buildEnv'
import { ButtonQAppSave } from './ButtonQAppSave'
import { useState, useRef, useEffect } from 'react'
import QAppPanel from '../QAppExecutePanel/QAppInputPanel'
import ResultSection from '../ResultList/ResultSection'
import { Visibility, VisibilityOff, Close } from '@mui/icons-material'
import type { QAppCategory } from '@shared/qApp/category'
import { getQAppCategoryOptions } from './qAppCategoryOptions'

export type DesignItem<CompType extends QAppCfgAllComponentType> = {
  id: string
  component: CompType
  value: QAppCfgAllComponentTypeMap[CompType] | null
  setValue: (value: QAppCfgAllComponentTypeMap[CompType]) => void
  onDelete: () => void
}

const reorderList = <T,>(list: T[], startIndex: number, endIndex: number): T[] => {
  const next = [...list]
  const [removed] = next.splice(startIndex, 1)
  next.splice(endIndex, 0, removed)
  return next
}

import { useQAppDesignState } from './useQAppDesignState'

type InputCompValue = QAppCfgAllComponentTypeMap[QAppCfgInputType | 'Section' | 'Description']
type AutoCompValue = QAppCfgAutoTypeMap[QAppCfgAutoType]

type QAppDesignPopUpPanelProps = {
  open: boolean
  onClose: () => void
  workflow: Workflow
  objectInfos: ObjectInfoMap
  config: Config
  buildEnv: BuildEnv
  initialKey?: string
  initialName?: string
  selectedCategory: QAppCategory
  onSelectedCategoryChange: (category: QAppCategory) => void
} & ReturnType<typeof useQAppDesignState>

const DROPPABLE_AUTO = 'design-auto-items'
const DROPPABLE_INPUT = 'design-input-items'

const getQAppGroupName = (key?: string): string => {
  if (!key) return ''

  const parts = key.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join(' / ') : ''
}

export const QAppDesignPopUpPanel = ({
  open,
  onClose,
  workflow,
  objectInfos,
  config,
  buildEnv,
  initialKey,
  initialName,
  selectedCategory,
  onSelectedCategoryChange,
  icon,
  setIcon,
  customNodeUrls,
  setCustomNodeUrls,
  isCustomNodeUrlsEnabled,
  setIsCustomNodeUrlsEnabled,
  requiredModels,
  setRequiredModels,
  isRequiredModelsEnabled,
  setIsRequiredModelsEnabled,
  autoItems,
  setAutoItems,
  inputItems,
  setInputItems,
  outputNodeIds,
  setOutputNodeIds,
  isSpecifyOutput,
  setIsSpecifyOutput,
  handleSetAutoItemValue,
  handleDeleteAutoItem,
  handleSetInputItemValue,
  handleDeleteInputItem
}: QAppDesignPopUpPanelProps) => {
  const { t } = useTranslation()
  const [showPreview, setShowPreview] = useState(false)
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false)
  const categoryOptions = getQAppCategoryOptions(t)
  const qAppName = initialName || t('qapp.design.untitled_qapp', { defaultValue: '未命名快应用' })
  const qAppGroupName = getQAppGroupName(initialKey)
  const title = qAppGroupName ? `${qAppGroupName} / ${qAppName}` : qAppName

  // 记录打开时的初始状态快照，用于检测是否有未保存的更改
  const initialSnapshot = useRef<string>('')

  // 生成当前状态的快照字符串
  const getCurrentSnapshot = (): string => {
    return JSON.stringify({
      icon,
      customNodeUrls,
      isCustomNodeUrlsEnabled,
      requiredModels,
      isRequiredModelsEnabled,
      autoItems: autoItems.map((i) => ({ id: i.id, component: i.component, value: i.value })),
      inputItems: inputItems.map((i) => ({ id: i.id, component: i.component, value: i.value })),
      outputNodeIds,
      isSpecifyOutput,
      selectedCategory
    })
  }

  // 当 dialog 打开时，延迟记录初始快照（等待所有状态完全就绪）
  // 使用 useEffect 确保在 render 之后捕获，而非 render 期间
  const snapshotReady = useRef(false)
  useEffect(() => {
    if (open && !snapshotReady.current) {
      // 使用 requestAnimationFrame 确保父组件的 useEffect 也执行完毕
      const rafId = requestAnimationFrame(() => {
        initialSnapshot.current = getCurrentSnapshot()
        snapshotReady.current = true
      })
      return () => cancelAnimationFrame(rafId)
    }
    if (!open) {
      snapshotReady.current = false
      initialSnapshot.current = ''
    }
    return undefined
  })

  const hasUnsavedChanges = (): boolean => {
    return getCurrentSnapshot() !== initialSnapshot.current
  }

  const handleAttemptClose = () => {
    if (hasUnsavedChanges()) {
      setShowDiscardConfirm(true)
    } else {
      onClose()
    }
  }

  const handleConfirmDiscard = () => {
    setShowDiscardConfirm(false)
    onClose()
  }

  const handleDragEnd = (result: DropResult) => {
    const { destination, source } = result
    if (!destination) return
    if (destination.droppableId === source.droppableId && destination.index === source.index) return

    if (source.droppableId === DROPPABLE_INPUT && destination.droppableId === DROPPABLE_INPUT) {
      setInputItems((prev) => reorderList(prev, source.index, destination.index))
      return
    }
    if (source.droppableId === DROPPABLE_AUTO && destination.droppableId === DROPPABLE_AUTO) {
      setAutoItems((prev) => reorderList(prev, source.index, destination.index))
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={(_event, reason) => {
          // 点击背景或按 Escape 时，检查是否有未保存的更改
          if (reason === 'backdropClick' || reason === 'escapeKeyDown') {
            handleAttemptClose()
            return
          }
          onClose()
        }}
        maxWidth={showPreview ? 'xl' : 'md'}
        fullWidth
        scroll="paper"
        PaperProps={{
          sx: {
            height: '90vh',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            transition: 'max-width 0.3s ease'
          }
        }}
      >
        <DialogTitle
          sx={{
            flexShrink: 0,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 2,
            borderBottom: 1,
            borderColor: 'divider'
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="subtitle1" fontWeight={600} noWrap>
              {title}
            </Typography>
          </Box>
          <IconButton onClick={handleAttemptClose} size="small">
            <Close />
          </IconButton>
        </DialogTitle>

        <DialogContent
          sx={{
            p: 0,
            display: 'flex',
            flexDirection: 'row',
            overflow: 'hidden', // 基础隐藏
            flex: 1,
            // 强制覆盖 Material UI 默认样式
            '&.MuiDialogContent-root': {
              overflowY: 'hidden',
              padding: 0
            }
          }}
        >
          {/* === 左侧：设计区域 === */}
          <Box sx={{ flex: 1, overflowY: 'auto', p: 3, height: '100%' }}>
            <DragDropContext onDragEnd={handleDragEnd}>
              <Stack spacing={3}>
                <CalloutNodeNotInstalled workflow={workflow} objectInfos={objectInfos} />
                <CalloutComfyAPINotAvailable isDesignMode={true} objectInfos={objectInfos} />

                <Typography variant="h6">
                  {t('qapp.design.set_app_icon') || '设置应用图标'}
                </Typography>
                <DsnIcon value={icon} setValue={setIcon} />

                <Typography variant="h6">{t('qapp.design.set_custom_node_urls')}</Typography>
                <DsnCustomNodeUrls
                  value={customNodeUrls}
                  setValue={setCustomNodeUrls}
                  enabled={isCustomNodeUrlsEnabled}
                  setEnabled={setIsCustomNodeUrlsEnabled}
                />

                <Typography variant="h6">所需模型</Typography>
                <DsnRequiredModels
                  value={requiredModels}
                  setValue={setRequiredModels}
                  enabled={isRequiredModelsEnabled}
                  setEnabled={setIsRequiredModelsEnabled}
                />

                <Typography variant="h6">{t('qapp.design.set_auto_inputs')}</Typography>
                <Droppable droppableId={DROPPABLE_AUTO} direction="vertical">
                  {(provided) => (
                    <Stack spacing={2} ref={provided.innerRef} {...provided.droppableProps}>
                      {autoItems.map((designItem, index) => {
                        const Component = qAppDesignAutoMap[
                          designItem.component
                        ] as QAppDesignComponent<QAppCfgAutoType>
                        return (
                          <Draggable key={designItem.id} draggableId={designItem.id} index={index}>
                            {(dragProvided, snapshot) => (
                              <Box
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                                sx={{
                                  cursor: snapshot.isDragging ? 'grabbing' : 'grab',
                                  transition: 'box-shadow 0.2s ease',
                                  boxShadow: snapshot.isDragging ? 6 : 'none',
                                  bgcolor: 'background.paper',
                                  borderRadius: 1,
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  p: 1
                                }}
                              >
                                <Component
                                  id={designItem.id}
                                  workflow={workflow}
                                  objectInfos={objectInfos}
                                  config={config}
                                  buildEnv={buildEnv}
                                  value={designItem.value}
                                  setValue={designItem.setValue}
                                  onDelete={designItem.onDelete}
                                />
                              </Box>
                            )}
                          </Draggable>
                        )
                      })}
                      {provided.placeholder}
                    </Stack>
                  )}
                </Droppable>
                <ButtonAddAutoItem
                  addAutoItem={(component) => {
                    const id = crypto.randomUUID()
                    setAutoItems((prev) => [
                      ...prev,
                      {
                        id,
                        component,
                        value: null,
                        setValue: (value) => handleSetAutoItemValue(id, value),
                        onDelete: () => handleDeleteAutoItem(id)
                      }
                    ])
                  }}
                />

                <Typography variant="h6">{t('qapp.design.set_inputs')}</Typography>
                <Droppable droppableId={DROPPABLE_INPUT} direction="vertical">
                  {(provided) => (
                    <Stack spacing={2} ref={provided.innerRef} {...provided.droppableProps}>
                      {inputItems.map((designItem, index) => {
                        const renderComponent = () => {
                          if (
                            designItem.component === 'Section' ||
                            designItem.component === 'Description'
                          ) {
                            const Component = qAppDesignMetaMap[
                              designItem.component
                            ] as QAppDesignComponent<typeof designItem.component>
                            return (
                              <Component
                                id={designItem.id}
                                workflow={workflow}
                                objectInfos={objectInfos}
                                config={config}
                                buildEnv={buildEnv}
                                value={
                                  designItem.value as QAppCfgAllComponentTypeMap[
                                    | 'Section'
                                    | 'Description']
                                }
                                setValue={designItem.setValue}
                                onDelete={designItem.onDelete}
                              />
                            )
                          }
                          const Component = qAppDesignInputMap[
                            designItem.component as keyof typeof qAppDesignInputMap
                          ] as QAppDesignComponent<typeof designItem.component> | undefined
                          if (!Component) {
                            console.error(`未知的输入组件类型: ${designItem.component}`)
                            return (
                              <Typography color="error">
                                未知的输入组件类型: {designItem.component}
                              </Typography>
                            )
                          }
                          return (
                            <Component
                              id={designItem.id}
                              workflow={workflow}
                              objectInfos={objectInfos}
                              config={config}
                              buildEnv={buildEnv}
                              value={
                                designItem.value as QAppCfgAllComponentTypeMap[QAppCfgInputType]
                              }
                              setValue={designItem.setValue}
                              onDelete={designItem.onDelete}
                            />
                          )
                        }

                        return (
                          <Draggable key={designItem.id} draggableId={designItem.id} index={index}>
                            {(dragProvided, snapshot) => (
                              <Box
                                ref={dragProvided.innerRef}
                                {...dragProvided.draggableProps}
                                {...dragProvided.dragHandleProps}
                                sx={{
                                  cursor: snapshot.isDragging ? 'grabbing' : 'grab',
                                  transition: 'box-shadow 0.2s ease',
                                  boxShadow: snapshot.isDragging ? 6 : 'none',
                                  bgcolor: 'background.paper',
                                  borderRadius: 1,
                                  border: '1px solid',
                                  borderColor: 'divider',
                                  p: 1
                                }}
                              >
                                {renderComponent()}
                              </Box>
                            )}
                          </Draggable>
                        )
                      })}
                      {provided.placeholder}
                    </Stack>
                  )}
                </Droppable>
                <ButtonAddInputItem
                  addInputItem={(component) => {
                    const id = crypto.randomUUID()
                    setInputItems((prev) => [
                      ...prev,
                      {
                        id,
                        component,
                        value: null,
                        setValue: (value) => handleSetInputItemValue(id, value),
                        onDelete: () => handleDeleteInputItem(id)
                      }
                    ])
                  }}
                />

                <Typography variant="h6">{t('qapp.design.set_output_node_ids')}</Typography>
                <DsnOutput
                  workflow={workflow}
                  objectInfos={objectInfos}
                  value={outputNodeIds}
                  setValue={setOutputNodeIds}
                  enabled={isSpecifyOutput}
                  setEnabled={setIsSpecifyOutput}
                />
              </Stack>
            </DragDropContext>
          </Box>

          {/* === 右侧：预览区域 === */}
          {showPreview && (
            <>
              <Divider orientation="vertical" flexItem />
              <Box
                sx={{
                  width: '400px',
                  minWidth: '400px',
                  bgcolor: '#f5f5f5',
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }}
              >
                <Box
                  sx={{
                    p: 2,
                    borderBottom: 1,
                    borderColor: 'divider',
                    bgcolor: 'background.paper'
                  }}
                >
                  <Typography variant="subtitle1" fontWeight="bold">
                    {t('预览')}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    flex: 1,
                    overflowY: 'auto',
                    p: 2,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2
                  }}
                >
                  <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, p: 2, boxShadow: 1 }}>
                    <QAppPanel fallback={<CircularProgress />} isDesignMode={true} />
                  </Box>

                  <Box sx={{ bgcolor: 'background.paper', borderRadius: 2, p: 2, boxShadow: 1 }}>
                    <ResultSection isDesignMode={true} />
                  </Box>
                </Box>
              </Box>
            </>
          )}
        </DialogContent>

        {/* 底部按钮区域：增加 minHeight 和 Padding */}
        <DialogActions
          sx={{
            // ★★★ 修改：调高底部高度 ★★★
            minHeight: '100px',
            p: 3, // 增加内边距
            justifyContent: 'center',
            borderTop: 1,
            borderColor: 'divider',
            flexShrink: 0,
            bgcolor: 'background.paper'
          }}
        >
          <Stack direction="row" spacing={2} alignItems="center">
            <FormControl size="small" sx={{ width: 180 }}>
              <InputLabel id="qapp-design-category-label">
                {t('qapp.design.save.category_label', { defaultValue: '快应用分类' })}
              </InputLabel>
              <Select<QAppCategory>
                labelId="qapp-design-category-label"
                label={t('qapp.design.save.category_label', { defaultValue: '快应用分类' })}
                value={selectedCategory}
                onChange={(event) => onSelectedCategoryChange(event.target.value as QAppCategory)}
              >
                {categoryOptions.map((option) => (
                  <MenuItem key={option.value} value={option.value}>
                    {option.label}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {/* 1. 保存按钮 */}
            <Box sx={{ width: '150px', height: '48px' }}>
              <ButtonQAppSave
                initialKey={initialKey}
                initialName={initialName}
                selectedCategory={selectedCategory}
                onSelectedCategoryChange={onSelectedCategoryChange}
                showCategoryField={false}
                onSaveSuccess={() => {
                  initialSnapshot.current = getCurrentSnapshot()
                  onClose()
                }}
              />
            </Box>

            {/* 2. 预览按钮 */}
            <Button
              variant={showPreview ? 'contained' : 'outlined'}
              color="secondary"
              onClick={() => setShowPreview(!showPreview)}
              startIcon={showPreview ? <VisibilityOff /> : <Visibility />}
              sx={{ width: '150px', height: '48px' }}
            >
              {showPreview ? t('关闭预览') : t('预览')}
            </Button>
          </Stack>
        </DialogActions>
      </Dialog>

      {/* 未保存更改确认对话框 */}
      <Dialog
        open={showDiscardConfirm}
        onClose={() => setShowDiscardConfirm(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{t('未保存的更改')}</DialogTitle>
        <DialogContent>
          <Typography>{t('当前有未保存的更改，确定要放弃吗？')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setShowDiscardConfirm(false)}>{t('继续编辑')}</Button>
          <Button onClick={handleConfirmDiscard} color="error" variant="contained">
            {t('放弃更改')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  )
}
