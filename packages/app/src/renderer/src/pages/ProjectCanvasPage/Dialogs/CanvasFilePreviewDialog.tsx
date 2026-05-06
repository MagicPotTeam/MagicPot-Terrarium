import React from 'react'
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography
} from '@mui/material'
import { useTranslation } from 'react-i18next'
import { buildFileMetaLine } from '@renderer/utils/fileMetadata'
import { getCanvasFileExportOptions, type CanvasFileExportFormat } from '../canvasFileExportUtils'
import type { CanvasFileItem, CanvasFilePreviewSheet } from '../types'
import { getCanvasFilePreviewCopy } from '../projectCanvasPageUiCopy'
import { CANVAS_OCR_HOVER_EVENT, type CanvasOcrHoverDetail } from '../ocrCanvasUtils'
import { isEditableSpreadsheetCanvasFile } from '../types'
import {
  insertCanvasPreviewSheetColumn,
  insertCanvasPreviewSheetRow,
  removeCanvasPreviewSheetColumn,
  removeCanvasPreviewSheetRow,
  updateCanvasPreviewSheetCell
} from '../officePreviewUtils'

type CanvasFilePreviewDialogProps = {
  item: CanvasFileItem | null
  open: boolean
  draftContent: string
  draftSheets: CanvasFilePreviewSheet[]
  activeOcrHover: CanvasOcrHoverDetail | null
  onDraftChange: (value: string) => void
  onDraftSheetsChange: (value: CanvasFilePreviewSheet[]) => void
  onClose: () => void
  onSave: () => void
  onExport?: (item: CanvasFileItem, format?: CanvasFileExportFormat) => void
}

type SpreadsheetCellSelection = {
  sheetIndex: number
  row: number
  col: number
}

const PREVIEW_TEXT_FIELD_FONT =
  '"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, monospace'
const SPREADSHEET_MAX_PREVIEW_ROWS = 24
const SPREADSHEET_MAX_PREVIEW_COLS = 12
const SPREADSHEET_EMPTY_PREVIEW_ROWS = 8
const SPREADSHEET_EMPTY_PREVIEW_COLS = 6

const toSpreadsheetColumnLabel = (col: number): string => {
  let label = ''
  let current = col

  while (current > 0) {
    const remainder = (current - 1) % 26
    label = String.fromCharCode(65 + remainder) + label
    current = Math.floor((current - 1) / 26)
  }

  return label || 'A'
}

type SpreadsheetPreviewTableProps = {
  item: CanvasFileItem
  sheets: CanvasFilePreviewSheet[]
  editable: boolean
  activeSheetIndex: number
  activeCell: SpreadsheetCellSelection | null
  activeOcrHover: CanvasOcrHoverDetail | null
  onActiveSheetChange: (index: number) => void
  onCellSelect: (sheetIndex: number, row: number, col: number) => void
  onCellChange: (sheetIndex: number, row: number, col: number, value: string) => void
  uiCopy: ReturnType<typeof getCanvasFilePreviewCopy>
}

