import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputBase,
  Paper,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
  alpha
} from '@mui/material'
import {
  Add as AddIcon,
  DeleteOutline as DeleteOutlineIcon,
  DescriptionOutlined as DescriptionOutlinedIcon,
  ErrorOutline as ErrorOutlineIcon,
  FactCheckOutlined as FactCheckOutlinedIcon,
  FolderOpen as FolderOpenIcon,
  SaveOutlined as SaveOutlinedIcon,
  Search as SearchIcon
} from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import type { TargetScheme, TargetSchemeFile } from '@shared/targetScheme'
import { api } from '@renderer/utils/windowUtils'
import { useMessage } from '@renderer/hooks/useMessage'
import { getFileBadgeText } from '@renderer/utils/fileDisplay'
import CustomWorkshopTabs from './components/CustomWorkshopTabs'
import {
  TARGET_SCHEME_FILE_ACCEPT,
  getTargetSchemeFileSummary,
  importTargetSchemeFile,
  isTargetSchemeImageFile,
  listUnsupportedTargetSchemeFiles
} from './targetSchemeImportUtils'

const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

const workshopFieldSx = {
  '& .MuiInputBase-root': {
    color: 'text.primary'
  },
  '& .MuiInputBase-input, & .MuiInputBase-inputMultiline': {
    color: 'text.primary',
    WebkitTextFillColor: 'currentColor',
    caretColor: 'text.primary'
  }
} as const

const createSchemeId = (prefix: string): string =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

const cloneScheme = (scheme: TargetScheme): TargetScheme => ({
  ...scheme,
  files: scheme.files.map((file) => ({ ...file }))
})

const createEmptyScheme = (): TargetScheme => {
  const now = new Date().toISOString()
  return {
    id: createSchemeId('target'),
    name: '未命名目标方案',
    description: '',
    enabled: true,
    files: [],
    createdAt: now,
    updatedAt: now
  }
}

const inferLanguageFromFileName = (fileName: string, fallback?: string): string | undefined => {
  const ext = fileName.split('.').pop()?.toLowerCase() || ''
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'txt' || ext === 'pdf' || ext === 'docx') return 'text'
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 'image-reference'
  return fallback
}

const formatDateTime = (value?: string): string => {
  if (!value) return '-'
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString()
}

const normalizeDescriptionPreview = (value: string): string => value.replace(/\s+/g, ' ').trim()

const sortSchemes = (schemes: TargetScheme[]): TargetScheme[] =>
  [...schemes].sort((left, right) => {
    const leftTime = Date.parse(left.updatedAt || left.createdAt || '') || 0
    const rightTime = Date.parse(right.updatedAt || right.createdAt || '') || 0
    if (leftTime !== rightTime) return rightTime - leftTime
    return left.name.localeCompare(right.name)
  })

