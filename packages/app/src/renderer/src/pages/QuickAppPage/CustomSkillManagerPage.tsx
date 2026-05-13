import React, { useCallback, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  InputBase,
  Stack,
  TextField,
  Typography,
  alpha,
  IconButton,
  Card,
  CardContent
} from '@mui/material'
import {
  DeleteOutline as DeleteOutlineIcon,
  LightbulbOutlined as CustomSkillIcon,
  Search as SearchIcon,
  EditOutlined as EditIcon
} from '@mui/icons-material'
import { api } from '@renderer/utils/windowUtils'
import { useTranslation } from 'react-i18next'
import {
  CUSTOM_SKILL_CONTEXT_MESSAGE_LIMIT_OPTIONS,
  normalizeCustomSkillContextMessageLimit,
  resolveCustomSkillContextMessageLimit,
  type CustomSkill,
  type SkillReferenceAttachment
} from '@shared/config/config'
import { useConfig } from '../../hooks/useConfig'
import {
  buildBuiltInSkills,
  BUILT_IN_IMAGE_INTERROGATION_SKILL_ID,
  BUILT_IN_PROMPT_TRANSLATION_SKILL_ID,
  isBuiltInSkillId,
  mergeBuiltInSkills,
  stripDefaultBuiltInSkills
} from '../ChatPage/builtInSkills'
import CustomWorkshopTabs from './components/CustomWorkshopTabs'
import {
  getCustomSkillsForCategory,
  getCustomSkillsNeedingAttention,
  getResolvedCustomSkillPromptMirror,
  getResolvedCustomSkillSystemPrompt,
  getResolvedCustomSkillUserPrompt
} from './qAppWorkshopUtils'
import { getFileBadgeText } from '@renderer/utils/fileDisplay'
import {
  buildSkillReferenceAttachmentFromFile,
  dedupeSkillReferenceAttachments
} from '@renderer/utils/customSkillReferenceAttachments'

const DEFAULT_PROMPT_ROWS = 14
const COLLAPSED_PROMPT_ROWS = 3

const CUSTOM_SKILL_OUTPUT_MODE_OPTIONS = [
  { value: 'default', zh: String.fromCharCode(0x9ed8, 0x8ba4), en: 'Default' },
  { value: 'text', zh: String.fromCharCode(0x6587, 0x672c), en: 'Text' },
  { value: 'image', zh: String.fromCharCode(0x56fe, 0x7247), en: 'Image' },
  { value: 'video', zh: String.fromCharCode(0x89c6, 0x9891), en: 'Video' },
  { value: 'model3d', zh: '3D', en: '3D' }
] as const

type WorkshopOutputMode = (typeof CUSTOM_SKILL_OUTPUT_MODE_OPTIONS)[number]['value']

const normalizeWorkshopOutputMode = (
  value: NonNullable<CustomSkill['execution']>['outputMode'] | undefined
): WorkshopOutputMode => {
  switch (value) {
    case 'default':
    case 'text':
    case 'image':
    case 'video':
    case 'model3d':
      return value
    case 'chat':
    case 'sidecar':
    case 'structured':
      return 'text'
    default:
      return 'default'
  }
}

const normalizeWorkshopSkillOutputMode = (skill: CustomSkill): CustomSkill => {
  if (isBuiltInSkillId(skill.id)) {
    return skill
  }

  const outputMode = skill.execution?.outputMode
  if (outputMode !== 'chat' && outputMode !== 'sidecar' && outputMode !== 'structured') {
    return skill
  }

  return {
    ...skill,
    execution: {
      ...(skill.execution || {}),
      outputMode: 'text'
    }
  }
}

// ==========================================
// 样式常量
// ==========================================
const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

const workshopFieldSx = {
  '& .MuiInputBase-root': {
    color: 'text.primary'
  },
  '& .MuiInputBase-input, & .MuiInputBase-inputMultiline, & .MuiNativeSelect-select': {
    color: 'text.primary',
    WebkitTextFillColor: 'currentColor',
    caretColor: 'text.primary'
  }
} as const

const buildSkillPromptMirror = (systemPrompt: string, userPrompt: string): string =>
  [systemPrompt.trim(), userPrompt.trim()].filter(Boolean).join('\n\n')

const getSkillReferenceAttachmentLabel = (
  attachment: Pick<SkillReferenceAttachment, 'type' | 'fileName' | 'mimeType'>
): string => {
  const prefix = getFileBadgeText(attachment.fileName, attachment.mimeType)
  return attachment.fileName ? `${prefix} - ${attachment.fileName}` : prefix
}

const sanitizeSkillEditorState = (skill: CustomSkill): CustomSkill => {
  const normalizedSkill = normalizeWorkshopSkillOutputMode(skill)
  return normalizedSkill.type === 'agent'
    ? {
        ...normalizedSkill,
        prompt: '',
        instructions: undefined,
        referenceAttachments: []
      }
    : normalizedSkill
}

type QuickAppPromptPatch = {
  plugin_config: {
    imageInterrogationSystemPrompt?: string
    imageInterrogationUserPrompt?: string
    promptTranslationSystemPrompt?: string
    promptTranslationUserPrompt?: string
  }
}

const buildQuickAppImageInterrogationPromptPatch = (
  systemPrompt: string,
  userPrompt: string
): QuickAppPromptPatch => ({
  plugin_config: {
    imageInterrogationSystemPrompt: systemPrompt,
    imageInterrogationUserPrompt: userPrompt
  }
})

const buildQuickAppPromptTranslationPromptPatch = (
  systemPrompt: string,
  userPrompt: string
): QuickAppPromptPatch => ({
  plugin_config: {
    promptTranslationSystemPrompt: systemPrompt,
    promptTranslationUserPrompt: userPrompt
  }
})

const buildQuickAppPromptPatchForBuiltInSkill = (
  skillId: string | null | undefined,
  systemPrompt: string,
  userPrompt: string
): QuickAppPromptPatch | undefined => {
  switch (skillId) {
    case BUILT_IN_IMAGE_INTERROGATION_SKILL_ID:
      return buildQuickAppImageInterrogationPromptPatch(systemPrompt, userPrompt)
    case BUILT_IN_PROMPT_TRANSLATION_SKILL_ID:
      return buildQuickAppPromptTranslationPromptPatch(systemPrompt, userPrompt)
    default:
      return undefined
  }
}

const materializeBuiltInSkillOverride = (skill: CustomSkill): CustomSkill => {
  if (!isBuiltInSkillId(skill.id) || !skill.builtinOrigin) {
    return skill
  }

  const { builtinOrigin, ...userOverrideSkill } = skill
  return userOverrideSkill
}

const normalizeCustomSkillCategory = (value: string | null | undefined): string =>
  value?.trim() || ''