function SpreadsheetPreviewTable({
  item,
  sheets,
  editable,
  activeSheetIndex,
  activeCell,
  activeOcrHover,
  onActiveSheetChange,
  onCellSelect,
  onCellChange,
  uiCopy
}: SpreadsheetPreviewTableProps) {
  const previewSheets = sheets
  const activeSheet = previewSheets[activeSheetIndex] || previewSheets[0] || null

  const renderedRowCount = Math.min(
    Math.max(
      activeSheet?.rows || 0,
      editable
        ? SPREADSHEET_EMPTY_PREVIEW_ROWS
        : activeSheet?.cells.length === 0
          ? SPREADSHEET_EMPTY_PREVIEW_ROWS
          : 1
    ),
    SPREADSHEET_MAX_PREVIEW_ROWS
  )
  const renderedColCount = Math.min(
    Math.max(
      activeSheet?.cols || 0,
      editable
        ? SPREADSHEET_EMPTY_PREVIEW_COLS
        : activeSheet?.cells.length === 0
          ? SPREADSHEET_EMPTY_PREVIEW_COLS
          : 1
    ),
    SPREADSHEET_MAX_PREVIEW_COLS
  )
  const totalRows = activeSheet?.rows || (activeSheet?.cells.length === 0 ? 1 : renderedRowCount)
  const totalCols = activeSheet?.cols || (activeSheet?.cells.length === 0 ? 1 : renderedColCount)
  const rowNumbers = Array.from({ length: renderedRowCount }, (_, index) => index + 1)
  const columnNumbers = Array.from({ length: renderedColCount }, (_, index) => index + 1)
  const showTruncatedHint = totalRows > renderedRowCount || totalCols > renderedColCount
  const dispatchHover = React.useCallback((detail: CanvasOcrHoverDetail) => {
    window.dispatchEvent(new CustomEvent(CANVAS_OCR_HOVER_EVENT, { detail }))
  }, [])

  const clearHover = React.useCallback(() => {
    if (!item.ocrBundleId) {
      return
    }

    dispatchHover({
      bundleId: item.ocrBundleId,
      bboxIds: [],
      cellIds: []
    })
  }, [dispatchHover, item.ocrBundleId])

  React.useEffect(() => {
    return () => {
      clearHover()
    }
  }, [clearHover])

  if (!activeSheet) {
    return null
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
      {previewSheets.length > 1 ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {previewSheets.map((sheet, index) => (
            <Button
              key={sheet.id || `${sheet.name}-${index + 1}`}
              size="small"
              variant={index === activeSheetIndex ? 'contained' : 'outlined'}
              onClick={() => onActiveSheetChange(index)}
            >
              {sheet.name}
            </Button>
          ))}
        </Box>
      ) : null}

      <Box
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: 2,
          overflow: 'hidden'
        }}
      >
        <Box
          sx={{
            px: 1.5,
            py: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 1,
            bgcolor: 'action.hover',
            borderBottom: '1px solid',
            borderColor: 'divider'
          }}
        >
          <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
            {activeSheet.name}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {uiCopy.spreadsheetSheetSummary(totalRows, totalCols)}
          </Typography>
        </Box>

        <TableContainer sx={{ maxHeight: 420 }} onPointerLeave={clearHover}>
          <Table stickyHeader size="small" aria-label={activeSheet.name}>
            <TableHead>
              <TableRow>
                <TableCell
                  sx={{
                    minWidth: 56,
                    bgcolor: 'background.paper',
                    fontWeight: 700
                  }}
                >
                  {uiCopy.spreadsheetRowHeader}
                </TableCell>
                {columnNumbers.map((columnNumber) => (
                  <TableCell
                    key={columnNumber}
                    sx={{
                      minWidth: 120,
                      bgcolor: 'background.paper',
                      fontWeight: 700
                    }}
                  >
                    {toSpreadsheetColumnLabel(columnNumber)}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rowNumbers.map((rowNumber) => (
                <TableRow key={rowNumber}>
                  <TableCell
                    component="th"
                    scope="row"
                    sx={{
                      bgcolor: 'action.hover',
                      color: 'text.secondary',
                      fontWeight: 700
                    }}
                  >
                    {rowNumber}
                  </TableCell>
                  {columnNumbers.map((columnNumber) => {
                    const cell = activeSheet.cells.find(
                      (entry) => entry.row === rowNumber && entry.col === columnNumber
                    )
                    const activeCellId = cell?.ocrCellId
                    const isSelected =
                      editable &&
                      activeCell?.sheetIndex === activeSheetIndex &&
                      activeCell.row === rowNumber &&
                      activeCell.col === columnNumber
                    const isActive = Boolean(
                      item.ocrBundleId &&
                      activeCellId &&
                      activeOcrHover &&
                      activeOcrHover.bundleId === item.ocrBundleId &&
                      activeOcrHover.cellIds.includes(activeCellId)
                    )

                    return (
                      <TableCell
                        key={`${rowNumber}-${columnNumber}`}
                        data-ocr-cell-id={cell?.ocrCellId}
                        data-ocr-bbox-ids={cell?.ocrBboxIds?.join(',')}
                        data-ocr-active={isActive ? 'true' : 'false'}
                        data-spreadsheet-selected={isSelected ? 'true' : 'false'}
                        onPointerOver={() => {
                          if (!item.ocrBundleId || !cell?.ocrCellId) {
                            return
                          }

                          dispatchHover({
                            bundleId: item.ocrBundleId,
                            bboxIds: cell.ocrBboxIds || [],
                            cellIds: [cell.ocrCellId]
                          })
                        }}
                        sx={{
                          verticalAlign: 'top',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                          backgroundColor: isActive ? 'rgba(254, 249, 195, 0.92)' : undefined,
                          boxShadow: isActive
                            ? 'inset 0 0 0 1px rgba(202, 138, 4, 0.75)'
                            : isSelected
                              ? 'inset 0 0 0 1px rgba(37, 99, 235, 0.92)'
                              : undefined,
                          transition: 'background-color 0.16s ease, box-shadow 0.16s ease'
                        }}
                      >
                        {editable ? (
                          <TextField
                            fullWidth
                            multiline
                            variant="standard"
                            value={cell?.text || ''}
                            onFocus={() => onCellSelect(activeSheetIndex, rowNumber, columnNumber)}
                            onClick={() => onCellSelect(activeSheetIndex, rowNumber, columnNumber)}
                            onChange={(event) =>
                              onCellChange(
                                activeSheetIndex,
                                rowNumber,
                                columnNumber,
                                event.target.value
                              )
                            }
                            InputProps={{
                              disableUnderline: true,
                              sx: {
                                alignItems: 'flex-start',
                                fontSize: 13,
                                lineHeight: 1.45,
                                py: 0.25
                              }
                            }}
                          />
                        ) : (
                          cell?.text || ''
                        )}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>

      {activeSheet.cells.length === 0 && !editable ? (
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {uiCopy.spreadsheetEmptySheetTip}
        </Typography>
      ) : null}

      {showTruncatedHint ? (
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {uiCopy.spreadsheetTruncatedHint(
            renderedRowCount,
            renderedColCount,
            totalRows,
            totalCols
          )}
        </Typography>
      ) : null}
    </Box>
  )
}

export default function CanvasFilePreviewDialog({
  item,
  open,
  draftContent,
  draftSheets,
  activeOcrHover,
  onDraftChange,
  onDraftSheetsChange,
  onClose,
  onSave,
  onExport
}: CanvasFilePreviewDialogProps) {
  const { i18n } = useTranslation()
  const uiCopy = getCanvasFilePreviewCopy(i18n.resolvedLanguage || i18n.language)
  const [exportMenuAnchor, setExportMenuAnchor] = React.useState<HTMLElement | null>(null)
  const spreadsheetEditable = Boolean(item && isEditableSpreadsheetCanvasFile(item.fileName))
  const previewText =
    item?.editable && !spreadsheetEditable ? draftContent : item?.previewText || item?.content || ''
  const previewImages = item?.previewImages || []
  const previewSheets = React.useMemo(
    () => (spreadsheetEditable ? draftSheets : item?.previewSheets || []),
    [draftSheets, item?.previewSheets, spreadsheetEditable]
  )
  const [activeSheetIndex, setActiveSheetIndex] = React.useState(0)
  const [activeSpreadsheetCell, setActiveSpreadsheetCell] =
    React.useState<SpreadsheetCellSelection | null>(null)
  const showSpreadsheetPreview =
    previewSheets.length > 0 && (!item?.editable || spreadsheetEditable)
  const showEmptyTip =
    !item?.editable && !showSpreadsheetPreview && !previewText && previewImages.length === 0
  const activeSheet = previewSheets[activeSheetIndex] || previewSheets[0] || null
  const selectedCellForActiveSheet =
    activeSpreadsheetCell?.sheetIndex === activeSheetIndex ? activeSpreadsheetCell : null
  const selectedCellLabel = selectedCellForActiveSheet
    ? `${toSpreadsheetColumnLabel(selectedCellForActiveSheet.col)}${selectedCellForActiveSheet.row}`
    : null
  const metaText = item
    ? buildFileMetaLine({
        fileName: item.fileName,
        mimeType: item.mimeType,
        sizeBytes: item.sizeBytes,
        editable: Boolean(item.editable || spreadsheetEditable)
      })
    : ''
  const exportOptions = React.useMemo(
    () => (item ? getCanvasFileExportOptions(item, i18n.resolvedLanguage || i18n.language) : []),
    [i18n.language, i18n.resolvedLanguage, item]
  )

  const handleSpreadsheetCellChange = (
    sheetIndex: number,
    row: number,
    col: number,
    value: string
  ) => {
    onDraftSheetsChange(
      previewSheets.map((sheet, index) =>
        index === sheetIndex ? updateCanvasPreviewSheetCell(sheet, row, col, value) : sheet
      )
    )
  }

  const handleActiveSheetTransform = (
    transform: (sheet: CanvasFilePreviewSheet) => CanvasFilePreviewSheet,
    nextCell: SpreadsheetCellSelection
  ) => {
    onDraftSheetsChange(
      previewSheets.map((sheet, index) => (index === activeSheetIndex ? transform(sheet) : sheet))
    )
    setActiveSpreadsheetCell(nextCell)
  }

  const handleAddSpreadsheetRow = () => {
    if (!activeSheet) return
    const anchorRow = selectedCellForActiveSheet?.row || activeSheet.rows || 1
    handleActiveSheetTransform((sheet) => insertCanvasPreviewSheetRow(sheet, anchorRow), {
      sheetIndex: activeSheetIndex,
      row: Math.min(anchorRow + 1, Math.max(activeSheet.rows + 1, 1)),
      col: selectedCellForActiveSheet?.col || 1
    })
  }

  const handleDeleteSpreadsheetRow = () => {
    if (!activeSheet) return
    const targetRow = selectedCellForActiveSheet?.row || activeSheet.rows || 1
    const nextSheet = removeCanvasPreviewSheetRow(activeSheet, targetRow)
    handleActiveSheetTransform(() => nextSheet, {
      sheetIndex: activeSheetIndex,
      row: Math.min(targetRow, nextSheet.rows),
      col: Math.min(selectedCellForActiveSheet?.col || 1, nextSheet.cols)
    })
  }

  const handleAddSpreadsheetColumn = () => {
    if (!activeSheet) return
    const anchorCol = selectedCellForActiveSheet?.col || activeSheet.cols || 1
    handleActiveSheetTransform((sheet) => insertCanvasPreviewSheetColumn(sheet, anchorCol), {
      sheetIndex: activeSheetIndex,
      row: selectedCellForActiveSheet?.row || 1,
      col: Math.min(anchorCol + 1, Math.max(activeSheet.cols + 1, 1))
    })
  }

  const handleDeleteSpreadsheetColumn = () => {
    if (!activeSheet) return
    const targetCol = selectedCellForActiveSheet?.col || activeSheet.cols || 1
    const nextSheet = removeCanvasPreviewSheetColumn(activeSheet, targetCol)
    handleActiveSheetTransform(() => nextSheet, {
      sheetIndex: activeSheetIndex,
      row: Math.min(selectedCellForActiveSheet?.row || 1, nextSheet.rows),
      col: Math.min(targetCol, nextSheet.cols)
    })
  }

  React.useEffect(() => {
    setActiveSheetIndex(0)
    setActiveSpreadsheetCell(
      spreadsheetEditable && previewSheets.length > 0
        ? {
            sheetIndex: 0,
            row: 1,
            col: 1
          }
        : null
    )
  }, [item?.id, previewSheets.length, spreadsheetEditable])

  React.useEffect(() => {
    if (previewSheets.length === 0) {
      if (activeSheetIndex !== 0) {
        setActiveSheetIndex(0)
      }
      return
    }

    if (activeSheetIndex >= previewSheets.length) {
      setActiveSheetIndex(previewSheets.length - 1)
    }
  }, [activeSheetIndex, previewSheets.length])

  React.useEffect(() => {
    if (!spreadsheetEditable || previewSheets.length === 0) {
      if (activeSpreadsheetCell !== null) {
        setActiveSpreadsheetCell(null)
      }
      return
    }

    const currentSheet = previewSheets[activeSheetIndex] || previewSheets[0]
    if (!currentSheet) {
      return
    }

    if (!activeSpreadsheetCell || activeSpreadsheetCell.sheetIndex !== activeSheetIndex) {
      setActiveSpreadsheetCell({
        sheetIndex: activeSheetIndex,
        row: 1,
        col: 1
      })
      return
    }

    const nextRow = Math.min(Math.max(activeSpreadsheetCell.row, 1), Math.max(currentSheet.rows, 1))
    const nextCol = Math.min(Math.max(activeSpreadsheetCell.col, 1), Math.max(currentSheet.cols, 1))

    if (nextRow !== activeSpreadsheetCell.row || nextCol !== activeSpreadsheetCell.col) {
      setActiveSpreadsheetCell({
        sheetIndex: activeSheetIndex,
        row: nextRow,
        col: nextCol
      })
    }
  }, [activeSheetIndex, activeSpreadsheetCell, previewSheets, spreadsheetEditable])

  React.useEffect(() => {
    if (open || !item?.ocrBundleId || activeOcrHover?.bundleId !== item.ocrBundleId) {
      return
    }

    window.dispatchEvent(
      new CustomEvent(CANVAS_OCR_HOVER_EVENT, {
        detail: {
          bundleId: item.ocrBundleId,
          bboxIds: [],
          cellIds: []
        } satisfies CanvasOcrHoverDetail
      })
    )
  }, [activeOcrHover?.bundleId, item?.ocrBundleId, open])

  React.useEffect(() => {
    if (!open) {
      setExportMenuAnchor(null)
    }
  }, [open])

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle sx={{ fontWeight: 700, fontSize: 16 }}>
        {item?.fileName || uiCopy.titleFallback}
      </DialogTitle>
      <DialogContent
        dividers
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5
        }}
      >
        <Typography variant="body2" sx={{ color: 'text.secondary' }}>
          {metaText}
        </Typography>

        {spreadsheetEditable && showSpreadsheetPreview && activeSheet ? (
          <Box
            sx={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1
            }}
          >
            {selectedCellLabel ? (
              <Typography variant="caption" sx={{ color: 'text.secondary', mr: 0.5 }}>
                {uiCopy.spreadsheetSelectedCellLabel(selectedCellLabel)}
              </Typography>
            ) : null}
            <Button size="small" variant="outlined" onClick={handleAddSpreadsheetRow}>
              {uiCopy.spreadsheetAddRowButton}
            </Button>
            <Button size="small" variant="outlined" onClick={handleDeleteSpreadsheetRow}>
              {uiCopy.spreadsheetDeleteRowButton}
            </Button>
            <Button size="small" variant="outlined" onClick={handleAddSpreadsheetColumn}>
              {uiCopy.spreadsheetAddColumnButton}
            </Button>
            <Button size="small" variant="outlined" onClick={handleDeleteSpreadsheetColumn}>
              {uiCopy.spreadsheetDeleteColumnButton}
            </Button>
          </Box>
        ) : null}

        {item?.editable && !spreadsheetEditable ? (
          <TextField
            multiline
            minRows={14}
            maxRows={22}
            fullWidth
            value={draftContent}
            onChange={(event) => onDraftChange(event.target.value)}
            InputProps={{
              readOnly: false,
              sx: {
                alignItems: 'flex-start',
                fontFamily: PREVIEW_TEXT_FIELD_FONT
              }
            }}
            placeholder={uiCopy.editPlaceholder}
          />
        ) : (
          <>
            {showSpreadsheetPreview && item ? (
              <SpreadsheetPreviewTable
                item={item}
                sheets={previewSheets}
                editable={spreadsheetEditable}
                activeSheetIndex={activeSheetIndex}
                activeCell={activeSpreadsheetCell}
                activeOcrHover={activeOcrHover}
                onActiveSheetChange={setActiveSheetIndex}
                onCellSelect={(sheetIndex, row, col) =>
                  setActiveSpreadsheetCell({ sheetIndex, row, col })
                }
                onCellChange={handleSpreadsheetCellChange}
                uiCopy={uiCopy}
              />
            ) : null}

            {!showSpreadsheetPreview && previewText ? (
              <TextField
                multiline
                minRows={10}
                maxRows={20}
                fullWidth
                value={previewText}
                InputProps={{
                  readOnly: true,
                  sx: {
                    alignItems: 'flex-start',
                    fontFamily: PREVIEW_TEXT_FIELD_FONT
                  }
                }}
              />
            ) : null}

            {previewImages.length > 0 ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                  {uiCopy.embeddedImagesLabel(previewImages.length)}
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1.5,
                    gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' }
                  }}
                >
                  {previewImages.map((image, index) => (
                    <Box
                      key={image.id}
                      sx={{
                        borderRadius: 2,
                        overflow: 'hidden',
                        border: '1px solid',
                        borderColor: 'divider',
                        bgcolor: 'background.default'
                      }}
                    >
                      <Box
                        component="img"
                        src={image.src}
                        alt={image.fileName || `embedded-preview-${index + 1}`}
                        sx={{
                          display: 'block',
                          width: '100%',
                          maxHeight: 320,
                          objectFit: 'contain',
                          bgcolor: '#0f172a'
                        }}
                      />
                      <Typography
                        variant="caption"
                        sx={{
                          display: 'block',
                          px: 1,
                          py: 0.75,
                          color: 'text.secondary',
                          borderTop: '1px solid',
                          borderColor: 'divider'
                        }}
                      >
                        {image.fileName}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            ) : null}

            {showEmptyTip ? (
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                {uiCopy.emptyTip}
              </Typography>
            ) : null}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{uiCopy.closeButton}</Button>
        {item && onExport ? (
          <>
            <Button
              onClick={(event) => {
                if (exportOptions.length <= 1) {
                  onExport(item, exportOptions[0]?.format)
                  return
                }

                setExportMenuAnchor(event.currentTarget)
              }}
            >
              {uiCopy.exportButton}
            </Button>
            <Menu
              anchorEl={exportMenuAnchor}
              open={Boolean(exportMenuAnchor)}
              onClose={() => setExportMenuAnchor(null)}
              anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
              transformOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
              {exportOptions.map((option) => (
                <MenuItem
                  key={option.format}
                  onClick={() => {
                    setExportMenuAnchor(null)
                    onExport(item, option.format)
                  }}
                >
                  {option.label}
                </MenuItem>
              ))}
            </Menu>
          </>
        ) : null}
        {item?.editable || spreadsheetEditable ? (
          <Button variant="contained" onClick={onSave}>
            {uiCopy.saveButton}
          </Button>
        ) : null}
      </DialogActions>
    </Dialog>
  )
}
