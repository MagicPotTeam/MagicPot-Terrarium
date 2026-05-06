import React, { useState } from 'react'
import {
  Box,
  Button,
  Chip,
  InputBase,
  MenuItem,
  Select,
  Stack,
  Typography,
  useTheme,
  Card,
  CardContent
} from '@mui/material'
import { Search as SearchIcon, LightbulbOutlined as CustomSkillIcon } from '@mui/icons-material'
import { useTranslation } from 'react-i18next'
import type { CustomSkill, CustomSkillType } from '@shared/config/config'
import { getCustomSkillName } from '../chatSkillUtils'

type ChatSkillPickerProps = {
  compact: boolean
  skillCategories: string[]
  selectedSkillCategory: string
  selectedSkillId: string | null
  skillsForSelectedCategory: CustomSkill[]
  customSkills?: CustomSkill[]
  onSelectSkillCategory: (category: string) => void
  onSelectSkill: (skillId: string | null) => void
}

const getSkillTypeBadgeColor = (type: CustomSkillType): 'primary' | 'default' =>
  type === 'agent' ? 'primary' : 'default'

const ChatSkillPicker: React.FC<ChatSkillPickerProps> = ({
  compact,
  skillCategories,
  selectedSkillCategory,
  selectedSkillId,
  skillsForSelectedCategory,
  customSkills,
  onSelectSkillCategory,
  onSelectSkill
}) => {
  const { t, i18n } = useTranslation()
  const [searchQuery, setSearchQuery] = useState('')
  const theme = useTheme()
  const locale = (i18n?.resolvedLanguage || i18n?.language || '').toLowerCase()
  const isChineseUi = locale.startsWith('zh')
  const copy = (chinese: string, english: string) => (isChineseUi ? chinese : english)

  const compactCategoryLabel = copy('（无）', '(None)')
  const compactSkillLabel = copy('技能名', 'Skill Name')
  const compactCategoryTitle = copy('分类', 'Category')
  const compactSkillTitle = copy('技能', 'Skill')
  const compactCategoryReset = copy('默认', 'Default')
  const compactSkillReset = copy('不使用', 'Off')

  const allSkills = React.useMemo(() => customSkills || [], [customSkills])

  // Create safe categories including "Uncategorized" if any
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const emptyCategoryLabel = t('custom_workshop.category_empty', { defaultValue: '未分类' })

  const filteredCategories = React.useMemo(() => {
    let result = skillCategories
    const hasUncat = allSkills.some((s) => !s.category?.trim())
    if (hasUncat && !result.includes(emptyCategoryLabel)) {
      result = [...result, emptyCategoryLabel]
    }
    return result
  }, [allSkills, skillCategories, emptyCategoryLabel])

  const categorySections = React.useMemo(() => {
    return filteredCategories
      .map((cat) => {
        const isUncat = cat === emptyCategoryLabel
        const skillsInCat = allSkills.filter((s) => {
          const sCat = s.category?.trim() || emptyCategoryLabel
          return sCat === cat
        })

        const categorySkills = skillsInCat.filter((skill) => {
          if (!normalizedSearchQuery) return true
          return [skill.skillName, skill.category, skill.prompt, skill.apiAddress]
            .filter((v): v is string => Boolean(v))
            .some((v) => v.toLowerCase().includes(normalizedSearchQuery))
        })

        const matchesCatQuery =
          normalizedSearchQuery && cat.toLowerCase().includes(normalizedSearchQuery)
        const shouldShow = categorySkills.length > 0 || matchesCatQuery

        return { category: cat, categorySkills, shouldShow }
      })
      .filter((s) => s.shouldShow)
  }, [filteredCategories, allSkills, emptyCategoryLabel, normalizedSearchQuery])

  if (compact) {
    // Keep the current category visible even when it is not part of the latest category list yet.
    const validCategories = Array.from(new Set([...skillCategories, selectedSkillCategory])).filter(
      Boolean
    )

    return (
      <Box
        data-testid="chat-skill-picker-compact"
        sx={{
          width: '100%',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 0,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(15,23,42,0.02)'
        }}
      >
        <Box
          sx={{
            borderRight: '1px solid',
            borderColor: 'divider',
            display: 'flex',
            alignItems: 'center',
            minWidth: 0,
            px: 0.5,
            py: 0.5
          }}
        >
          <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 0.5,
                px: 0.5
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                {compactCategoryTitle}
              </Typography>
              <Button
                size="small"
                variant={!selectedSkillCategory ? 'contained' : 'text'}
                onClick={() => onSelectSkillCategory('')}
                sx={{
                  minWidth: 'auto',
                  px: 1,
                  py: 0.25,
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 999,
                  lineHeight: 1.2,
                  boxShadow: 'none'
                }}
              >
                {compactCategoryReset}
              </Button>
            </Box>
            <Select
              size="small"
              value={
                !selectedSkillCategory || selectedSkillCategory === '__NONE__'
                  ? '__NONE__'
                  : selectedSkillCategory
              }
              onChange={(e) => {
                const value = e.target.value
                onSelectSkillCategory(value === '__NONE__' ? '' : value)
              }}
              sx={{
                flex: 1,
                height: 32,
                fontSize: 13,
                fontWeight: 700,
                '& .MuiSelect-select': {
                  py: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                },
                '& fieldset': { border: 'none' }
              }}
            >
              <MenuItem value="__NONE__">{compactCategoryLabel}</MenuItem>
              {validCategories.map((category) =>
                !category || category === '__NONE__' ? null : (
                  <MenuItem key={category} value={category}>
                    {category}
                  </MenuItem>
                )
              )}
            </Select>
          </Stack>
        </Box>

        <Box sx={{ display: 'flex', alignItems: 'center', minWidth: 0, px: 0.5, py: 0.5 }}>
          <Stack spacing={0.5} sx={{ flex: 1, minWidth: 0 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 0.5,
                px: 0.5
              }}
            >
              <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                {compactSkillTitle}
              </Typography>
              <Button
                size="small"
                variant={!selectedSkillId ? 'contained' : 'text'}
                onClick={() => onSelectSkill(null)}
                sx={{
                  minWidth: 'auto',
                  px: 1,
                  py: 0.25,
                  fontSize: 11,
                  fontWeight: 700,
                  borderRadius: 999,
                  lineHeight: 1.2,
                  boxShadow: 'none'
                }}
              >
                {compactSkillReset}
              </Button>
            </Box>
            <Select
              size="small"
              value={!selectedSkillId ? '__NONE__' : selectedSkillId}
              onChange={(e) => {
                const value = e.target.value
                onSelectSkill(value === '__NONE__' ? null : value)
              }}
              disabled={!selectedSkillCategory || skillsForSelectedCategory.length === 0}
              sx={{
                flex: 1,
                height: 32,
                fontSize: 13,
                fontWeight: 700,
                '& .MuiSelect-select': {
                  py: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                },
                '& fieldset': { border: 'none' }
              }}
            >
              <MenuItem value="__NONE__">{compactSkillLabel}</MenuItem>
              {selectedSkillCategory &&
                skillsForSelectedCategory.map((skill) => (
                  <MenuItem key={skill.id} value={skill.id}>
                    {getCustomSkillName(skill)}
                    <Chip
                      label={skill.type === 'agent' ? 'Agent' : 'Prompt'}
                      size="small"
                      color={getSkillTypeBadgeColor(skill.type)}
                      sx={{ ml: 1, height: 16, fontSize: 10 }}
                    />
                  </MenuItem>
                ))}
            </Select>
          </Stack>
        </Box>
      </Box>
    )
  }

  // --- Grid UI for compact=false ---

  const SIDE_SHADOW_LIGHT = '8px 0 16px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.12)'
  const SIDE_SHADOW_DARK = '8px 0 14px rgba(0,0,0,0.45), 0 8px 18px rgba(0,0,0,0.55)'

  return (
    <Box
      data-testid="chat-skill-picker-grid"
      sx={{
        width: '100%',
        maxWidth: 960,
        mx: 'auto',
        px: { xs: 2, sm: 3 },
        pt: 4,
        pb: 3,
        display: 'flex',
        flexDirection: 'column',
        gap: 3
      }}
    >
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
            bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
            border: `1px solid ${theme.palette.divider}`,
            transition: 'border-color .2s',
            '&:focus-within': { borderColor: theme.palette.primary.main }
          })}
        >
          <SearchIcon sx={{ fontSize: 20, color: 'text.secondary', flexShrink: 0 }} />
          <InputBase
            placeholder={isChineseUi ? '搜索技能...' : 'Search skills...'}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            sx={{ flex: 1, fontSize: 14 }}
          />
        </Box>
      </Box>

      {categorySections.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8 }}>
          <Typography color="text.secondary" variant="body2">
            {isChineseUi ? '没有找到技能' : 'No skills found'}
          </Typography>
        </Box>
      ) : (
        categorySections.map(({ category, categorySkills }) => (
          <Box key={category} sx={{ mb: 2 }}>
            <Typography
              variant="subtitle1"
              sx={{ fontWeight: 700, mb: 1.5, color: 'text.secondary' }}
            >
              {category}
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 2
              }}
            >
              {categorySkills.map((skill) => {
                const isSelected = selectedSkillId === skill.id
                const label = getCustomSkillName(skill)

                return (
                  <Card
                    key={skill.id}
                    onClick={() => onSelectSkill(isSelected ? null : skill.id)}
                    sx={(theme) => ({
                      position: 'relative',
                      height: 120,
                      cursor: 'pointer',
                      borderRadius: 3,
                      overflow: 'hidden',
                      background: isSelected
                        ? theme.palette.mode === 'dark'
                          ? 'rgba(255,255,255,0.1)'
                          : 'rgba(0,0,0,0.06)'
                        : theme.palette.background.paper,
                      color: theme.palette.text.primary,
                      border: `1px solid ${isSelected ? theme.palette.primary.main : theme.palette.divider}`,
                      boxShadow: isSelected
                        ? `0 0 0 1px ${theme.palette.primary.main}`
                        : theme.palette.mode === 'dark'
                          ? SIDE_SHADOW_DARK
                          : SIDE_SHADOW_LIGHT,
                      transition: 'all .2s ease',
                      '&:hover': {
                        transform: 'translateY(-4px)',
                        boxShadow: `0 8px 16px ${theme.palette.mode === 'dark' ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)'}`
                      }
                    })}
                  >
                    <CardContent
                      sx={{
                        position: 'relative',
                        zIndex: 1,
                        height: '100%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        gap: 0.5,
                        p: 1.5,
                        pb: 1.5
                      }}
                    >
                      <Typography
                        variant="subtitle1"
                        sx={{
                          fontWeight: 700,
                          fontSize: 15,
                          lineHeight: 1.3,
                          overflow: 'hidden',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          whiteSpace: 'normal',
                          color: isSelected ? 'primary.main' : 'text.primary',
                          mb: 'auto'
                        }}
                      >
                        {label}
                      </Typography>
                      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
                        {skill.type === 'agent' ? (
                          <Chip
                            size="small"
                            label="Agent"
                            color={isSelected ? 'primary' : 'default'}
                            sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }}
                          />
                        ) : (
                          <Chip
                            size="small"
                            label="Prompt"
                            variant={isSelected ? 'filled' : 'outlined'}
                            color={isSelected ? 'primary' : 'default'}
                            sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }}
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
                        width: 64,
                        height: 64,
                        pointerEvents: 'none',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        opacity: (theme) => (theme.palette.mode === 'dark' ? 0.1 : 0.05),
                        color: isSelected ? 'primary.main' : 'text.primary'
                      }}
                    >
                      <CustomSkillIcon sx={{ fontSize: 48 }} />
                    </Box>
                  </Card>
                )
              })}
            </Box>
          </Box>
        ))
      )}
    </Box>
  )
}

const MemoizedChatSkillPicker = React.memo(ChatSkillPicker)

MemoizedChatSkillPicker.displayName = 'ChatSkillPicker'

export default MemoizedChatSkillPicker