const SchemeCard: React.FC<{
  scheme: TargetScheme
  onClick: () => void
  onDelete: () => void
  emptyNameLabel: string
  enabledLabel: string
  disabledLabel: string
  filesLabel: string
  updatedAtPrefix: string
}> = ({
  scheme,
  onClick,
  onDelete,
  emptyNameLabel,
  enabledLabel,
  disabledLabel,
  filesLabel,
  updatedAtPrefix
}) => {
  const [hovered, setHovered] = useState(false)
  const description = normalizeDescriptionPreview(scheme.description)

  return (
    <Card
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      sx={(theme) => ({
        position: 'relative',
        width: '100%',
        height: 150,
        cursor: 'pointer',
        borderRadius: 3,
        overflow: 'hidden',
        background: hovered
          ? theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(0,0,0,0.04)'
          : theme.palette.background.paper,
        color: theme.palette.text.primary,
        border: `1px solid ${hovered ? theme.palette.text.secondary : theme.palette.divider}`,
        boxShadow: hovered
          ? 'none'
          : theme.palette.mode === 'dark'
            ? SIDE_SHADOW_DARK
            : SIDE_SHADOW_LIGHT,
        transition:
          'transform .2s ease, box-shadow .2s ease, background .2s ease, color .2s ease, border-color .2s ease',
        '&:hover': { transform: 'translateY(-6px)' }
      })}
    >
      <IconButton
        size="small"
        sx={{
          position: 'absolute',
          bottom: 8,
          left: 8,
          zIndex: 2,
          opacity: hovered ? 1 : 0,
          transition: 'all .2s ease',
          color: 'error.main',
          '&:hover': {
            bgcolor: 'error.main',
            color: '#fff'
          }
        }}
        onClick={(event) => {
          event.stopPropagation()
          onDelete()
        }}
      >
        <DeleteOutlineIcon sx={{ fontSize: 18 }} />
      </IconButton>

      <CardContent
        sx={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-start',
          gap: 0.25,
          p: 2,
          pb: 5
        }}
      >
        <Typography
          variant="subtitle1"
          sx={{
            fontWeight: 700,
            fontSize: 16,
            lineHeight: 1.3,
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            color: 'text.primary',
            flex: '0 1 auto'
          }}
          title={scheme.name || emptyNameLabel}
        >
          {scheme.name || emptyNameLabel}
        </Typography>

        <Stack direction="row" spacing={0.75} sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip
            size="small"
            label={scheme.enabled ? enabledLabel : disabledLabel}
            color={scheme.enabled ? 'success' : 'default'}
            sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
          />
          <Chip
            size="small"
            variant="outlined"
            label={`${scheme.files.length} ${filesLabel}`}
            sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
          />
        </Stack>

        <Typography
          variant="body2"
          color="text.secondary"
          sx={{
            display: 'none'
          }}
        >
          {description || '补充目标、规则说明和适用场景，让 Agent 更容易理解这套目标方案。'}
        </Typography>

        <Typography variant="caption" color="text.secondary" sx={{ mt: 'auto' }}>
          {`${updatedAtPrefix}${formatDateTime(scheme.updatedAt)}`}
        </Typography>
      </CardContent>

      <Box
        sx={{
          position: 'absolute',
          zIndex: 0,
          right: -4,
          bottom: -4,
          width: 72,
          height: 72,
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: (theme) => (theme.palette.mode === 'dark' ? 0.15 : 0.08),
          transformOrigin: 'right bottom',
          transition: 'transform 120ms ease, opacity 120ms ease',
          transform: hovered ? 'scale(1.15)' : 'scale(1)',
          ...(hovered && { opacity: 0.22 })
        }}
      >
        <FactCheckOutlinedIcon sx={{ fontSize: 64, color: 'text.primary' }} />
      </Box>
    </Card>
  )
}

