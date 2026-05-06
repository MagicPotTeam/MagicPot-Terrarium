/* eslint-disable @typescript-eslint/no-require-imports, no-useless-escape */
const fs = require('fs')

const panelPath =
  'packages/app/src/renderer/src/pages/QuickAppPage/QAppDesignPanel/QAppDesignPanel.tsx'
let pContent = fs.readFileSync(panelPath, 'utf8')

// Fix the Background Hover in QAppDesignPanel
pContent = pContent.replace(
  /background: hovered[\s\S]*?border: hovered \? '1px solid transparent' : `1px solid \$\{t\.palette\.divider\}`\,/m,
  `background: hovered
          ? t.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)'
          : t.palette.background.paper,
        color: t.palette.text.primary,
        border: \`1px solid \$\{hovered ? t.palette.text.secondary : t.palette.divider\}\`,`
)

fs.writeFileSync(panelPath, pContent, 'utf8')

const skillPath = 'packages/app/src/renderer/src/pages/QuickAppPage/CustomSkillManagerPage.tsx'
let sContent = fs.readFileSync(skillPath, 'utf8')

const newSkillMapping = `
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))', md: 'repeat(3, minmax(0, 1fr))' }, gap: 1.5 }}>
                    {categorySkills.map((skill) => {
                      const issues = getCustomSkillsNeedingAttention([skill])[0]?.issues || []
                      return (
                        <Card
                          key={skill.id}
                          onClick={() => {
                            setSelectedCategory(category)
                            setCategoryDraft(category)
                            setSelectedSkillId(skill.id)
                            setEditSkillDialogOpen(true)
                          }}
                          sx={(theme) => ({
                            position: 'relative',
                            height: 150,
                            cursor: 'pointer',
                            borderRadius: 3,
                            overflow: 'hidden',
                            background: theme.palette.mode === 'dark' ? alpha(theme.palette.background.paper, 0.4) : theme.palette.background.paper,
                            color: theme.palette.text.primary,
                            border: \`1px solid \$\{theme.palette.divider\}\`,
                            boxShadow: \`0 2px 8px \$\{alpha(theme.palette.common.black, 0.04)}\`,
                            transition: 'transform .2s ease, box-shadow .2s ease, background .2s ease, border-color .2s ease',
                            '&:hover': { 
                              transform: 'translateY(-6px)',
                              background: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
                              borderColor: theme.palette.text.secondary,
                              boxShadow: 'none',
                              '& .card-actions': { opacity: 1 },
                              '& .watermark': {
                                transform: 'scale(1.06)',
                                opacity: theme.palette.mode === 'dark' ? 0.3 : 0.2
                              }
                            }
                          })}
                        >
                          <IconButton
                            size="small"
                            className="card-actions"
                            sx={{
                              position: 'absolute',
                              bottom: 8,
                              left: 8,
                              zIndex: 2,
                              opacity: 0,
                              transition: 'all .2s ease',
                              color: 'error.main',
                              '&:hover': {
                                bgcolor: 'error.main',
                                color: '#fff'
                              }
                            }}
                            onClick={(e) => { e.stopPropagation(); setSelectedSkillId(skill.id); openDeleteSkillDialog(); }}
                          >
                            <DeleteOutlineIcon sx={{ fontSize: 18 }} />
                          </IconButton>
                          
                          <Container
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
                              pb: 5,
                              maxWidth: '100% !important',
                              mx: 0
                            }}
                          >
                            <Box sx={{ display: 'flex', alignItems: 'center', maxWidth: '100%' }}>
                              <Typography variant="subtitle1" sx={{ fontWeight: 700, fontSize: 16, lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', whiteSpace: 'normal', overflowWrap: 'anywhere', color: 'inherit', flex: '0 1 auto' }} title={skill.skillName || t('custom_workshop.new_skill_default')}>
                                {skill.skillName || t('custom_workshop.new_skill_default')}
                              </Typography>
                            </Box>
                            
                            <Stack direction="row" spacing={0.5} sx={{ mt: 1, alignItems: 'center' }}>
                               {skill.type === 'agent' ? (
                                 <Chip size="small" label="Agent" color="primary" sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }} />
                               ) : (
                                 <Chip size="small" label="Prompt" variant="outlined" sx={{ height: 20, fontSize: 11, fontWeight: 700, px: 0.5 }} />
                               )}
                               {issues.length > 0 && <Chip size="small" color="warning" label={issues.length} sx={{ height: 20, fontSize: 11, fontWeight: 700 }} />}
                            </Stack>
                          </Container>
                          
                          <Box
                            className="watermark"
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
                              opacity: (t) => t.palette.mode === 'dark' ? 0.15 : 0.08,
                              transformOrigin: 'right bottom',
                              transition: 'transform 120ms ease, opacity 120ms ease'
                            }}
                          >
                            <CustomSkillIcon sx={{ fontSize: 56, color: 'text.primary' }} />
                          </Box>
                        </Card>
                      )
                    })}
                  </Box>
`

sContent = sContent.replace(
  /<Box sx=\{\{ display: 'grid', gridTemplateColumns: \{ xs: 'minmax\(0\, 1fr\)', md: 'repeat\(2, minmax\(0, 1fr\)\)' \}.*?<\/Box>\s*?<\/Box>\s*?<\/Box>/s,
  newSkillMapping + '\n                </Box>'
)

fs.writeFileSync(skillPath, sContent, 'utf8')

console.log('Update finished.')
