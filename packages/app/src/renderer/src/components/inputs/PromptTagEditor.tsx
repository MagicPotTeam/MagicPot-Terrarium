import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Box,
  Chip,
  Typography,
  IconButton,
  TextField,
  Paper,
  Fade,
  Collapse,
  useTheme
} from '@mui/material'
import { useDrag, useDrop } from 'react-dnd'
import CloseIcon from '@mui/icons-material/Close'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'

interface PromptTag {
  id: string
  text: string
  weight: number
  disabled?: boolean
}

interface PromptTagEditorProps {
  value: string
  onChange: (value: string) => void
  droppableId?: string
  storageKey?: string
}

const ITEM_TYPE = 'PROMPT_TAG'
const COLLAPSE_STORAGE_PREFIX = 'promptTagEditor.collapsed.'

const readCollapsedState = (storageKey?: string): boolean => {
  if (!storageKey) return false
  try {
    return localStorage.getItem(`${COLLAPSE_STORAGE_PREFIX}${storageKey}`) === '1'
  } catch {
    return false
  }
}

const writeCollapsedState = (storageKey: string, value: boolean): void => {
  try {
    localStorage.setItem(`${COLLAPSE_STORAGE_PREFIX}${storageKey}`, value ? '1' : '0')
  } catch {
    /* ignore storage failures */
  }
}

interface DraggableTagProps {
  tag: PromptTag
  index: number
  moveTag: (fromIndex: number, toIndex: number) => void
  displayText: string
  isWeighted: boolean
  editingTagId: string | null
  handleTagClick: (e: React.MouseEvent<HTMLElement>, tagId: string) => void
  handleToggleDisabled: (e: React.MouseEvent<HTMLElement>, tagId: string) => void
  handleDeleteTag: (id: string, e: React.MouseEvent) => void
  closeToolbar: () => void
}

const DraggableTag: React.FC<DraggableTagProps> = ({
  tag,
  index,
  moveTag,
  displayText,
  isWeighted,
  editingTagId,
  handleTagClick,
  handleToggleDisabled,
  handleDeleteTag,
  closeToolbar
}) => {
  const ref = useRef<HTMLDivElement>(null)

  const [{ isDragging }, drag] = useDrag(
    () => ({
      type: ITEM_TYPE,
      item: { index },
      collect: (monitor) => ({
        isDragging: monitor.isDragging()
      })
    }),
    [index]
  )

  useEffect(() => {
    if (isDragging) {
      closeToolbar()
    }
  }, [isDragging, closeToolbar])

  const [{ canDrop }, drop] = useDrop(
    () => ({
      accept: ITEM_TYPE,
      canDrop: () => true,
      hover: (item: { index: number }, monitor) => {
        if (!ref.current) return
        const dragIdx = item.index
        const hoverIdx = index

        if (dragIdx === hoverIdx) return

        // 获取鼠标相对于元素的位置
        const hoverBoundingRect = ref.current.getBoundingClientRect()
        const clientOffset = monitor.getClientOffset()
        if (!clientOffset) return

        // 计算鼠标在元素中的位置（横向）
        const hoverClientX = clientOffset.x - hoverBoundingRect.left
        const hoverMiddleX = hoverBoundingRect.width / 2

        // 只有当鼠标明确越过中线时才交换
        if (dragIdx < hoverIdx && hoverClientX < hoverMiddleX) {
          return
        }
        if (dragIdx > hoverIdx && hoverClientX > hoverMiddleX) {
          return
        }

        // 立即交换位置
        moveTag(dragIdx, hoverIdx)
        item.index = hoverIdx
      },
      collect: (monitor) => ({
        canDrop: monitor.canDrop()
      })
    }),
    [index, moveTag]
  )

  drag(drop(ref))

  return (
    <Box
      ref={ref}
      sx={{
        display: 'inline-flex',
        opacity: isDragging ? 0.3 : 1,
        pointerEvents: isDragging ? 'none' : 'auto'
      }}
    >
      <Chip
        label={
          <Typography
            component="span"
            variant="body2"
            sx={{
              textDecoration: tag.disabled ? 'line-through' : 'none',
              opacity: tag.disabled ? 0.5 : 1,
              fontSize: '0.8rem',
              color: isWeighted && tag.weight < 0 ? 'error.main' : 'inherit'
            }}
          >
            {displayText}
          </Typography>
        }
        size="small"
        onClick={(e) => !isDragging && handleTagClick(e, tag.id)}
        onDoubleClick={(e) => handleToggleDisabled(e, tag.id)}
        onDelete={(e) => handleDeleteTag(tag.id, e)}
        deleteIcon={<CloseIcon />}
        sx={{
          cursor: isDragging ? 'grabbing' : 'grab',
          bgcolor: tag.disabled
            ? 'action.disabledBackground'
            : isDragging
              ? 'primary.light'
              : editingTagId === tag.id
                ? 'primary.light'
                : undefined,
          opacity: tag.disabled ? 0.6 : 1,
          '&:hover': {
            bgcolor: tag.disabled ? 'action.hover' : 'primary.light',
            opacity: tag.disabled ? 0.7 : 0.8
          },
          '& .MuiChip-label': {
            px: 1
          },
          pointerEvents: editingTagId && editingTagId !== tag.id ? 'none' : 'auto'
        }}
      />
    </Box>
  )
}