const TargetManagerPage: React.FC = () => {
  const { notifySuccess, notifyWarning } = useMessage()
  const { i18n } = useTranslation()
  const isChineseUi = (i18n?.language || i18n?.resolvedLanguage || '').startsWith('zh')
  const text = useCallback(
    (zh: string, en: string): string => (isChineseUi ? zh : en),
    [isChineseUi]
  )

  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const [schemes, setSchemes] = useState<TargetScheme[]>([])
  const [selectedSchemeId, setSelectedSchemeId] = useState<string>('')
  const [draftScheme, setDraftScheme] = useState<TargetScheme | null>(null)
  const [activeFileId, setActiveFileId] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const selectedScheme = useMemo(
    () => schemes.find((scheme) => scheme.id === selectedSchemeId) || null,
    [schemes, selectedSchemeId]
  )

  const selectedFile = useMemo(
    () =>
      draftScheme?.files.find((file) => file.id === activeFileId) || draftScheme?.files[0] || null,
    [draftScheme, activeFileId]
  )

  const filteredSchemes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return schemes
    return schemes.filter((scheme) =>
      [scheme.name, scheme.description, ...scheme.files.map((file) => file.name)]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query))
    )
  }, [schemes, searchQuery])

  const schemeSections = useMemo(() => {
    const enabledSchemes = filteredSchemes.filter((scheme) => scheme.enabled)
    const disabledSchemes = filteredSchemes.filter((scheme) => !scheme.enabled)

    return [
      { key: 'enabled', title: text('已启用', 'Enabled'), schemes: enabledSchemes },
      { key: 'disabled', title: text('未启用', 'Disabled'), schemes: disabledSchemes }
    ].filter((section) => section.schemes.length > 0)
  }, [filteredSchemes, text])

  const dirty = useMemo(() => {
    if (!draftScheme) return false
    if (!selectedScheme || selectedScheme.id !== draftScheme.id) return true
    return JSON.stringify(draftScheme) !== JSON.stringify(selectedScheme)
  }, [draftScheme, selectedScheme])

  const supportedUploadTypesLabel = useMemo(
    () =>
      TARGET_SCHEME_FILE_ACCEPT.split(',')
        .map((extension) => extension.replace(/^\./, '').trim())
        .filter(Boolean)
        .join(', '),
    []
  )

  const filesHelpLabel = text('规则文件说明', 'Files help')
  const deleteFileLabel = text('删除文件', 'Delete file')
  const filesHelpTooltip = text(
    `目标方案会保存在当前项目的 targetSchemes 文件夹中，支持上传：${supportedUploadTypesLabel}。也支持不添加任何规则或参考文件，只填写方案说明直接运行目标。运行时，这些文件会和画布选区一起发送给当前 Agent 绑定的大模型。`,
    `Target schemes are stored in the current project's targetSchemes folder. Supported uploads: ${supportedUploadTypesLabel}. You can also run the target without any rule or reference files by using only the scheme description. During target runs, any attached files are sent together with the canvas selection to the model bound to the current Agent.`
  )

  const loadSchemes = useCallback(async () => {
    setLoading(true)
    try {
      const response = await api().svcTargetScheme.listTargetSchemes({})
      setSchemes(sortSchemes(response.schemes || []))
    } catch (error) {
      console.error('Failed to load target schemes:', error)
      notifyWarning(text('读取目标方案失败。', 'Failed to load target schemes.'))
    } finally {
      setLoading(false)
    }
  }, [notifyWarning, text])

  useEffect(() => {
    void loadSchemes()
  }, [loadSchemes])

  useEffect(() => {
    if (!draftScheme?.files.length) {
      setActiveFileId('')
      return
    }
    if (!draftScheme.files.some((file) => file.id === activeFileId)) {
      setActiveFileId(draftScheme.files[0]?.id || '')
    }
  }, [activeFileId, draftScheme])

  const updateDraftScheme = useCallback((updater: (current: TargetScheme) => TargetScheme) => {
    setDraftScheme((current) => {
      if (!current) return current
      return { ...updater(current), updatedAt: new Date().toISOString() }
    })
  }, [])

  const openSchemeEditor = useCallback((scheme: TargetScheme) => {
    setSelectedSchemeId(scheme.id)
    setDraftScheme(cloneScheme(scheme))
    setActiveFileId(scheme.files[0]?.id || '')
    setEditorOpen(true)
  }, [])

  const handleCreateScheme = useCallback(() => {
    const newScheme = createEmptyScheme()
    setSelectedSchemeId(newScheme.id)
    setDraftScheme(newScheme)
    setActiveFileId(newScheme.files[0]?.id || '')
    setEditorOpen(true)
  }, [])

  const handleCloseEditor = useCallback(() => {
    if (saving) return
    setEditorOpen(false)
    setDraftScheme(null)
    setActiveFileId('')
    if (!selectedScheme) {
      setSelectedSchemeId('')
    }
  }, [saving, selectedScheme])

  const handleSaveScheme = useCallback(async () => {
    if (!draftScheme) return

    const normalizedScheme: TargetScheme = {
      ...draftScheme,
      name: draftScheme.name.trim() || text('未命名目标方案', 'Untitled target scheme'),
      description: draftScheme.description.trim(),
      files: draftScheme.files.map((file) => {
        const name = file.name.trim() || 'untitled.txt'
        return {
          ...file,
          name,
          language: inferLanguageFromFileName(name, file.language)
        }
      }),
      updatedAt: new Date().toISOString()
    }

    setSaving(true)
    try {
      await api().svcTargetScheme.saveTargetScheme({ scheme: normalizedScheme })
      setSchemes((current) => {
        const nextSchemes = current.some((scheme) => scheme.id === normalizedScheme.id)
          ? current.map((scheme) => (scheme.id === normalizedScheme.id ? normalizedScheme : scheme))
          : [normalizedScheme, ...current]
        return sortSchemes(nextSchemes)
      })
      setSelectedSchemeId(normalizedScheme.id)
      setDraftScheme(cloneScheme(normalizedScheme))
      setActiveFileId(normalizedScheme.files[0]?.id || '')
      setEditorOpen(false)
      notifySuccess(
        text(
          `已保存目标方案：${normalizedScheme.name}`,
          `Saved target scheme: ${normalizedScheme.name}`
        )
      )
    } finally {
      setSaving(false)
    }
  }, [draftScheme, notifySuccess, text])

  const openDeleteDialogForScheme = useCallback((scheme: TargetScheme) => {
    setSelectedSchemeId(scheme.id)
    setDraftScheme(cloneScheme(scheme))
    setActiveFileId(scheme.files[0]?.id || '')
    setDeleteDialogOpen(true)
  }, [])

  const handleDeleteScheme = useCallback(async () => {
    if (!selectedScheme) return

    setSaving(true)
    try {
      await api().svcTargetScheme.deleteTargetScheme({ id: selectedScheme.id })
      setSchemes((current) => current.filter((scheme) => scheme.id !== selectedScheme.id))
      setDeleteDialogOpen(false)
      setEditorOpen(false)
      setDraftScheme(null)
      setActiveFileId('')
      setSelectedSchemeId('')
      notifySuccess(
        text(
          `已删除目标方案：${selectedScheme.name || '未命名目标方案'}`,
          `Deleted target scheme: ${selectedScheme.name || 'Untitled target scheme'}`
        )
      )
    } finally {
      setSaving(false)
    }
  }, [notifySuccess, selectedScheme, text])

  const handleImportFiles = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files || [])
      if (files.length === 0) return

      const unsupportedFiles = listUnsupportedTargetSchemeFiles(files)
      if (unsupportedFiles.length > 0) {
        notifyWarning(
          text(
            `以下文件类型暂不支持：${unsupportedFiles.map((file) => file.name).join('、')}`,
            `Unsupported files: ${unsupportedFiles.map((file) => file.name).join(', ')}`
          )
        )
      }

      const importableFiles = files.filter((file) =>
        unsupportedFiles.every((item) => item !== file)
      )
      const importedFiles: TargetSchemeFile[] = []

      for (const file of importableFiles) {
        try {
          importedFiles.push(await importTargetSchemeFile(file, createSchemeId))
        } catch (error) {
          console.error('Failed to import target scheme file:', error)
          notifyWarning(text(`无法导入文件 ${file.name}`, `Failed to import ${file.name}`))
        }
      }

      if (importedFiles.length > 0) {
        updateDraftScheme((current) => ({
          ...current,
          files: [...current.files, ...importedFiles]
        }))
        setActiveFileId(importedFiles[0]?.id || '')
        notifySuccess(
          text(
            `已导入 ${importedFiles.length} 个规则文件`,
            `Imported ${importedFiles.length} files`
          )
        )
      }

      event.target.value = ''
    },
    [notifySuccess, notifyWarning, text, updateDraftScheme]
  )

  const handleAddBlankFile = useCallback(() => {
    const newFile: TargetSchemeFile = {
      id: createSchemeId('target_file'),
      name: `rule-${(draftScheme?.files.length || 0) + 1}.md`,
      language: 'markdown',
      mimeType: 'text/markdown',
      content: ''
    }
    updateDraftScheme((current) => ({ ...current, files: [...current.files, newFile] }))
    setActiveFileId(newFile.id)
  }, [draftScheme?.files.length, updateDraftScheme])

  const handleDeleteFile = useCallback(
    (fileId: string) => {
      if (!draftScheme) return
      const nextFiles = draftScheme.files.filter((file) => file.id !== fileId)
      updateDraftScheme((current) => ({
        ...current,
        files: current.files.filter((file) => file.id !== fileId)
      }))
      if (selectedFile?.id === fileId || !nextFiles.some((file) => file.id === activeFileId)) {
        setActiveFileId(nextFiles[0]?.id || '')
      }
    },
    [activeFileId, draftScheme, selectedFile?.id, updateDraftScheme]
  )

  const emptyState = (
    <Paper
      elevation={0}
      sx={{
        minHeight: 360,
        borderRadius: 3,
        border: '1px dashed',
        borderColor: 'divider',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        p: 4,
        textAlign: 'center'
      }}
    >
      <Box sx={{ maxWidth: 420 }}>
        <FactCheckOutlinedIcon sx={{ fontSize: 56, color: 'text.secondary', mb: 1.5 }} />
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          {text('还没有目标方案', 'No target schemes yet')}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5, whiteSpace: 'pre-line' }}>
          {text(
            '先创建一个本地目标方案，补充规则文件后，就可以在画布里向 Agent 发起目标。',
            'Create a local target scheme first, then start target runs from Agent on the canvas.'
          )}
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreateScheme}>
          {text('创建目标方案', 'Create target scheme')}
        </Button>
      </Box>
    </Paper>
  )

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'background.default',
        overflow: 'hidden'
      }}
    >
      <CustomWorkshopTabs />

      <Box
        sx={{
          flex: 1,
          overflowX: 'hidden',
          overflowY: 'auto',
          px: { xs: 2, sm: 3 },
          pt: 4,
          pb: 3,
          scrollbarGutter: 'stable'
        }}
      >
        <Stack spacing={3} sx={{ maxWidth: 960, mx: 'auto' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box
              sx={(theme) => ({
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 0.75,
                borderRadius: 2,
                bgcolor: alpha(theme.palette.text.primary, 0.04),
                border: `1px solid ${theme.palette.divider}`,
                transition: 'border-color .2s',
                '&:focus-within': { borderColor: theme.palette.primary.main }
              })}
            >
              <SearchIcon sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
              <InputBase
                inputProps={{
                  'aria-label': text('搜索目标方案', 'Search target schemes')
                }}
                placeholder={text(
                  '搜索目标方案名称、描述或规则文件...',
                  'Search target schemes, descriptions, or files...'
                )}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                sx={{ flex: 1, fontSize: 14 }}
              />
            </Box>

            <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
              <Button
                variant="outlined"
                onClick={handleCreateScheme}
                sx={{
                  textTransform: 'none',
                  fontWeight: 600,
                  fontSize: 13,
                  borderRadius: 2,
                  borderColor: 'divider',
                  color: 'text.primary',
                  px: 1.5,
                  py: 0.75,
                  height: 38,
                  '&:hover': {
                    borderColor: 'text.secondary',
                    bgcolor: 'action.hover'
                  }
                }}
              >
                {text('新建目标方案', 'New target scheme')}
              </Button>
            </Stack>
          </Box>

          <Alert severity="info" sx={{ borderRadius: 2.5, display: 'none' }}>
            {text(
              `目标方案会保存在当前项目的 targetSchemes 文件夹中。支持上传：${supportedUploadTypesLabel}。`,
              `Target schemes are stored in the current project's targetSchemes folder. Supported uploads: ${supportedUploadTypesLabel}.`
            )}
          </Alert>

          {loading ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary" variant="body2">
                {text('正在读取目标方案...', 'Loading target schemes...')}
              </Typography>
            </Box>
          ) : schemeSections.length === 0 ? (
            searchQuery.trim() ? (
              <Box sx={{ textAlign: 'center', py: 8 }}>
                <Typography color="text.secondary" variant="body2">
                  {text('没有找到匹配的目标方案', 'No matching target schemes found')}
                </Typography>
              </Box>
            ) : (
              emptyState
            )
          ) : (
            schemeSections.map(({ key, title, schemes: sectionSchemes }) => (
              <Box key={key}>
                <Box
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 1.5,
                    mb: 1.5,
                    flexWrap: 'wrap'
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Typography variant="h6" sx={{ fontWeight: 700, color: 'text.primary' }}>
                      {title}
                    </Typography>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={sectionSchemes.length}
                      sx={{ height: 24, fontWeight: 700 }}
                    />
                  </Box>
                </Box>

                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                      xs: 'minmax(0, 1fr)',
                      sm: 'repeat(2, minmax(0, 1fr))',
                      md: 'repeat(3, minmax(0, 1fr))'
                    },
                    gap: 1.5
                  }}
                >
                  {sectionSchemes.map((scheme) => (
                    <SchemeCard
                      key={scheme.id}
                      scheme={scheme}
                      onClick={() => openSchemeEditor(scheme)}
                      onDelete={() => openDeleteDialogForScheme(scheme)}
                      emptyNameLabel={text('未命名目标方案', 'Untitled target scheme')}
                      enabledLabel={text('启用', 'Enabled')}
                      disabledLabel={text('停用', 'Disabled')}
                      filesLabel={text('个文件', 'files')}
                      updatedAtPrefix={text('更新于 ', 'Updated ')}
                    />
                  ))}
                </Box>
              </Box>
            ))
          )}
        </Stack>
      </Box>

      <Dialog
        open={editorOpen && !!draftScheme}
        onClose={handleCloseEditor}
        fullWidth
        maxWidth="md"
        PaperProps={{
          sx: {
            width: 'min(1080px, calc(100% - 64px))',
            maxHeight: 'calc(100% - 64px)'
          }
        }}
      >
        <DialogTitle sx={{ color: 'text.primary', px: 3, py: 2.5 }}>
          {draftScheme?.name.trim() || text('未命名目标方案', 'Untitled target scheme')}
        </DialogTitle>

        <DialogContent dividers sx={{ px: 3, py: 2.5 }}>
          {draftScheme ? (
            <Stack spacing={2.5} sx={{ pt: 1, width: '100%', maxWidth: 1000, mx: 'auto' }}>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) 220px' },
                  gap: 2
                }}
              >
                <TextField
                  label={text('方案名称', 'Scheme name')}
                  value={draftScheme.name}
                  onChange={(event) =>
                    updateDraftScheme((current) => ({ ...current, name: event.target.value }))
                  }
                  fullWidth
                  sx={workshopFieldSx}
                />

                <Paper
                  elevation={0}
                  sx={{
                    p: 1.5,
                    borderRadius: 2.5,
                    border: '1px solid',
                    borderColor: 'divider',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                  }}
                >
                  <Box>
                    <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                      {text('启用状态', 'Enabled')}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {text(
                        '停用后不会出现在 Agent 的目标方案列表里。',
                        'Disabled schemes will not appear in the Agent target list.'
                      )}
                    </Typography>
                  </Box>
                  <Switch
                    checked={draftScheme.enabled}
                    onChange={(event) =>
                      updateDraftScheme((current) => ({
                        ...current,
                        enabled: event.target.checked
                      }))
                    }
                  />
                </Paper>
              </Box>

              <TextField
                label={text('方案说明', 'Description')}
                value={draftScheme.description}
                onChange={(event) =>
                  updateDraftScheme((current) => ({ ...current, description: event.target.value }))
                }
                multiline
                minRows={4}
                fullWidth
                sx={workshopFieldSx}
              />

              <Alert severity="info" sx={{ borderRadius: 2.5, display: 'none' }}>
                {text(
                  `目标方案会保存在当前项目的 targetSchemes 文件夹中，支持上传：${supportedUploadTypesLabel}。规则文件建议使用自然语言或结构化文本描述。目标执行时，这些文件会和画布选区一起发送给当前 Agent 绑定的大模型。`,
                  `Target schemes are stored in the current project's targetSchemes folder. Supported uploads: ${supportedUploadTypesLabel}. Describe the rules in natural language or structured text. During target runs, these files are sent together with the canvas selection to the model bound to the current Agent.`
                )}
              </Alert>

              <Alert severity="info" sx={{ borderRadius: 2.5, display: 'none' }}>
                {text(
                  '规则文件建议使用自然语言或结构化文本描述。目标执行时，这些文件会和画布选区一起发送给当前 Agent 绑定的大模型。',
                  'Describe the rules in natural language or structured text. During target runs, these files are sent together with the canvas selection to the model bound to the current Agent.'
                )}
              </Alert>

              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', md: '300px minmax(0, 1fr)' },
                  gap: 2
                }}
              >
                <Paper
                  elevation={0}
                  sx={{
                    borderRadius: 3,
                    border: '1px solid',
                    borderColor: 'divider',
                    minHeight: 320
                  }}
                >
                  <Box
                    sx={{
                      px: 2,
                      py: 1.5,
                      borderBottom: '1px solid',
                      borderColor: 'divider',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 1,
                      flexWrap: 'wrap'
                    }}
                  >
                    <Box>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                          {text('规则文件', 'Files')}
                        </Typography>
                        <Tooltip title={filesHelpTooltip} placement="top" arrow>
                          <IconButton
                            size="small"
                            aria-label={filesHelpLabel}
                            data-testid="target-files-help-button"
                            sx={(theme) => ({
                              width: 24,
                              height: 24,
                              borderRadius: 1.25,
                              border: '1px solid',
                              borderColor: theme.palette.divider,
                              color: theme.palette.info.main,
                              '&:hover': {
                                borderColor: theme.palette.info.main,
                                bgcolor: alpha(
                                  theme.palette.info.main,
                                  theme.palette.mode === 'dark' ? 0.16 : 0.1
                                )
                              }
                            })}
                          >
                            <ErrorOutlineIcon sx={{ fontSize: 16 }} />
                          </IconButton>
                        </Tooltip>
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {draftScheme.files.length > 0
                          ? text(
                              `当前共 ${draftScheme.files.length} 个文件`,
                              `${draftScheme.files.length} files`
                            )
                          : text('当前未添加文件，可选', 'No files yet (optional)')}
                      </Typography>
                    </Box>

                    <Stack
                      direction="row"
                      spacing={0.75}
                      sx={{ flexWrap: 'nowrap', flexShrink: 0 }}
                    >
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<DescriptionOutlinedIcon />}
                        onClick={handleAddBlankFile}
                        sx={{
                          minWidth: 'auto',
                          px: 1.25,
                          py: 0.5,
                          fontSize: 13,
                          whiteSpace: 'nowrap',
                          '& .MuiButton-startIcon': {
                            mr: 0.5,
                            ml: 0,
                            '& svg': { fontSize: 16 }
                          }
                        }}
                      >
                        {text('新建空白文件', 'New blank file')}
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<FolderOpenIcon />}
                        onClick={() => fileInputRef.current?.click()}
                        sx={{
                          minWidth: 'auto',
                          px: 1.25,
                          py: 0.5,
                          fontSize: 13,
                          whiteSpace: 'nowrap',
                          '& .MuiButton-startIcon': {
                            mr: 0.5,
                            ml: 0,
                            '& svg': { fontSize: 16 }
                          }
                        }}
                      >
                        {text('导入本地文件', 'Import local files')}
                      </Button>
                    </Stack>
                  </Box>

                  <input
                    ref={fileInputRef}
                    type="file"
                    hidden
                    multiple
                    accept={TARGET_SCHEME_FILE_ACCEPT}
                    onChange={(event) => void handleImportFiles(event)}
                  />

                  <Box
                    sx={{
                      p: 1.5,
                      display: 'grid',
                      gap: 1,
                      maxHeight: 360,
                      overflowY: 'auto',
                      overflowX: 'hidden'
                    }}
                  >
                    {draftScheme.files.length === 0 ? (
                      <Paper
                        variant="outlined"
                        data-testid="target-files-empty-state"
                        sx={{
                          p: 2,
                          borderRadius: 2.5,
                          borderStyle: 'dashed',
                          bgcolor: 'transparent'
                        }}
                      >
                        <Stack spacing={0.75}>
                          <Typography sx={{ fontWeight: 700 }}>
                            {text('当前还没有规则或参考文件', 'No rule or reference files yet')}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {text(
                              '支持只填写方案说明直接运行目标；如果需要，也可以稍后再新建或导入文件。',
                              'You can run the target with the scheme description alone, or add/import files later.'
                            )}
                          </Typography>
                        </Stack>
                      </Paper>
                    ) : null}

                    {draftScheme.files.map((file) => {
                      const selected = file.id === selectedFile?.id
                      return (
                        <Paper
                          key={file.id}
                          variant="outlined"
                          onClick={() => setActiveFileId(file.id)}
                          sx={(theme) => ({
                            p: 1.5,
                            borderRadius: 2.5,
                            cursor: 'pointer',
                            borderColor: selected ? 'primary.main' : 'divider',
                            backgroundColor: selected
                              ? alpha(
                                  theme.palette.primary.main,
                                  theme.palette.mode === 'dark' ? 0.18 : 0.08
                                )
                              : theme.palette.background.paper
                          })}
                        >
                          <Box
                            sx={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              justifyContent: 'space-between',
                              gap: 1
                            }}
                          >
                            <Box sx={{ minWidth: 0, flex: 1 }}>
                              <Typography
                                data-testid={`target-file-name-${file.id}`}
                                sx={{
                                  fontWeight: 700,
                                  lineHeight: 1.35,
                                  whiteSpace: 'normal',
                                  overflowWrap: 'anywhere',
                                  wordBreak: 'break-word',
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden'
                                }}
                              >
                                {file.name}
                              </Typography>
                              <Typography
                                variant="body2"
                                color="text.secondary"
                                sx={{
                                  mt: 0.25,
                                  whiteSpace: 'normal',
                                  overflowWrap: 'anywhere',
                                  wordBreak: 'break-word'
                                }}
                              >
                                {getTargetSchemeFileSummary(file)}
                              </Typography>
                            </Box>

                            <Tooltip title={deleteFileLabel}>
                              <IconButton
                                size="small"
                                aria-label={deleteFileLabel}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleDeleteFile(file.id)
                                }}
                                sx={{ flexShrink: 0, mt: -0.25 }}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </Paper>
                      )
                    })}
                  </Box>
                </Paper>

                <Paper
                  elevation={0}
                  sx={{
                    borderRadius: 3,
                    border: '1px solid',
                    borderColor: 'divider',
                    minHeight: 320,
                    display: 'flex',
                    flexDirection: 'column'
                  }}
                >
                  <Box sx={{ px: 2, py: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                      {selectedFile?.name ||
                        text('规则/参考文件详情', 'Rule/reference file details')}
                    </Typography>
                    {selectedFile ? (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {getTargetSchemeFileSummary(selectedFile)}
                      </Typography>
                    ) : (
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                        {text(
                          '支持不添加任何文件，直接通过方案说明运行目标。',
                          'Files are optional for this target scheme.'
                        )}
                      </Typography>
                    )}
                  </Box>

                  {selectedFile ? (
                    <Stack spacing={2} sx={{ p: 2, flex: 1 }}>
                      <TextField
                        label={text('文件名', 'File name')}
                        value={selectedFile.name}
                        onChange={(event) => {
                          const value = event.target.value
                          updateDraftScheme((current) => ({
                            ...current,
                            files: current.files.map((file) =>
                              file.id === selectedFile.id
                                ? {
                                    ...file,
                                    name: value,
                                    language: inferLanguageFromFileName(value, file.language)
                                  }
                                : file
                            )
                          }))
                        }}
                        sx={workshopFieldSx}
                      />

                      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap' }}>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={getFileBadgeText(selectedFile.name)}
                        />
                        {selectedFile.language ? (
                          <Chip size="small" variant="outlined" label={selectedFile.language} />
                        ) : null}
                        {isTargetSchemeImageFile(selectedFile) ? (
                          <Chip
                            size="small"
                            color="info"
                            label={text(
                              '目标执行时作为图片参考',
                              'Sent as image reference during target'
                            )}
                          />
                        ) : null}
                      </Stack>

                      {isTargetSchemeImageFile(selectedFile) ? (
                        <Box
                          component="img"
                          src={selectedFile.attachmentUrl}
                          alt={selectedFile.name}
                          sx={{
                            width: '100%',
                            maxHeight: 320,
                            objectFit: 'contain',
                            borderRadius: 2,
                            border: '1px solid',
                            borderColor: 'divider',
                            bgcolor: 'rgba(15,23,42,0.35)'
                          }}
                        />
                      ) : null}

                      <TextField
                        label={
                          isTargetSchemeImageFile(selectedFile)
                            ? text('补充说明', 'Notes')
                            : text('文件内容', 'Content')
                        }
                        value={selectedFile.content || ''}
                        onChange={(event) => {
                          const value = event.target.value
                          updateDraftScheme((current) => ({
                            ...current,
                            files: current.files.map((file) =>
                              file.id === selectedFile.id ? { ...file, content: value } : file
                            )
                          }))
                        }}
                        helperText={
                          isTargetSchemeImageFile(selectedFile)
                            ? text(
                                '可以补充这张参考图里希望模型重点关注的目标要求。',
                                'Add any extra notes about what the model should focus on for this target reference image.'
                              )
                            : selectedFile.mimeType === 'application/pdf'
                              ? text(
                                  'PDF 会尽量提取可读文本；如果提取不完整，可以在这里补充摘要。',
                                  'PDF text is extracted when possible. Add a summary here if needed.'
                                )
                              : selectedFile.mimeType ===
                                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                                ? text(
                                    'DOCX 会优先导入提取到的正文内容，你也可以继续补充说明。',
                                    'DOCX content is imported when possible, and you can add more notes here.'
                                  )
                                : undefined
                        }
                        multiline
                        minRows={16}
                        fullWidth
                        sx={{ ...workshopFieldSx, flex: 1 }}
                      />
                    </Stack>
                  ) : (
                    <Box
                      data-testid="target-file-detail-empty-state"
                      sx={{
                        flex: 1,
                        p: 2,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                      }}
                    >
                      <Paper
                        variant="outlined"
                        sx={{
                          width: '100%',
                          minHeight: 280,
                          borderRadius: 2.5,
                          borderStyle: 'dashed',
                          bgcolor: 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          p: 3
                        }}
                      >
                        <Stack
                          spacing={1.25}
                          sx={{ maxWidth: 360, textAlign: 'center', alignItems: 'center' }}
                        >
                          <DescriptionOutlinedIcon sx={{ fontSize: 40, color: 'text.secondary' }} />
                          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                            {text('当前未选择规则或参考文件', 'No rule or reference file selected')}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {text(
                              '支持只填写方案说明直接运行目标；如果之后需要补充，再新建或导入文件即可。',
                              'You can run the target with the scheme description alone, and add or import files later if you need more context.'
                            )}
                          </Typography>
                          <Button
                            size="small"
                            variant="outlined"
                            startIcon={<DescriptionOutlinedIcon />}
                            onClick={handleAddBlankFile}
                          >
                            {text('新建空白文件', 'New blank file')}
                          </Button>
                        </Stack>
                      </Paper>
                    </Box>
                  )}
                </Paper>
              </Box>
            </Stack>
          ) : null}
        </DialogContent>

        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={handleCloseEditor}>{text('取消', 'Cancel')}</Button>
          {selectedScheme ? (
            <Button
              color="error"
              onClick={() => setDeleteDialogOpen(true)}
              disabled={saving}
              startIcon={<DeleteOutlineIcon />}
            >
              {text('删除', 'Delete')}
            </Button>
          ) : null}
          <Button
            variant="contained"
            startIcon={<SaveOutlinedIcon />}
            disabled={!dirty || saving}
            onClick={() => void handleSaveScheme()}
          >
            {text('保存', 'Save')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>{text('删除目标方案', 'Delete target scheme')}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary">
            {text(
              '该操作会删除方案文件及其规则内容，且不可恢复。确定继续吗？',
              'This removes the scheme and its rule files permanently. Continue?'
            )}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)}>{text('取消', 'Cancel')}</Button>
          <Button color="error" variant="contained" onClick={() => void handleDeleteScheme()}>
            {text('删除', 'Delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default TargetManagerPage