const listNamedCustomSkillCategories = (skills: CustomSkill[]): string[] =>
  [
    ...new Set(skills.map((skill) => normalizeCustomSkillCategory(skill.category)).filter(Boolean))
  ].sort((left, right) => left.localeCompare(right))

const mergeManagedCustomSkillCategories = (
  categories: Array<string | null | undefined>
): string[] =>
  [
    ...new Set(categories.map((category) => normalizeCustomSkillCategory(category)).filter(Boolean))
  ].sort((left, right) => left.localeCompare(right))

const areSkillListsEqual = (left: CustomSkill[], right: CustomSkill[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

const areStringListsEqual = (left: string[], right: string[]): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

type SkillListUpdate = CustomSkill[] | ((currentSkills: CustomSkill[]) => CustomSkill[])

// ==========================================
// SkillCard — 完美匹配 QAppDesignPanel WorkflowCard
// ==========================================
const SkillCard: React.FC<{
  skill: CustomSkill
  onClick: () => void
  onDelete: () => void
  onRename: (newName: string) => void
  issuesCount: number
  canDelete?: boolean
}> = ({ skill, onClick, onDelete, onRename, issuesCount, canDelete = true }) => {
  const [hovered, setHovered] = useState(false)
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(skill.skillName || '')

  React.useEffect(() => {
    setTitleDraft(skill.skillName || '')
  }, [skill.skillName])

  const { t, i18n } = useTranslation()
  const isChineseUi = (i18n?.language || i18n?.resolvedLanguage || '').startsWith('zh')

  const commitTitle = () => {
    setIsEditingTitle(false)
    if (titleDraft.trim() !== skill.skillName) {
      onRename(titleDraft.trim())
    }
  }

  const label = skill.skillName || t('custom_workshop.new_skill_default')
  return (
    <Card
      data-testid={`custom-skill-card-${skill.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      sx={(t) => ({
        position: 'relative',
        height: 150,
        cursor: 'pointer',
        borderRadius: 3,
        overflow: 'hidden',
        background: hovered
          ? t.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.08)'
            : 'rgba(0,0,0,0.04)'
          : t.palette.background.paper,
        color: t.palette.text.primary,
        border: `1px solid ${hovered ? t.palette.text.secondary : t.palette.divider}`,
        boxShadow: hovered
          ? 'none'
          : t.palette.mode === 'dark'
            ? SIDE_SHADOW_DARK
            : SIDE_SHADOW_LIGHT,
        transition:
          'transform .2s ease, box-shadow .2s ease, background .2s ease, color .2s ease, border-color .2s ease',
        '&:hover': { transform: 'translateY(-6px)' }
      })}
    >
      {canDelete ? (
        <IconButton
          aria-label={`${t('custom_workshop.delete_skill', { defaultValue: 'Delete skill' })} ${label}`}
          size="small"
          className="card-actions"
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
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <DeleteOutlineIcon sx={{ fontSize: 18 }} />
        </IconButton>
      ) : null}

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
        <Box sx={{ display: 'flex', alignItems: 'flex-start', maxWidth: '100%', width: '100%' }}>
          {isEditingTitle ? (
            <Box sx={{ display: 'flex', alignItems: 'center', width: '100%', mr: 1 }}>
              <InputBase
                fullWidth
                autoFocus
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onBlur={commitTitle}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTitle()
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setIsEditingTitle(false)
                    setTitleDraft(skill.skillName || '')
                  }
                }}
                sx={{
                  flex: 1,
                  fontWeight: 700,
                  fontSize: 16,
                  lineHeight: 1.3,
                  color: 'text.primary',
                  p: 0,
                  width: '100%',
                  minWidth: 0,
                  outline: 'none',
                  input: {
                    color: 'inherit',
                    WebkitTextFillColor: 'currentColor',
                    caretColor: 'currentColor',
                    p: 0,
                    textOverflow: 'ellipsis',
                    outline: 'none',
                    border: 'none',
                    boxShadow: 'none',
                    '&:focus': {
                      outline: 'none',
                      boxShadow: 'none',
                      border: 'none'
                    },
                    '&::selection': {
                      backgroundColor: 'rgba(255,255,255,0.3)'
                    }
                  }
                }}
              />
            </Box>
          ) : (
            <>
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
                title={label}
              >
                {label}
              </Typography>
              <IconButton
                size="small"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsEditingTitle(true)
                }}
                sx={{
                  ml: 0.5,
                  mt: -0.25,
                  opacity: hovered ? 1 : 0,
                  transition: 'opacity .2s ease',
                  color: 'text.secondary',
                  '&:hover': { color: 'text.primary' }
                }}
              >
                <EditIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </>
          )}
        </Box>

        <Stack direction="row" spacing={0.5} sx={{ mt: 1, alignItems: 'center' }}>
          {skill.type === 'agent' ? (
            <Chip
              size="small"
              label={t('custom_workshop.skill_type_agent', {
                defaultValue: isChineseUi ? '智能体' : 'Agent'
              })}
              color="primary"
              sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }}
            />
          ) : (
            <Chip
              size="small"
              label={t('custom_workshop.skill_type_prompt', {
                defaultValue: isChineseUi ? '提示词' : 'Prompt'
              })}
              variant="outlined"
              sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }}
            />
          )}
          {issuesCount > 0 && (
            <Chip
              size="small"
              color="warning"
              label={issuesCount}
              sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
            />
          )}
        </Stack>
      </CardContent>

      <Box
        className="watermark"
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
          opacity: (t) => (t.palette.mode === 'dark' ? 0.15 : 0.08),
          transformOrigin: 'right bottom',
          transition: 'transform 120ms ease, opacity 120ms ease',
          transform: hovered ? 'scale(1.15)' : 'scale(1)',
          ...(hovered && { opacity: 0.22 })
        }}
      >
        <CustomSkillIcon sx={{ fontSize: 64, color: 'text.primary' }} />
      </Box>
    </Card>
  )
}

const CustomSkillManagerPage: React.FC = () => {
  const { t, i18n } = useTranslation()
  const isChineseUi = (i18n?.language || i18n?.resolvedLanguage || '').startsWith('zh')
  const { config, updateConfig } = useConfig()
  const language = i18n?.resolvedLanguage || i18n?.language
  const uiText = useCallback(
    (zhValue: string, enValue: string) => (isChineseUi ? zhValue : enValue),
    [isChineseUi]
  )

  const mergeDefaultSkills = useCallback(
    (skills: CustomSkill[]) =>
      mergeBuiltInSkills(skills.map(normalizeWorkshopSkillOutputMode), {
        language,
        config
      }),
    [config, language]
  )

  const stripDefaultSkills = useCallback(
    (skills: CustomSkill[]) =>
      stripDefaultBuiltInSkills(skills, {
        language,
        config
      }),
    [config, language]
  )

  const buildManagedCategoryNames = useCallback(
    (skills: CustomSkill[], categories: Array<string | null | undefined>) =>
      mergeManagedCustomSkillCategories([...categories, ...listNamedCustomSkillCategories(skills)]),
    []
  )

  const initialCustomSkills = useMemo(
    () => mergeDefaultSkills(config?.llm_config?.customSkills || []),
    [config?.llm_config?.customSkills, mergeDefaultSkills]
  )
  const initialManagedCustomSkillCategories = useMemo(
    () =>
      buildManagedCategoryNames(
        initialCustomSkills,
        config?.llm_config?.customSkillCategories || []
      ),
    [buildManagedCategoryNames, config?.llm_config?.customSkillCategories, initialCustomSkills]
  )

  const [customSkills, setCustomSkills] = useState<CustomSkill[]>(initialCustomSkills)
  const [managedCustomSkillCategories, setManagedCustomSkillCategories] = useState<string[]>(
    initialManagedCustomSkillCategories
  )
  const customSkillsRef = React.useRef(customSkills)
  const managedCustomSkillCategoriesRef = React.useRef(managedCustomSkillCategories)

  const [isMigrationChecked, setIsMigrationChecked] = useState(false)

  const loadFromFileSystem = useCallback(async () => {
    try {
      const res = await api().svcCustomSkill.listCustomSkills({})
      const fsSkills = res.skills || []
      const fsCats = res.categories || []

      const configSkills = config?.llm_config?.customSkills || []
      const configCats = config?.llm_config?.customSkillCategories || []
      const hasFileSystemState = fsSkills.length > 0 || fsCats.length > 0
      const sourceSkills = hasFileSystemState ? fsSkills : configSkills
      const sourceCategories = hasFileSystemState ? fsCats : configCats
      const nextSkills = mergeDefaultSkills(sourceSkills)
      const nextCats = buildManagedCategoryNames(nextSkills, sourceCategories)
      const nextPersistedSkills = stripDefaultSkills(nextSkills)

      setCustomSkills(nextSkills)
      setManagedCustomSkillCategories(nextCats)

      if (
        !areSkillListsEqual(fsSkills, nextPersistedSkills) ||
        !areStringListsEqual(mergeManagedCustomSkillCategories(fsCats), nextCats)
      ) {
        await api().svcCustomSkill.batchSaveCustomSkills({
          skills: nextPersistedSkills,
          categories: nextCats
        })
      }

      if (
        !areSkillListsEqual(configSkills, nextPersistedSkills) ||
        !areStringListsEqual(mergeManagedCustomSkillCategories(configCats), nextCats)
      ) {
        await updateConfig({
          llm_config: {
            customSkills: nextPersistedSkills,
            customSkillCategories: nextCats
          }
        })
      }
    } catch (err) {
      console.error('Failed to load custom skills from fs:', err)
    } finally {
      setIsMigrationChecked(true)
    }
  }, [buildManagedCategoryNames, config, mergeDefaultSkills, stripDefaultSkills, updateConfig])

  React.useEffect(() => {
    if (!isMigrationChecked) {
      loadFromFileSystem()
    }
  }, [isMigrationChecked, loadFromFileSystem])

  React.useEffect(() => {
    customSkillsRef.current = customSkills
  }, [customSkills])

  React.useEffect(() => {
    managedCustomSkillCategoriesRef.current = managedCustomSkillCategories
  }, [managedCustomSkillCategories])

  // Component States
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [selectedSkillId, setSelectedSkillId] = useState<string>('')

  // Dialog States
  const [createSkillDialogOpen, setCreateSkillDialogOpen] = useState(false)
  const [editSkillDialogOpen, setEditSkillDialogOpen] = useState(false)
  const [deleteCategoryDialogOpen, setDeleteCategoryDialogOpen] = useState(false)
  const [deleteSkillDialogOpen, setDeleteSkillDialogOpen] = useState(false)
  const [attentionDialogOpen, setAttentionDialogOpen] = useState(false)

  // Form Drafts
  const [createSkillType, setCreateSkillType] = useState<CustomSkill['type']>('normal')
  const [createSkillName, setCreateSkillName] = useState('')
  const [createSkillPrompt, setCreateSkillPrompt] = useState('')
  const [createSkillApiAddress, setCreateSkillApiAddress] = useState('')
  const [createSkillApiKey, setCreateSkillApiKey] = useState('')
  const [categoryDraft, setCategoryDraft] = useState<string>('')
  const [skillNameDraft, setSkillNameDraft] = useState('')
  const [isSkillNameComposing, setIsSkillNameComposing] = useState(false)
  const [isCreatingCategory, setIsCreatingCategory] = useState(false)
  const [isSelectedPromptCollapsed, setIsSelectedPromptCollapsed] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingInlineCategory, setEditingInlineCategory] = useState<string | null>(null)
  const [inlineCategoryDraft, setInlineCategoryDraft] = useState('')
  const referenceImageInputRef = React.useRef<HTMLInputElement | null>(null)
  const referenceDocumentInputRef = React.useRef<HTMLInputElement | null>(null)

  const emptyCategoryLabel = t('custom_workshop.category_empty', {
    defaultValue: '未分类'
  })
  const currentContextLabel = t('custom_workshop.skill_session_policy_label', {
    defaultValue: uiText('引用上下文', 'Context reference')
  })
  const createCategoryOptionLabel = isChineseUi
    ? '创建分类'
    : t('custom_workshop.create_category_option', { defaultValue: 'Create category' })
  const uncategorizedCategoryOptionValue = '__UNCATEGORIZED__'

  // Derived Data
  const categories = useMemo(() => {
    const merged = mergeManagedCustomSkillCategories([
      ...managedCustomSkillCategories,
      ...listNamedCustomSkillCategories(customSkills)
    ])
    const hasUncategorizedSkills = customSkills.some(
      (skill) => !normalizeCustomSkillCategory(skill.category)
    )

    return hasUncategorizedSkills ? [...merged, emptyCategoryLabel] : merged
  }, [customSkills, emptyCategoryLabel, managedCustomSkillCategories])

  const attentionSkills = useMemo(
    () => getCustomSkillsNeedingAttention(customSkills, t),
    [customSkills, t]
  )

  const filteredSkills = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase()
    if (!normalizedQuery) {
      return customSkills
    }
    return customSkills.filter((skill) =>
      [
        skill.skillName,
        skill.category,
        getResolvedCustomSkillPromptMirror(skill),
        skill.apiAddress,
        ...(skill.bindings?.map((binding) => binding.appId) || [])
      ]
        .filter((value): value is string => Boolean(value && value.trim()))
        .some((value) => value.toLowerCase().includes(normalizedQuery))
    )
  }, [customSkills, searchQuery])

  const selectedSkill = useMemo(
    () => customSkills.find((s) => s.id === selectedSkillId) || null,
    [customSkills, selectedSkillId]
  )
  const isSelectedAgentSkill = selectedSkill?.type === 'agent'
  const selectedSkillReferenceAttachments = useMemo(
    () => (isSelectedAgentSkill ? [] : selectedSkill?.referenceAttachments || []),
    [isSelectedAgentSkill, selectedSkill?.referenceAttachments]
  )

  const selectedSkillIssues = useMemo(() => {
    if (!selectedSkill) return []
    return getCustomSkillsNeedingAttention([selectedSkill], t)[0]?.issues || []
  }, [selectedSkill, t])

  const selectedSkillSystemPrompt = selectedSkill
    ? getResolvedCustomSkillSystemPrompt(selectedSkill)
    : ''

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()

  const categorySections = useMemo(
    () =>
      categories
        .map((category) => {
          const categorySkills = getCustomSkillsForCategory(
            filteredSkills,
            category,
            emptyCategoryLabel
          )
          const totalCategorySkills = getCustomSkillsForCategory(
            customSkills,
            category,
            emptyCategoryLabel
          )
          const matchesCategoryQuery =
            normalizedSearchQuery.length > 0 &&
            category.toLowerCase().includes(normalizedSearchQuery)
          const shouldShow =
            categorySkills.length > 0 ||
            matchesCategoryQuery ||
            (!normalizedSearchQuery &&
              category !== emptyCategoryLabel &&
              totalCategorySkills.length === 0)

          return {
            category,
            categorySkills,
            shouldShow
          }
        })
        .filter((section) => section.shouldShow),
    [categories, customSkills, emptyCategoryLabel, filteredSkills, normalizedSearchQuery]
  )

  // --- Actions ---
  const handleUpdateSkillList = useCallback(
    (
      update: SkillListUpdate,
      options?: {
        categoryNames?: string[]
        configPatch?: QuickAppPromptPatch
      }
    ) => {
      const sourceSkills = customSkillsRef.current
      const nextSkillInput = (Array.isArray(update) ? update : update(sourceSkills)).map(
        sanitizeSkillEditorState
      )
      const mergedSkills = mergeDefaultSkills(nextSkillInput)
      const nextCategoryNames = buildManagedCategoryNames(
        mergedSkills,
        options?.categoryNames ?? managedCustomSkillCategoriesRef.current
      )
      const persistedSkills = stripDefaultSkills(mergedSkills)

      customSkillsRef.current = mergedSkills
      managedCustomSkillCategoriesRef.current = nextCategoryNames
      setCustomSkills(mergedSkills)
      setManagedCustomSkillCategories(nextCategoryNames)

      api()
        .svcCustomSkill.batchSaveCustomSkills({
          skills: persistedSkills,
          categories: nextCategoryNames
        })
        .catch((err) => {
          console.error('Failed to save skills to file system:', err)
        })

      updateConfig({
        llm_config: {
          customSkills: persistedSkills,
          customSkillCategories: nextCategoryNames
        },
        ...(options?.configPatch || {})
      })
    },
    [buildManagedCategoryNames, mergeDefaultSkills, stripDefaultSkills, updateConfig]
  )

  const openCreateSkillDialog = useCallback(() => {
    const newId = `skill_${Date.now()}`
    const categoryName =
      selectedCategory && selectedCategory !== emptyCategoryLabel ? selectedCategory : ''
    const newSkill: CustomSkill = {
      id: newId,
      skillName: t('custom_workshop.skill_untitled', { defaultValue: '未命名技能' }),
      type: 'normal',
      category: categoryName,
      prompt: '',
      instructions: {
        systemPrompt: '',
        userPrompt: ''
      },
      execution: {
        mode: 'inherit',
        allowHistory: true,
        outputMode: 'default',
        fallbackStrategy: 'default',
        persistSessionUrl: true,
        contextMessageLimit: 'all'
      },
      referenceAttachments: [],
      resources: [],
      scripts: [],
      bindings: [],
      apiAddress: '',
      apiKey: ''
    }
    handleUpdateSkillList([...customSkills, newSkill])
    setSelectedSkillId(newId)
    setCategoryDraft(categoryName)
    setIsCreatingCategory(false)
    setEditSkillDialogOpen(true)
  }, [selectedCategory, emptyCategoryLabel, customSkills, t, handleUpdateSkillList])
  const closeCreateSkillDialog = () => setCreateSkillDialogOpen(false)
  const closeEditSkillDialog = () => {
    handleCommitSkillName()
    setEditSkillDialogOpen(false)
    setIsCreatingCategory(false)
  }

  const commitOnEnter = (event: React.KeyboardEvent, handler: () => void) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      handler()
    }
  }

  const handleCreateSkill = () => {
    // kept for legacy reference or direct triggers if any, though replaced by inline creation
  }

  const canConfirmCreateSkill = false

  const handleTransformSelectedSkill = useCallback(
    (
      transform: (skill: CustomSkill) => CustomSkill,
      options?: {
        configPatch?: QuickAppPromptPatch
      }
    ) => {
      if (!selectedSkillId) return
      handleUpdateSkillList(
        (currentSkills) =>
          currentSkills.map((skill) =>
            skill.id === selectedSkillId ? materializeBuiltInSkillOverride(transform(skill)) : skill
          ),
        options
      )
    },
    [handleUpdateSkillList, selectedSkillId]
  )

  const handleUpdateSelectedSkill = useCallback(
    (updates: Partial<CustomSkill>) => {
      handleTransformSelectedSkill((skill) => ({ ...skill, ...updates }))
    },
    [handleTransformSelectedSkill]
  )

  const handleUpdateSelectedSkillPrompts = useCallback(
    (updates: { systemPrompt?: string; userPrompt?: string }) => {
      const nextSystemPrompt =
        updates.systemPrompt !== undefined
          ? updates.systemPrompt
          : selectedSkill
            ? getResolvedCustomSkillSystemPrompt(selectedSkill)
            : ''
      const nextUserPrompt =
        updates.userPrompt !== undefined
          ? updates.userPrompt
          : selectedSkill
            ? getResolvedCustomSkillUserPrompt(selectedSkill)
            : ''

      handleTransformSelectedSkill(
        (skill) => {
          return {
            ...skill,
            prompt: buildSkillPromptMirror(nextSystemPrompt, nextUserPrompt),
            instructions: {
              ...(skill.instructions || {}),
              systemPrompt: nextSystemPrompt,
              userPrompt: nextUserPrompt
            }
          }
        },
        selectedSkill
          ? {
              configPatch: buildQuickAppPromptPatchForBuiltInSkill(
                selectedSkill.id,
                nextSystemPrompt,
                nextUserPrompt
              )
            }
          : undefined
      )
    },
    [handleTransformSelectedSkill, selectedSkill]
  )

  const handleUpdateSelectedSkillExecution = useCallback(
    (updates: Partial<NonNullable<CustomSkill['execution']>>) => {
      handleTransformSelectedSkill((skill) => ({
        ...skill,
        execution: {
          ...(skill.execution || {}),
          ...updates
        }
      }))
    },
    [handleTransformSelectedSkill]
  )

  const handleAddReferenceAttachments = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      if (selectedSkill?.type === 'agent') {
        event.target.value = ''
        return
      }

      const files = Array.from(event.target.files || [])
      event.target.value = ''
      if (files.length === 0) {
        return
      }

      const nextReferenceAttachments = await Promise.all(
        files.map((file) => buildSkillReferenceAttachmentFromFile(file))
      )

      handleTransformSelectedSkill((skill) => ({
        ...skill,
        referenceAttachments: dedupeSkillReferenceAttachments([
          ...(skill.referenceAttachments || []),
          ...nextReferenceAttachments
        ])
      }))
    },
    [handleTransformSelectedSkill, selectedSkill?.type]
  )

  const handleRemoveReferenceAttachment = useCallback(
    (attachmentIndex: number) => {
      handleTransformSelectedSkill((skill) => ({
        ...skill,
        referenceAttachments: (skill.referenceAttachments || []).filter(
          (_attachment, index) => index !== attachmentIndex
        )
      }))
    },
    [handleTransformSelectedSkill]
  )

  const handleCommitSkillName = useCallback(() => {
    if (!selectedSkill) return
    if (selectedSkill.skillName !== skillNameDraft) {
      handleUpdateSelectedSkill({ skillName: skillNameDraft })
    }
  }, [handleUpdateSelectedSkill, selectedSkill, skillNameDraft])

  React.useEffect(() => {
    setSkillNameDraft(selectedSkill?.skillName || '')
    setIsSkillNameComposing(false)
  }, [selectedSkill?.id, selectedSkill?.skillName])

  const handleCommitCategoryRename = () => {
    if (!selectedSkill) return
    const newCat = categoryDraft.trim()
    if (selectedSkill.category !== newCat) {
      handleUpdateSelectedSkill({ category: newCat })
      setSelectedCategory(newCat || emptyCategoryLabel)
    }
  }

  const handleCompleteCategoryCreation = () => {
    if (!selectedSkill) return
    const newCat = categoryDraft.trim()
    if (!newCat) {
      setCategoryDraft(selectedSkill.category || '')
      setIsCreatingCategory(false)
      return
    }
    handleCommitCategoryRename()
    setIsCreatingCategory(false)
  }

  const handleCommitInlineCategoryRename = (oldCategory: string) => {
    setEditingInlineCategory(null)
    const newCat = inlineCategoryDraft.trim()
    if (!newCat || newCat === oldCategory || newCat === emptyCategoryLabel) return

    const newList = customSkills.map((s) => {
      const sCat = s.category?.trim() || emptyCategoryLabel
      if (sCat === oldCategory) {
        return materializeBuiltInSkillOverride({ ...s, category: newCat })
      }
      return s
    })
    handleUpdateSkillList(newList, {
      categoryNames: [
        ...categories.filter(
          (category) => category !== oldCategory && category !== emptyCategoryLabel
        ),
        newCat
      ]
    })
    setSelectedCategory((current) => (current === oldCategory ? newCat : current))
  }

  const handleConfirmDeleteCategory = () => {
    if (!selectedCategory) return
    const defaultBuiltInCategoryById = new Map(
      buildBuiltInSkills({ language, config }).map((skill) => [skill.id, skill.category])
    )
    const newList = customSkills.flatMap((s) => {
      const cat = s.category?.trim() || emptyCategoryLabel
      if (cat !== selectedCategory) {
        return [s]
      }

      if (isBuiltInSkillId(s.id)) {
        return [
          {
            ...s,
            category: defaultBuiltInCategoryById.get(s.id) || selectedCategory
          }
        ]
      }

      return []
    })
    handleUpdateSkillList(newList, {
      categoryNames: categories.filter(
        (category) => category !== selectedCategory && category !== emptyCategoryLabel
      )
    })
    setDeleteCategoryDialogOpen(false)
    setSelectedCategory('')
    setSelectedSkillId('')
  }

  const handleDeleteSkill = () => {
    if (!selectedSkillId) return
    if (isBuiltInSkillId(selectedSkillId)) {
      setDeleteSkillDialogOpen(false)
      return
    }
    const skillToDelete = customSkills.find((s) => s.id === selectedSkillId)
    const deletedCategory =
      normalizeCustomSkillCategory(skillToDelete?.category) || emptyCategoryLabel
    const newList = customSkills.filter((s) => s.id !== selectedSkillId)
    handleUpdateSkillList(newList, {
      categoryNames:
        deletedCategory === emptyCategoryLabel
          ? managedCustomSkillCategories
          : [...managedCustomSkillCategories, deletedCategory]
    })
    setDeleteSkillDialogOpen(false)
    setEditSkillDialogOpen(false)
    setSelectedSkillId('')
    setSelectedCategory(deletedCategory)
  }

  const handleOpenSkillRepair = useCallback(
    (skill: CustomSkill) => {
      const nextCategory = normalizeCustomSkillCategory(skill.category) || emptyCategoryLabel
      setSelectedCategory(nextCategory)
      setCategoryDraft(skill.category || '')
      setSelectedSkillId(skill.id)
      setIsCreatingCategory(false)
      setAttentionDialogOpen(false)
      setEditSkillDialogOpen(true)
    },
    [emptyCategoryLabel]
  )

  // --- Renders ---
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
          {attentionSkills.length > 0 ? (
            <Alert
              data-testid="custom-skill-attention-alert"
              severity="warning"
              onClick={() => setAttentionDialogOpen(true)}
              sx={{
                cursor: 'pointer',
                '& .MuiAlert-message': {
                  width: '100%'
                }
              }}
            >
              <Stack
                direction={{ xs: 'column', sm: 'row' }}
                spacing={0.5}
                justifyContent="space-between"
                alignItems={{ xs: 'flex-start', sm: 'center' }}
              >
                <Typography sx={{ fontWeight: 600 }}>
                  {t('custom_workshop.attention_desc', { count: attentionSkills.length })}
                </Typography>
                <Typography variant="caption" color="warning.light">
                  {uiText('查看', 'View')}
                </Typography>
              </Stack>
            </Alert>
          ) : null}

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
                  'aria-label': isChineseUi ? '搜索技能' : 'Search skills'
                }}
                placeholder={
                  isChineseUi
                    ? '搜索技能名称、分类或提示词...'
                    : 'Search skills, categories, or prompts...'
                }
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                sx={{ flex: 1, fontSize: 14 }}
              />
            </Box>
            <Stack direction="row" spacing={1} sx={{ flexShrink: 0, alignItems: 'center' }}>
              <Button
                variant="outlined"
                onClick={openCreateSkillDialog}
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
                {t('custom_workshop.create_skill_title', { defaultValue: '创建新技能' })}
              </Button>
            </Stack>
          </Box>

          {categorySections.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 8 }}>
              <Typography color="text.secondary" variant="body2">
                {searchQuery.trim()
                  ? isChineseUi
                    ? '没有找到匹配的技能'
                    : 'No matching skills found'
                  : t('custom_workshop.skill_category_empty', { defaultValue: '暂无分类' })}
              </Typography>
            </Box>
          ) : (
            categorySections.map(({ category, categorySkills }) => {
              return (
                <Box key={category}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      mb: 1.5
                    }}
                  >
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {editingInlineCategory === category ? (
                        <Box sx={{ display: 'flex', alignItems: 'center' }}>
                          <InputBase
                            autoFocus
                            value={inlineCategoryDraft}
                            onChange={(e) => setInlineCategoryDraft(e.target.value)}
                            onBlur={() => handleCommitInlineCategoryRename(category)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                handleCommitInlineCategoryRename(category)
                              }
                              if (e.key === 'Escape') {
                                setEditingInlineCategory(null)
                              }
                            }}
                            sx={{
                              flex: 1,
                              fontWeight: 700,
                              fontSize: 16,
                              lineHeight: 1.5,
                              color: 'text.primary',
                              p: 0,
                              minWidth: 200,
                              outline: 'none',
                              input: {
                                color: 'inherit',
                                WebkitTextFillColor: 'currentColor',
                                caretColor: 'currentColor',
                                p: 0,
                                textOverflow: 'ellipsis',
                                outline: 'none',
                                border: 'none',
                                boxShadow: 'none',
                                '&:focus': {
                                  outline: 'none',
                                  boxShadow: 'none',
                                  border: 'none'
                                },
                                '&::selection': {
                                  backgroundColor: 'rgba(255,255,255,0.3)'
                                }
                              }
                            }}
                          />
                        </Box>
                      ) : (
                        <>
                          <Typography
                            variant="subtitle1"
                            sx={{ fontWeight: 700, color: 'text.primary' }}
                          >
                            {category}
                          </Typography>
                          <Chip
                            label={categorySkills.length}
                            size="small"
                            variant="outlined"
                            sx={{ height: 20, fontSize: 11, fontWeight: 700 }}
                          />
                          {category !== emptyCategoryLabel && (
                            <IconButton
                              size="small"
                              onClick={() => {
                                setEditingInlineCategory(category)
                                setInlineCategoryDraft(category)
                              }}
                              sx={{
                                ml: 0.5,
                                color: 'text.secondary',
                                opacity: 0.5,
                                '&:hover': { color: 'text.primary', opacity: 1 }
                              }}
                            >
                              <EditIcon sx={{ fontSize: 16 }} />
                            </IconButton>
                          )}
                        </>
                      )}
                    </Box>
                    <IconButton
                      aria-label={`${t('custom_workshop.delete_category', { defaultValue: 'Delete category' })} ${category}`}
                      size="small"
                      color="error"
                      onClick={() => {
                        setSelectedCategory(category)
                        setDeleteCategoryDialogOpen(true)
                      }}
                      sx={{ opacity: 0.6, '&:hover': { opacity: 1 } }}
                    >
                      <DeleteOutlineIcon sx={{ fontSize: 18 }} />
                    </IconButton>
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
                    {categorySkills.length === 0 ? (
                      <Box
                        sx={(theme) => ({
                          gridColumn: '1 / -1',
                          px: 2,
                          py: 2.5,
                          borderRadius: 2.5,
                          border: `1px dashed ${alpha(theme.palette.text.primary, 0.18)}`,
                          bgcolor: alpha(theme.palette.text.primary, 0.02)
                        })}
                      >
                        <Typography variant="body2" color="text.secondary">
                          {t('custom_workshop.skill_name_empty', {
                            defaultValue: '当前分类下暂无技能'
                          })}
                        </Typography>
                      </Box>
                    ) : (
                      categorySkills.map((skill) => {
                        const issues = getCustomSkillsNeedingAttention([skill], t)[0]?.issues || []
                        return (
                          <SkillCard
                            key={skill.id}
                            skill={skill}
                            issuesCount={issues.length}
                            canDelete={!isBuiltInSkillId(skill.id)}
                            onClick={() => {
                              setSelectedCategory(category)
                              setCategoryDraft(skill.category || '')
                              setSelectedSkillId(skill.id)
                              setIsCreatingCategory(false)
                              setEditSkillDialogOpen(true)
                            }}
                            onDelete={() => {
                              setSelectedSkillId(skill.id)
                              setDeleteSkillDialogOpen(true)
                            }}
                            onRename={(newName) => {
                              const newList = customSkills.map((s) =>
                                s.id === skill.id
                                  ? materializeBuiltInSkillOverride({
                                      ...s,
                                      skillName: newName
                                    })
                                  : s
                              )
                              handleUpdateSkillList(newList)
                            }}
                          />
                        )
                      })
                    )}
                  </Box>
                </Box>
              )
            })
          )}
        </Stack>
      </Box>

      {/* Dialogs */}
      <Dialog
        data-testid="custom-skill-attention-dialog"
        open={attentionDialogOpen}
        onClose={() => setAttentionDialogOpen(false)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>{uiText('待修复技能', 'Skills Requiring Attention')}</DialogTitle>
        <DialogContent>
          <Stack spacing={1.25} sx={{ pt: 1 }}>
            {attentionSkills.map(({ skill, issues }) => {
              const displayCategory =
                normalizeCustomSkillCategory(skill.category) || emptyCategoryLabel
              const displaySkillName = skill.skillName || t('custom_workshop.new_skill_default')

              return (
                <Box
                  key={skill.id}
                  sx={(theme) => ({
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 2,
                    overflow: 'hidden',
                    bgcolor: alpha(theme.palette.text.primary, 0.02)
                  })}
                >
                  <Button
                    data-testid={`custom-skill-attention-item-${skill.id}`}
                    fullWidth
                    onClick={() => handleOpenSkillRepair(skill)}
                    sx={{
                      p: 0,
                      textTransform: 'none',
                      color: 'text.primary',
                      alignItems: 'stretch',
                      justifyContent: 'flex-start'
                    }}
                  >
                    <Box sx={{ width: '100%', p: 1.5, textAlign: 'left' }}>
                      <Stack
                        direction="row"
                        justifyContent="space-between"
                        alignItems="center"
                        spacing={1}
                      >
                        <Typography sx={{ fontWeight: 700 }}>{displaySkillName}</Typography>
                        <Chip size="small" color="warning" label={issues.length} />
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        {displayCategory}
                      </Typography>
                      <Stack spacing={0.5} sx={{ mt: 1 }}>
                        {issues.map((issue) => (
                          <Typography
                            key={`${skill.id}-${issue}`}
                            variant="body2"
                            color="text.secondary"
                            sx={{ lineHeight: 1.6 }}
                          >
                            {'• '}
                            {issue}
                          </Typography>
                        ))}
                      </Stack>
                    </Box>
                  </Button>
                </Box>
              )
            })}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAttentionDialogOpen(false)}>
            {t('custom_workshop.create_skill_cancel', { defaultValue: '取消' })}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        data-testid="custom-skill-delete-category-dialog"
        open={deleteCategoryDialogOpen}
        onClose={() => setDeleteCategoryDialogOpen(false)}
      >
        <DialogTitle>
          {t('custom_workshop.delete_category_title', { defaultValue: '删除分类' })}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {isChineseUi
              ? `确定删除整个“${selectedCategory}”分类吗？此操作不可撤销，分类下的所有技能都会被删除！`
              : `Delete entire category "${selectedCategory}"? This cannot be undone and all skills inside will be deleted!`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteCategoryDialogOpen(false)}>
            {t('custom_workshop.create_skill_cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            color="error"
            variant="contained"
            disableElevation
            onClick={handleConfirmDeleteCategory}
          >
            {t('project.delete_confirm', { defaultValue: '确定删除' })}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        data-testid="custom-skill-delete-skill-dialog"
        open={deleteSkillDialogOpen}
        onClose={() => setDeleteSkillDialogOpen(false)}
      >
        <DialogTitle>
          {t('custom_workshop.delete_skill_title', { defaultValue: '删除技能' })}
        </DialogTitle>
        <DialogContent>
          <Typography>
            {isChineseUi
              ? `确定删除技能“${selectedSkill?.skillName || t('custom_workshop.new_skill_default')}”吗？此操作不可撤销。`
              : `Delete skill "${selectedSkill?.skillName || t('custom_workshop.new_skill_default')}"? This action cannot be undone.`}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSkillDialogOpen(false)}>
            {t('custom_workshop.create_skill_cancel', { defaultValue: '取消' })}
          </Button>
          <Button color="error" variant="contained" disableElevation onClick={handleDeleteSkill}>
            {t('project.delete_confirm', { defaultValue: '确定删除' })}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        data-testid="custom-skill-edit-dialog"
        open={editSkillDialogOpen && !!selectedSkill}
        onClose={closeEditSkillDialog}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle sx={{ color: 'text.primary' }}>
          {skillNameDraft || selectedSkill?.skillName || t('custom_workshop.new_skill_default')}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {!isCreatingCategory ? (
              <TextField
                select
                label={t('custom_workshop.skill_category_label')}
                InputLabelProps={{ shrink: true }}
                value={categoryDraft.trim() || uncategorizedCategoryOptionValue}
                onChange={(event) => {
                  const val = event.target.value
                  if (val === '__CREATE_NEW__') {
                    setIsCreatingCategory(true)
                    setCategoryDraft('')
                  } else {
                    const nextCategory = val === uncategorizedCategoryOptionValue ? '' : val
                    setCategoryDraft(nextCategory)
                    handleUpdateSelectedSkill({ category: nextCategory })
                    setSelectedCategory(nextCategory || emptyCategoryLabel)
                  }
                }}
                SelectProps={{ native: true }}
                helperText={t('custom_workshop.skill_category_helper')}
                sx={workshopFieldSx}
                fullWidth
              >
                <option value={uncategorizedCategoryOptionValue}>{emptyCategoryLabel}</option>
                {categories
                  .filter((cat) => cat !== emptyCategoryLabel)
                  .map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                {categoryDraft &&
                  !categories.includes(categoryDraft) &&
                  categoryDraft !== emptyCategoryLabel && (
                    <option value={categoryDraft}>{categoryDraft}</option>
                  )}
                <option value="__CREATE_NEW__">{createCategoryOptionLabel}</option>
              </TextField>
            ) : (
              <TextField
                autoFocus
                label={t('custom_workshop.skill_category_label')}
                InputLabelProps={{ shrink: true }}
                value={categoryDraft}
                onChange={(event) => setCategoryDraft(event.target.value)}
                onBlur={handleCompleteCategoryCreation}
                onKeyDown={(event: React.KeyboardEvent) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    handleCompleteCategoryCreation()
                  }
                  if (event.key === 'Escape') {
                    setCategoryDraft(selectedSkill?.category || '')
                    setIsCreatingCategory(false)
                  }
                }}
                helperText={t('custom_workshop.skill_category_helper')}
                sx={workshopFieldSx}
                fullWidth
              />
            )}
            <TextField
              label={t('custom_workshop.skill_name_label')}
              value={skillNameDraft}
              onChange={(event) => setSkillNameDraft(event.target.value)}
              onBlur={() => {
                if (!isSkillNameComposing) {
                  handleCommitSkillName()
                }
              }}
              onCompositionStart={() => setIsSkillNameComposing(true)}
              onCompositionEnd={() => setIsSkillNameComposing(false)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isSkillNameComposing) {
                  event.preventDefault()
                  handleCommitSkillName()
                }
                if (event.key === 'Escape') {
                  setSkillNameDraft(selectedSkill?.skillName || '')
                }
              }}
              sx={workshopFieldSx}
              fullWidth
            />
            <TextField
              select
              label={t('custom_workshop.skill_type_label')}
              value={selectedSkill?.type || 'normal'}
              onChange={(event) =>
                handleUpdateSelectedSkill({ type: event.target.value as CustomSkill['type'] })
              }
              SelectProps={{ native: true }}
              sx={workshopFieldSx}
              fullWidth
            >
              <option value="normal">Prompt</option>
              <option value="agent">{t('custom_workshop.skill_type_agent')}</option>
            </TextField>
            {selectedSkill?.type === 'agent' && (
              <>
                <TextField
                  label={t('custom_workshop.skill_api_address_label')}
                  value={selectedSkill.apiAddress || ''}
                  onChange={(event) =>
                    handleUpdateSelectedSkill({ apiAddress: event.target.value })
                  }
                  sx={workshopFieldSx}
                  fullWidth
                />
                <TextField
                  label={t('custom_workshop.skill_api_key_label')}
                  value={selectedSkill.apiKey || ''}
                  onChange={(event) => handleUpdateSelectedSkill({ apiKey: event.target.value })}
                  sx={workshopFieldSx}
                  fullWidth
                />
              </>
            )}
            {!isSelectedAgentSkill && (
              <>
                <TextField
                  label={t('custom_workshop.skill_system_prompt_label', {
                    defaultValue: uiText('系统提示词', 'System Prompt')
                  })}
                  value={selectedSkillSystemPrompt}
                  onChange={(event) =>
                    handleUpdateSelectedSkillPrompts({ systemPrompt: event.target.value })
                  }
                  sx={workshopFieldSx}
                  fullWidth
                  multiline
                  minRows={isSelectedPromptCollapsed ? COLLAPSED_PROMPT_ROWS : DEFAULT_PROMPT_ROWS}
                  maxRows={isSelectedPromptCollapsed ? COLLAPSED_PROMPT_ROWS : undefined}
                />
                <input
                  data-testid="custom-skill-reference-image-input"
                  ref={referenceImageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={handleAddReferenceAttachments}
                />
                <input
                  data-testid="custom-skill-reference-document-input"
                  ref={referenceDocumentInputRef}
                  type="file"
                  accept=".pdf,.doc,.docx,.txt,.md,.csv,.xls,.xlsx,.ppt,.pptx"
                  multiple
                  hidden
                  onChange={handleAddReferenceAttachments}
                />
                <Box
                  sx={{
                    display: 'flex',
                    gap: 2,
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap'
                  }}
                >
                  <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      sx={{ lineHeight: 1.6, display: 'block' }}
                    >
                      {t('custom_workshop.skill_reference_attachments_label', {
                        defaultValue: uiText('参考附件', 'Reference Attachments')
                      })}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                      {t('custom_workshop.skill_reference_attachments_helper', {
                        defaultValue: uiText(
                          '这些图片和文档会和 Prompt 一起发送给该技能对应的模型。',
                          'These images and documents are sent together with the prompt when this skill runs.'
                        )
                      })}
                    </Typography>
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => referenceImageInputRef.current?.click()}
                      >
                        {t('custom_workshop.skill_reference_add_image', {
                          defaultValue: uiText('添加图片', 'Add image')
                        })}
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={() => referenceDocumentInputRef.current?.click()}
                      >
                        {t('custom_workshop.skill_reference_add_document', {
                          defaultValue: uiText('添加文档', 'Add document')
                        })}
                      </Button>
                    </Stack>
                    <Stack
                      data-testid="custom-skill-reference-list"
                      direction="row"
                      spacing={1}
                      sx={{ flexWrap: 'wrap', rowGap: 1, minHeight: 32 }}
                    >
                      {selectedSkillReferenceAttachments.length > 0 ? (
                        selectedSkillReferenceAttachments.map((attachment, attachmentIndex) => (
                          <Chip
                            key={`${attachment.url}-${attachmentIndex}`}
                            size="small"
                            variant="outlined"
                            label={getSkillReferenceAttachmentLabel(attachment)}
                            data-testid={`custom-skill-reference-chip-${attachmentIndex}`}
                            onDelete={() => handleRemoveReferenceAttachment(attachmentIndex)}
                          />
                        ))
                      ) : (
                        <Typography
                          variant="caption"
                          color="text.secondary"
                          data-testid="custom-skill-reference-empty"
                          sx={{ lineHeight: '32px' }}
                        >
                          {t('custom_workshop.skill_reference_attachments_empty', {
                            defaultValue: uiText('暂未添加参考附件', 'No reference attachments yet')
                          })}
                        </Typography>
                      )}
                    </Stack>
                  </Stack>
                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', ml: 'auto' }}>
                    <Button
                      size="small"
                      onClick={() => setIsSelectedPromptCollapsed((prev) => !prev)}
                    >
                      {isSelectedPromptCollapsed
                        ? t('custom_workshop.prompt_expand', { defaultValue: '展开 Prompt' })
                        : t('custom_workshop.prompt_collapse', { defaultValue: '收起 Prompt' })}
                    </Button>
                  </Box>
                </Box>
              </>
            )}
            <TextField
              select
              label={t('custom_workshop.skill_output_mode_label', {
                defaultValue: uiText('输出模式', 'Output Mode')
              })}
              value={normalizeWorkshopOutputMode(selectedSkill?.execution?.outputMode)}
              onChange={(event) =>
                handleUpdateSelectedSkillExecution({
                  outputMode: event.target.value as NonNullable<
                    CustomSkill['execution']
                  >['outputMode']
                })
              }
              SelectProps={{ native: true }}
              sx={workshopFieldSx}
              fullWidth
            >
              {CUSTOM_SKILL_OUTPUT_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {uiText(option.zh, option.en)}
                </option>
              ))}
            </TextField>
            <TextField
              select
              label={t('custom_workshop.skill_fallback_strategy_label', {
                defaultValue: uiText('输入策略', 'Input Strategy')
              })}
              value={selectedSkill?.execution?.fallbackStrategy || 'default'}
              onChange={(event) =>
                handleUpdateSelectedSkillExecution({
                  fallbackStrategy: event.target.value as NonNullable<
                    CustomSkill['execution']
                  >['fallbackStrategy']
                })
              }
              SelectProps={{ native: true }}
              sx={workshopFieldSx}
              fullWidth
            >
              <option value="default">{uiText('默认输入', 'Default input')}</option>
              <option value="smaller-batches">{uiText('分批输入', 'Split into batches')}</option>
              <option value="single-file">{uiText('逐个输入', 'Single item input')}</option>
            </TextField>
            <TextField
              select
              label={currentContextLabel}
              value={String(resolveCustomSkillContextMessageLimit(selectedSkill?.execution))}
              onChange={(event) => {
                const contextMessageLimit =
                  normalizeCustomSkillContextMessageLimit(event.target.value) ?? 'all'
                const shouldIncludeContext = contextMessageLimit !== 0
                handleUpdateSelectedSkillExecution({
                  contextMessageLimit,
                  mode: shouldIncludeContext ? 'inherit' : 'isolated',
                  allowHistory: shouldIncludeContext,
                  persistSessionUrl: contextMessageLimit === 'all'
                })
              }}
              SelectProps={{ native: true }}
              sx={workshopFieldSx}
              fullWidth
            >
              {CUSTOM_SKILL_CONTEXT_MESSAGE_LIMIT_OPTIONS.map((option) => (
                <option key={String(option)} value={String(option)}>
                  {option === 'all' ? uiText('全部', 'All') : option}
                </option>
              ))}
            </TextField>
            {selectedSkillIssues.length > 0 && (
              <Alert severity="warning">{selectedSkillIssues.join(' ')}</Alert>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2.5 }}>
          <Button
            variant="contained"
            disableElevation
            onClick={() => {
              handleCommitCategoryRename()
              closeEditSkillDialog()
            }}
          >
            {t('custom_workshop.create_skill_confirm', { defaultValue: '确定' })}
          </Button>
          <Button onClick={closeEditSkillDialog}>
            {t('custom_workshop.create_skill_cancel', { defaultValue: '取消' })}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}

export default CustomSkillManagerPage
