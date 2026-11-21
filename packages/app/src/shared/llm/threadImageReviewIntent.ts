// Match the entire user prompt, not instructions embedded in prose, quotes, links or filenames.
// This is only a UI hint. It does not establish image ownership, capability or permission.
const enImage =
  '(?:(?:the |your )?(?:last|latest|previous)(?: generated)? (?:image|picture)|the (?:image|picture) you (?:just )?generated)'
const enInspect = new RegExp(
  `^(?:(?:can|could) you |please )?(?:inspect|review|check|analyze|critique) ${enImage}(?: for (?:visual (?:issues|defects)|problems|errors))?$`,
  'iu'
)
const enQuestion = new RegExp(
  `^(?:what(?: is|'s) wrong with|(?:can you )?(?:find|spot|identify) (?:the |any )?(?:problems|issues|defects|mistakes) in) ${enImage}$`,
  'iu'
)
const zhImage =
  '(?:上(?:一)?张|刚(?:刚|才)(?:生成|画)(?:的)?(?:那张|这张)?|你刚(?:刚|才)(?:生成|画)(?:的)?(?:那张|这张)?)(?:图片|图像|图)'
const zhInspect = new RegExp(
  `^(?:请|帮我|请帮我|你能)?(?:检查|检查一下|分析|审视|看看|点评)${zhImage}(?:(?:中|里|上)?(?:的|有(?:什么|哪些))?(?:视觉)?问题)?(?:吗)?$`,
  'u'
)
const zhQuestion = new RegExp(
  `^${zhImage}(?:中|里|上)?(?:有(?:什么|哪些)问题|哪里(?:有问题|不对))$`,
  'u'
)

export function isThreadImageReviewPrompt(
  text: string,
  options: { previousAssistantImage: boolean }
): boolean {
  if (typeof text !== 'string' || text.length > 240 || /[\r\n]/u.test(text)) return false
  const prompt = text
    .trim()
    .replace(/[?？。.!！]$/u, '')
    .replace(/[ \t]+/gu, ' ')
    .trim()
  if (
    enInspect.test(prompt) ||
    enQuestion.test(prompt) ||
    zhInspect.test(prompt) ||
    zhQuestion.test(prompt)
  )
    return true
  return (
    options.previousAssistantImage &&
    (/^(?:你能(?:自己)?找出问题吗|这张图(?:片)?(?:有(?:什么|哪些)问题|哪里不对))$/u.test(prompt) ||
      /^(?:can you (?:spot|find) the problem(?: yourself)?|what(?: is|'s) wrong with this (?:image|picture))$/iu.test(
        prompt
      ))
  )
}
