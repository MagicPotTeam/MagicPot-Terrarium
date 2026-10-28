export function parseStrictJson(text, label = 'JSON') {
  let index = 0
  const fail = () => {
    throw new Error(`${label} is not valid strict JSON`)
  }
  const whitespace = () => {
    while (index < text.length && ' \t\r\n'.includes(text[index])) index += 1
  }
  const parseString = () => {
    if (text[index] !== '"') fail()
    const start = index++
    while (index < text.length) {
      const code = text.charCodeAt(index)
      if (code === 0x22) {
        index += 1
        try {
          return JSON.parse(text.slice(start, index))
        } catch {
          fail()
        }
      }
      if (code < 0x20) fail()
      if (code === 0x5c) {
        index += 1
        const escape = text[index]
        if (escape === 'u') {
          if (!/^[0-9a-f]{4}$/i.test(text.slice(index + 1, index + 5))) fail()
          index += 5
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          fail()
        } else {
          index += 1
        }
      } else {
        index += 1
      }
    }
    fail()
  }
  const parseValue = (depth) => {
    if (depth > 128) throw new Error(`${label} JSON nesting is too deep`)
    whitespace()
    const character = text[index]
    if (character === '"') return parseString()
    if (character === '{') {
      index += 1
      whitespace()
      const result = Object.create(null)
      const keys = new Set()
      if (text[index] === '}') {
        index += 1
        return result
      }
      while (true) {
        whitespace()
        const key = parseString()
        if (keys.has(key)) throw new Error(`${label} contains duplicate object key`)
        keys.add(key)
        whitespace()
        if (text[index++] !== ':') fail()
        result[key] = parseValue(depth + 1)
        whitespace()
        if (text[index] === '}') {
          index += 1
          return result
        }
        if (text[index++] !== ',') fail()
      }
    }
    if (character === '[') {
      index += 1
      whitespace()
      const result = []
      if (text[index] === ']') {
        index += 1
        return result
      }
      while (true) {
        result.push(parseValue(depth + 1))
        whitespace()
        if (text[index] === ']') {
          index += 1
          return result
        }
        if (text[index++] !== ',') fail()
      }
    }
    for (const [literal, parsed] of [
      ['true', true],
      ['false', false],
      ['null', null]
    ]) {
      if (text.startsWith(literal, index)) {
        index += literal.length
        return parsed
      }
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(index))?.[0]
    if (!number) fail()
    index += number.length
    const parsed = Number(number)
    if (!Number.isFinite(parsed)) fail()
    return parsed
  }

  const result = parseValue(0)
  whitespace()
  if (index !== text.length) fail()
  return result
}