const PromptTagEditor: React.FC<PromptTagEditorProps> = ({ value, onChange, storageKey }) => {
  const splitPromptText = useCallback((text: string): string[] => {
    const result: string[] = []
    let buffer = ''
    let roundDepth = 0
    let squareDepth = 0
    let curlyDepth = 0

    const flushBuffer = () => {
      if (buffer.length === 0) return
      const segments = buffer.split('\n')
      segments.forEach((segment, index) => {
        const trimmedSegment = segment.trim()
        if (trimmedSegment) {
          result.push(trimmedSegment)
        }
        if (index < segments.length - 1) {
          result.push('\n')
        }
      })
      buffer = ''
    }

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i]

      if (ch === '(') {
        roundDepth += 1
      } else if (ch === ')') {
        roundDepth = Math.max(0, roundDepth - 1)
      } else if (ch === '[') {
        squareDepth += 1
      } else if (ch === ']') {
        squareDepth = Math.max(0, squareDepth - 1)
      } else if (ch === '{') {
        curlyDepth += 1
      } else if (ch === '}') {
        curlyDepth = Math.max(0, curlyDepth - 1)
      }

      const isSeparator = ch === ',' || ch === '，'
      const isTopLevel = roundDepth === 0 && squareDepth === 0 && curlyDepth === 0

      if (isSeparator && isTopLevel) {
        flushBuffer()
        continue
      }

      buffer += ch
    }

    flushBuffer()

    return result
  }, [])

  const buildTagString = useCallback((tag: PromptTag, forDisplay: boolean) => {
    if (tag.text === '\n') {
      return forDisplay ? '↵' : '\n'
    }

    let working = tag.text
    let prefix = ''
    let suffix = ''

    while (true) {
      const trimmed = working.trim()
      if (trimmed.length < 2) {
        working = trimmed
        break
      }
      const first = trimmed[0]
      const last = trimmed[trimmed.length - 1]
      if ((first === '(' && last === ')') || (first === '[' && last === ']')) {
        prefix += first
        suffix = last + suffix
        working = trimmed.slice(1, -1)
        continue
      }
      working = trimmed
      break
    }

    const core = working.trim()
    if (!core) {
      return `${prefix}${suffix}`
    }

    const hasWeight = Math.abs(tag.weight - 1.0) >= 0.01
    const main = hasWeight ? `(${core}:${tag.weight.toFixed(2)})` : core

    return `${prefix}${main}${suffix}`
  }, [])

  const formatTagLabel = useCallback(
    (tag: PromptTag) => buildTagString(tag, true),
    [buildTagString]
  )

  const [tags, setTags] = useState<PromptTag[]>([])
  const [editingTagId, setEditingTagId] = useState<string | null>(null)
  const [isCollapsed, setIsCollapsed] = useState<boolean>(() => readCollapsedState(storageKey))
  const [toolbarPosition, setToolbarPosition] = useState<{ top: number; left: number } | null>(null)
  const [operationHint, setOperationHint] = useState<string>('')
  const [hintPosition, setHintPosition] = useState<{ top: number; left: number } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const hintTimerRef = useRef<NodeJS.Timeout | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const theme = useTheme()
  const isDarkMode = theme.palette.mode === 'dark'
  const toolbarBgColor = isDarkMode
    ? theme.palette.background.paper
    : theme.palette.background.default
  const toolbarBorderColor = isDarkMode ? theme.palette.divider : theme.palette.grey[200]
  const hintBgColor = isDarkMode ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255,255,255,0.92)'
  const hintTextColor = isDarkMode ? theme.palette.common.white : theme.palette.text.primary
  const hintBorderColor = isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'

  // 记录上一轮的原始文本，避免重复解析
  const prevValueRef = useRef<string>('')

  const isValidText = useCallback((text: string | undefined | null) => {
    if (text === undefined || text === null) return false
    if (text === '\n') return true
    return text.trim().length > 0
  }, [])

  const sanitizeTags = useCallback(
    (tagList: PromptTag[]): PromptTag[] => {
      return tagList.filter((tag) => isValidText(tag.text))
    },
    [isValidText]
  )

  // 解析提示词文本为标签
  useEffect(() => {
    setIsCollapsed(readCollapsedState(storageKey))
  }, [storageKey])

  useEffect(() => {
    if (!storageKey) return
    writeCollapsedState(storageKey, isCollapsed)
  }, [isCollapsed, storageKey])

  useEffect(() => {
    if (!value) {
      prevValueRef.current = value
      setTags((prevTags) => sanitizeTags(prevTags.filter((t) => t.disabled)))
      return
    }

    setTags((prevTags) => {
      const sanitizedPrevTags = sanitizeTags(prevTags)

      if (prevValueRef.current === value) {
        return sanitizedPrevTags
      }

      prevValueRef.current = value

      const prevTagBuckets = new Map<string, PromptTag[]>()
      sanitizedPrevTags.forEach((tag) => {
        const list = prevTagBuckets.get(tag.text)
        if (list) {
          list.push(tag)
        } else {
          prevTagBuckets.set(tag.text, [tag])
        }
      })

      const occurrenceTracker = new Map<string, number>()
      const parsedTags: PromptTag[] = []

      splitPromptText(value).forEach((item, index) => {
        let parsedText = item
        let parsedWeight = 1.0

        if (item === '\n') {
          parsedText = '\n'
        } else {
          const trimmed = item.trim()
          if (!trimmed) {
            return
          }

          parsedText = trimmed

          const colonMatch = trimmed.match(/^\((.+?):([-\d.]+)\)$/)
          if (colonMatch) {
            parsedText = colonMatch[1].trim()
            parsedWeight = parseFloat(colonMatch[2])
          } else {
            const noColonMatch = trimmed.match(/^\((.+?)\s*([-+]?\d+\.?\d*)\)$/)
            if (noColonMatch && noColonMatch[2]) {
              parsedText = noColonMatch[1].trim()
              parsedWeight = parseFloat(noColonMatch[2])
            }
          }
        }

        const text = parsedText === '\n' ? '\n' : parsedText.trim()
        if (!isValidText(text)) {
          return
        }

        const weight = parsedWeight

        const occurrenceIndex = occurrenceTracker.get(text) ?? 0
        occurrenceTracker.set(text, occurrenceIndex + 1)

        const candidates = prevTagBuckets.get(text)
        const oldTag = candidates && candidates[occurrenceIndex]
        const disabled = oldTag?.disabled ?? false

        let id = oldTag?.id
        if (!id) {
          const safeText = text === '\n' ? 'newline' : text.replace(/[^a-zA-Z0-9]/g, '')
          const randomSuffix = Math.random().toString(36).slice(2, 8)
          id = `tag-${safeText || 'blank'}-${Date.now()}-${occurrenceIndex}-${index}-${randomSuffix}`
        }

        parsedTags.push({
          id,
          text,
          weight,
          disabled
        })
      })

      // 保留所有禁用的标签（即使它们不在新文本中）
      const disabledTags = sanitizedPrevTags.filter((t) => t.disabled && isValidText(t.text))
      const allTags = [...parsedTags]

      // 将禁用的标签添加回去（如果不在新列表中）
      disabledTags.forEach((disabledTag) => {
        const exists = parsedTags.some((t) => t.text === disabledTag.text)
        if (!exists) {
          allTags.push(disabledTag)
        }
      })

      const cleanedTags = sanitizeTags(allTags)

      const isSame =
        sanitizedPrevTags.length === cleanedTags.length &&
        sanitizedPrevTags.every((tag, index) => {
          const nextTag = cleanedTags[index]
          return (
            tag &&
            nextTag &&
            tag.id === nextTag.id &&
            tag.text === nextTag.text &&
            tag.weight === nextTag.weight &&
            tag.disabled === nextTag.disabled
          )
        })

      return isSame ? sanitizedPrevTags : cleanedTags
    })
  }, [value, splitPromptText, sanitizeTags, isValidText])

  // 将标签转换回提示词文本
  // 禁用的标签不输出到提示词文本
  const tagsToPrompt = useCallback(
    (tagList: PromptTag[]): string => {
      const tokens = sanitizeTags(tagList)
        .filter((tag) => !tag.disabled)
        .map((tag) => {
          if (tag.text === '\n') {
            return '\n'
          }
          if (Math.abs(tag.weight - 1.0) < 0.01) {
            return tag.text
          }
          return `(${tag.text}:${tag.weight.toFixed(2)})`
        })
        .filter((token) => token !== '')

      let result = ''
      let needComma = false

      tokens.forEach((token) => {
        if (token === '\n') {
          result += '\n'
          needComma = false
        } else {
          if (needComma) {
            result += ', '
          }
          result += token
          needComma = true
        }
      })

      return result
    },
    [sanitizeTags]
  )

  // 更新标签并同步到文本
  const updateTags = (newTags: PromptTag[]) => {
    const cleaned = sanitizeTags(newTags)
    setTags(cleaned)
    onChange(tagsToPrompt(cleaned))
  }

  // 删除标签
  const handleDeleteTag = (id: string, event: React.MouseEvent) => {
    event.stopPropagation()
    const newTags = tags.filter((tag) => tag.id !== id)
    updateTags(newTags)
    setEditingTagId(null)
    setToolbarPosition(null)
    setHintPosition(null)
  }

  // 显示操作提示
  const showOperationHint = (hint: string, position?: { top: number; left: number }) => {
    console.log('显示操作提示:', hint) // 调试日志
    setOperationHint(hint)
    if (position) {
      setHintPosition(position)
    } else if (toolbarPosition && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      setHintPosition({
        top: rect.top + toolbarPosition.top,
        left: rect.left + toolbarPosition.left + 120
      })
    } else {
      setHintPosition(null)
    }

    // 清除之前的定时器
    if (hintTimerRef.current) {
      clearTimeout(hintTimerRef.current)
    }

    // 1.5秒后隐藏提示
    hintTimerRef.current = setTimeout(() => {
      setOperationHint('')
      setHintPosition(null)
    }, 1500)
  }

  // 更新标签权重
  const handleWeightChange = (id: string, newWeight: number) => {
    const newTags = tags.map((tag) => (tag.id === id ? { ...tag, weight: newWeight } : tag))
    updateTags(newTags)
  }

  // 增加权重
  const handleIncreaseWeight = (id: string) => {
    const tag = tags.find((t) => t.id === id)
    if (!tag) return
    const oldWeight = tag.weight
    const newWeight = Math.min(5.0, tag.weight + 0.1)
    const diff = (newWeight - oldWeight).toFixed(1)
    showOperationHint(`增加关键词权重：增加${diff}`)
    handleWeightChange(id, newWeight)
  }

  // 减少权重
  const handleDecreaseWeight = (id: string) => {
    const tag = tags.find((t) => t.id === id)
    if (!tag) return
    const oldWeight = tag.weight
    const newWeight = Math.max(-2.0, tag.weight - 0.1)
    const diff = (oldWeight - newWeight).toFixed(1)
    showOperationHint(`减弱关键词权重：减少${diff}`)
    handleWeightChange(id, newWeight)
  }

  const handleSetWeight = (value: number) => {
    if (!editingTagId) return
    const tag = tags.find((t) => t.id === editingTagId)
    if (!tag) return
    const clamped = Math.max(-2.0, Math.min(5.0, value))
    showOperationHint(`重置关键词权重 → ${clamped.toFixed(2)}`)
    handleWeightChange(editingTagId, clamped)
  }

  const handleMultiplyWeight = (factor: number, label: string) => {
    if (!editingTagId) return
    const tag = tags.find((t) => t.id === editingTagId)
    if (!tag) return
    const newWeight = Math.max(-2.0, Math.min(5.0, tag.weight * factor))
    showOperationHint(`${label} → ${newWeight.toFixed(2)}`)
    handleWeightChange(editingTagId, newWeight)
  }

  const handleCopyWeight = async () => {
    if (!editingTagId) return
    const tag = tags.find((t) => t.id === editingTagId)
    if (!tag) return
    try {
      await navigator.clipboard.writeText(tag.weight.toFixed(2))
      showOperationHint(`已复制权重 ${tag.weight.toFixed(2)}`)
    } catch (err) {
      console.error('复制失败:', err)
      showOperationHint('复制失败，请稍后再试')
    }
  }

  const handleCopyNode = async () => {
    if (!editingTagId) return
    const tag = tags.find((t) => t.id === editingTagId)
    if (!tag) return

    try {
      const displayLabel = tag.text === '\n' ? '\n' : formatTagLabel(tag)
      await navigator.clipboard.writeText(displayLabel)
      showOperationHint('已复制标签内容')
    } catch (error) {
      console.error('复制失败', error)
      showOperationHint('复制失败，请稍后再试')
    }
  }

  const applyTextTransform = (
    transform: (text: string) => string,
    hint: string,
    hintIfNoChange?: string,
    postProcess?: (updatedTag: PromptTag, originalTag: PromptTag) => PromptTag
  ) => {
    if (!editingTagId) return
    const tag = tags.find((t) => t.id === editingTagId)
    if (!tag) return
    const transformedText = transform(tag.text)
    let updatedTag: PromptTag = {
      ...tag,
      text: transformedText
    }

    if (postProcess) {
      updatedTag = postProcess(updatedTag, tag)
    }

    const hasChange =
      updatedTag.text !== tag.text ||
      updatedTag.weight !== tag.weight ||
      updatedTag.disabled !== tag.disabled

    if (!hasChange) {
      if (hintIfNoChange) {
        showOperationHint(hintIfNoChange)
      }
      return
    }

    const newTags = tags.map((t) => (t.id === editingTagId ? updatedTag : t))
    updateTags(newTags)
    showOperationHint(hint)
  }

  const stripAllWrappersOfType = (text: string, opener: string, closer: string): string => {
    let result = text.trim()
    while (result.startsWith(opener) && result.endsWith(closer)) {
      result = result.slice(1, -1).trim()
    }
    return result
  }

  const stripSingleWrapperOfType = (text: string, opener: string, closer: string): string => {
    const trimmed = text.trim()
    if (trimmed.startsWith(opener) && trimmed.endsWith(closer)) {
      return trimmed.slice(1, -1).trim()
    }
    return trimmed
  }

  const handleAddParentheses = () =>
    applyTextTransform((text) => {
      const withoutBrackets = stripAllWrappersOfType(text, '[', ']')
      const trimmed = withoutBrackets.trim()
      if (!trimmed) {
        return trimmed
      }
      return `(${trimmed})`
    }, '添加括号 ()')

  const handleRemoveParentheses = () =>
    applyTextTransform(
      (text) => stripSingleWrapperOfType(text, '(', ')'),
      '移除括号 ()',
      '未找到括号'
    )

  const handleAddBrackets = () =>
    applyTextTransform(
      (text) => {
        const withoutParentheses = stripAllWrappersOfType(text, '(', ')')
        const trimmed = withoutParentheses.trim()
        if (!trimmed) {
          return trimmed
        }
        return `[${trimmed}]`
      },
      '添加中括号 []',
      undefined,
      (updatedTag) => ({
        ...updatedTag,
        weight: 1.0
      })
    )

  const handleRemoveBrackets = () =>
    applyTextTransform(
      (text) => stripSingleWrapperOfType(text, '[', ']'),
      '移除中括号 []',
      '未找到中括号'
    )

  const handleInsertNewline = () => {
    if (!editingTagId) return
    const index = tags.findIndex((t) => t.id === editingTagId)
    if (index === -1) return

    const newTag: PromptTag = {
      id: `tag-newline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: '\n',
      weight: 1.0
    }

    const newTags = [...tags]
    newTags.splice(index + 1, 0, newTag)
    updateTags(newTags)

    showOperationHint('插入换行符')
  }

  // 拖拽移动标签
  const moveTag = useCallback(
    (fromIndex: number, toIndex: number) => {
      setTags((prevTags) => {
        const newTags = [...prevTags]
        const [movedTag] = newTags.splice(fromIndex, 1)
        newTags.splice(toIndex, 0, movedTag)
        onChange(tagsToPrompt(newTags))
        return newTags
      })
    },
    [onChange, tagsToPrompt]
  )

  // 关闭工具栏
  const closeToolbar = useCallback(() => {
    setEditingTagId(null)
    setToolbarPosition(null)
    setHintPosition(null)
  }, [])

  const handleToggleCollapsed = useCallback(() => {
    if (!isCollapsed) {
      closeToolbar()
      setOperationHint('')
      setHintPosition(null)
    }
    setIsCollapsed((prev) => !prev)
  }, [closeToolbar, isCollapsed])

  const toggleDisabledState = (tagId: string) => {
    const tag = tags.find((t) => t.id === tagId)
    if (!tag) return

    const newTags = tags.map((t) => (t.id === tagId ? { ...t, disabled: !t.disabled } : t))
    updateTags(newTags)

    // 显示操作提示
    if (tag.disabled) {
      showOperationHint('启用关键词')
    } else {
      showOperationHint('禁用关键词')
    }

    // 关闭工具栏（如果打开着）
    setEditingTagId(null)
    setToolbarPosition(null)
    setHintPosition(null)
  }

  // 双击切换禁用/启用状态
  const handleToggleDisabled = (event: React.MouseEvent<HTMLElement>, tagId: string) => {
    event.preventDefault()
    event.stopPropagation()
    toggleDisabledState(tagId)
  }

  // 使用延迟来区分单击和双击
  const clickTimerRef = useRef<NodeJS.Timeout | null>(null)
  const hideToolbarTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 鼠标悬停显示工具栏
  const clearHideToolbarTimer = () => {
    if (hideToolbarTimerRef.current) {
      clearTimeout(hideToolbarTimerRef.current)
      hideToolbarTimerRef.current = null
    }
  }

  const updateToolbarByTarget = (target: HTMLElement, tagId: string) => {
    const targetRect = target.getBoundingClientRect()
    const toolbarWidth = toolbarRef.current?.offsetWidth ?? 260
    const toolbarHeight = toolbarRef.current?.offsetHeight ?? 56
    const padding = 8

    let top = targetRect.top - toolbarHeight - padding
    if (top < padding) {
      top = padding
    }

    let left = targetRect.left
    if (left < padding) {
      left = padding
    }
    const viewportWidth = window.innerWidth
    if (left + toolbarWidth > viewportWidth - padding) {
      left = viewportWidth - toolbarWidth - padding
    }
    left = Math.max(padding, left)

    if (
      editingTagId === tagId &&
      toolbarPosition &&
      Math.abs(toolbarPosition.top - top) < 0.5 &&
      Math.abs(toolbarPosition.left - left) < 0.5
    ) {
      return
    }

    setToolbarPosition({ top, left })
    setEditingTagId(tagId)
  }

  // 点击标签显示/隐藏工具栏
  const handleTagClick = (event: React.MouseEvent<HTMLElement>, tagId: string) => {
    event.stopPropagation()

    // 如果点击的是当前已选中的标签，则关闭工具栏
    if (editingTagId === tagId) {
      setEditingTagId(null)
      setToolbarPosition(null)
      setHintPosition(null)
      return
    }

    // 清除隐藏定时器
    clearHideToolbarTimer()

    const target = event.currentTarget as HTMLElement
    updateToolbarByTarget(target, tagId)
  }

  // 关闭工具栏（点击外部）
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        editingTagId &&
        containerRef.current &&
        !containerRef.current.contains(event.target as Node) &&
        (!toolbarRef.current || !toolbarRef.current.contains(event.target as Node))
      ) {
        setEditingTagId(null)
        setToolbarPosition(null)
        setHintPosition(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [editingTagId])

  // 清理定时器
  useEffect(() => {
    const clickTimer = clickTimerRef.current
    const hintTimer = hintTimerRef.current
    const hideToolbarTimer = hideToolbarTimerRef.current

    return () => {
      if (clickTimer) {
        clearTimeout(clickTimer)
      }
      if (hintTimer) {
        clearTimeout(hintTimer)
      }
      if (hideToolbarTimer) {
        clearTimeout(hideToolbarTimer)
      }
    }
  }, [])

  const hasTags = tags.length > 0
  const hasPromptValue = typeof value === 'string' && value.trim().length > 0
  const visibleTagCount = tags.filter((tag) => tag.text !== '\n').length

  if (!hasPromptValue) {
    return null
  }
  const editingTag = tags.find((t) => t.id === editingTagId)

  return (
    <Box
      sx={{ mt: 1, position: 'relative', width: '100%', maxWidth: '100%', overflow: 'hidden' }}
      ref={containerRef}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 1,
          px: 0.25,
          mb: 0.75
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
          {`Tags${visibleTagCount > 0 ? ` (${visibleTagCount})` : ''}`}
        </Typography>
        <IconButton
          size="small"
          onClick={handleToggleCollapsed}
          aria-label={isCollapsed ? 'Expand tags' : 'Collapse tags'}
          sx={{ p: 0.25 }}
        >
          {isCollapsed ? <ExpandMoreIcon fontSize="small" /> : <ExpandLessIcon fontSize="small" />}
        </IconButton>
      </Box>

      <Collapse in={!isCollapsed} timeout={160} unmountOnExit>
        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 0.5,
            p: 1,
            bgcolor: 'background.paper',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            position: 'relative',
            overflow: 'hidden',
            minHeight: 40,
            alignItems: hasTags ? 'flex-start' : 'center'
          }}
        >
          {hasTags &&
            tags.map((tag, index) => {
              const displayText = formatTagLabel(tag)
              const isWeighted = Math.abs(tag.weight - 1.0) >= 0.01

              return (
                <DraggableTag
                  key={tag.id}
                  tag={tag}
                  index={index}
                  moveTag={moveTag}
                  displayText={displayText}
                  isWeighted={isWeighted}
                  editingTagId={editingTagId}
                  handleTagClick={handleTagClick}
                  handleToggleDisabled={handleToggleDisabled}
                  handleDeleteTag={handleDeleteTag}
                  closeToolbar={closeToolbar}
                />
              )
            })}
        </Box>

        {/* 内联工具栏 */}
        <Fade in={Boolean(editingTagId && toolbarPosition)}>
          <Paper
            ref={toolbarRef}
            sx={{
              position: 'fixed',
              top: toolbarPosition?.top ?? -9999,
              left: toolbarPosition?.left ?? -9999,
              display: 'flex',
              alignItems: 'center',
              gap: 0.25,
              px: 0.75,
              py: 0.6,
              borderRadius: 2,
              boxShadow: 6,
              bgcolor: toolbarBgColor,
              color: theme.palette.text.primary,
              border: `1px solid ${toolbarBorderColor}`,
              zIndex: 1300
            }}
          >
            <IconButton
              size="small"
              onClick={() => editingTagId && handleDecreaseWeight(editingTagId)}
              sx={{ width: 32, height: 32 }}
            >
              <RemoveIcon fontSize="small" />
            </IconButton>

            <TextField
              value={editingTag?.weight.toFixed(2) || '1.00'}
              onChange={(e) => {
                const newWeight = parseFloat(e.target.value)
                if (!isNaN(newWeight) && editingTagId) {
                  handleWeightChange(editingTagId, Math.max(-2.0, Math.min(5.0, newWeight)))
                }
              }}
              size="small"
              variant="outlined"
              sx={{
                width: 60,
                '& .MuiOutlinedInput-input': {
                  textAlign: 'center',
                  fontSize: '0.85rem',
                  py: 0.6
                }
              }}
            />

            <IconButton
              size="small"
              onClick={() => editingTagId && handleIncreaseWeight(editingTagId)}
              sx={{ width: 32, height: 32 }}
            >
              <AddIcon fontSize="small" />
            </IconButton>

            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.1,
                ml: 0.5
              }}
            >
              {[
                { label: '+()', handler: handleAddParentheses },
                { label: '-()', handler: handleRemoveParentheses },
                { label: '+[]', handler: handleAddBrackets },
                { label: '-[]', handler: handleRemoveBrackets },
                { label: 'NL', handler: handleInsertNewline }
              ].map(({ label, handler }) => {
                const isBracketControl = label !== '↵'
                return (
                  <Chip
                    key={label}
                    label={label}
                    size="small"
                    onClick={handler}
                    sx={{
                      fontSize: isBracketControl ? '0.8rem' : '0.68rem',
                      fontWeight: isBracketControl ? 700 : 500,
                      height: 24,
                      px: 0.5,
                      cursor: 'pointer'
                    }}
                  />
                )
              })}

              <Chip
                label="复制"
                size="small"
                onClick={(e) => {
                  if (e.shiftKey) {
                    handleCopyWeight()
                  } else {
                    handleCopyNode()
                  }
                }}
                sx={{
                  fontSize: '0.66rem',
                  height: 24,
                  px: 0.5,
                  cursor: 'pointer',
                  ml: 0.3
                }}
              />

              <Chip
                label={editingTag?.disabled ? '启用' : '禁用'}
                size="small"
                color={editingTag?.disabled ? 'primary' : 'default'}
                onClick={() => editingTagId && toggleDisabledState(editingTagId)}
                sx={{
                  fontSize: '0.66rem',
                  height: 24,
                  px: 0.5,
                  cursor: 'pointer',
                  ml: 0.25
                }}
              />
            </Box>
          </Paper>
        </Fade>

        {/* 操作提示浮层 */}
        <Fade in={Boolean(operationHint)}>
          <Box
            sx={{
              position: 'fixed',
              top: hintPosition ? hintPosition.top : '50%',
              left: hintPosition ? hintPosition.left : '50%',
              transform: hintPosition ? 'translate(-50%, -120%)' : 'translate(-50%, -50%)',
              bgcolor: hintBgColor,
              color: hintTextColor,
              px: 2,
              py: 0.75,
              borderRadius: 1,
              zIndex: 1200,
              fontSize: '0.85rem',
              fontWeight: 500,
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              boxShadow: 3,
              border: `1px solid ${hintBorderColor}`,
              maxWidth: '240px'
            }}
          >
            {operationHint}
          </Box>
        </Fade>
      </Collapse>
    </Box>
  )
}

export default PromptTagEditor
