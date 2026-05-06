/* eslint-disable @typescript-eslint/no-require-imports, no-useless-escape */
const fs = require('fs')

const panelPath =
  'packages/app/src/renderer/src/pages/QuickAppPage/QAppDesignPanel/QAppDesignPanel.tsx'
let pContent = fs.readFileSync(panelPath, 'utf8')

// Replace QAppDesignPanel WorkflowCard hover gradient with plain gray
pContent = pContent.replace(
  /background: hovered[\s\S]*?border: hovered \? '1px solid transparent' : `1px solid \$\{t\.palette\.divider\}`\,/g,
  `background: hovered
          ? t.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'
          : t.palette.background.paper,
        color: t.palette.text.primary,
        border: \`1px solid \$\{hovered ? t.palette.text.secondary : t.palette.divider\}\`,`
)

fs.writeFileSync(panelPath, pContent, 'utf8')

const skillPath = 'packages/app/src/renderer/src/pages/QuickAppPage/CustomSkillManagerPage.tsx'
let sContent = fs.readFileSync(skillPath, 'utf8')

const cleanSkillCard = `
// ==========================================
// SkillCard — 与 QAppDesignPanel WorkflowCard 相同结构
// ==========================================
const SkillCard: React.FC<{
  skill: any
  onClick: () => void
  onDelete: () => void
  onEdit: (name: string) => void
  issuesCount: number
}> = ({ skill, onClick, onDelete, issuesCount }) => {
  const [hovered, setHovered] = useState(false)

  const label = skill.skillName || 'New Skill'

  return (
    <Card
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
          ? t.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'
          : t.palette.background.paper,
        color: t.palette.text.primary,
        border: \`1px solid \$\{hovered ? t.palette.text.secondary : t.palette.divider\}\`,
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
      <IconButton
        size="small"
        onClick={(e) => {
          e.stopPropagation()
          onDelete()
        }}
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
      >
        <DeleteOutlineIcon sx={{ fontSize: 18 }} />
      </IconButton>
      <Box
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
        <Box sx={{ display: 'flex', alignItems: 'center', maxWidth: '100%' }}>
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
              color: 'inherit',
              flex: '0 1 auto'
            }}
            title={label}
          >
            {label}
          </Typography>
        </Box>
        <Stack direction="row" spacing={0.5} sx={{ mt: 1, alignItems: 'center' }}>
           {skill.type === 'agent' ? (
             <Chip size="small" label="Agent" color="primary" sx={{ height: 18, fontSize: 10, fontWeight: 700, px: 0.5 }} />
           ) : (
             <Chip size="small" label="Prompt" variant="outlined" sx={{ height: 18, fontSize: 10, fontWeight: 700, px: 0.5 }} />
           )}
           {issuesCount > 0 && <Chip size="small" color="warning" label={issuesCount} sx={{ height: 18, fontSize: 10, fontWeight: 700 }} />}
        </Stack>
      </Box>

      <Box
        sx={{
          position: 'absolute',
          zIndex: 0,
          right: 4,
          bottom: 4,
          width: 64,
          height: 64,
          pointerEvents: 'none',
          userSelect: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: 0.08,
          transformOrigin: 'right bottom',
          transition: 'transform 120ms ease, opacity 120ms ease',
          transform: hovered ? 'scale(1.1)' : 'scale(1)',
          ...(hovered && { opacity: 0.15 })
        }}
      >
        <CustomSkillIcon sx={{ fontSize: 48, color: 'text.primary' }} />
      </Box>
    </Card>
  )
}
`

// Replace the end of CustomSkillManagerPage (everything after the export default) with new SkillCard
sContent = sContent.replace(
  /\/\/ ==========================================\s*\/\/ SkillCard.*/s,
  cleanSkillCard
)

// ensure Card imports
if (!sContent.includes('import { Card,')) {
  sContent = sContent.replace('  Button,', '  Button,\n  Card,\n  CardContent,')
}

// Remove references to old missing icons if they exist in imports
sContent = sContent.replace(/purpleHu,\s*whiteHu,\s*arrowPng,\s*arrow2Png,\s*EditIcon,/g, '')

fs.writeFileSync(skillPath, sContent, 'utf8')

console.log('Update both files successful.')
