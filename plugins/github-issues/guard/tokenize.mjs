// Shell-ish tokenizer for the agent guard. See agentGuard.mjs for the limits it accepts.
// Splits on && || ; | & and newlines; quotes and \x are unquoted into the word.
// Redirections become { op, target } entries on their segment, never words.

// Splits a command into segments of { words, redirects: [{ op, target }] }. Substitution bodies
// ($(...) and backticks) are returned separately so they can be checked as commands too.
export function tokenize(text) {
  const segments = []
  let segment = emptySegment()
  let word = ''
  let inWord = false
  let pendingOp = null

  const endWord = () => {
    if (!inWord) {
      return
    }
    if (pendingOp) {
      segment.redirects.push({ op: pendingOp, target: word })
      pendingOp = null
    } else {
      segment.words.push(word)
    }
    word = ''
    inWord = false
  }
  const endSegment = () => {
    endWord()
    if (segment.words.length > 0 || segment.redirects.length > 0) {
      segments.push(segment)
    }
    segment = emptySegment()
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      word += text.slice(i + 1, end < 0 ? text.length : end)
      inWord = true
      i = end < 0 ? text.length : end + 1
    } else if (ch === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) {
          word += text[j + 1]
          j += 2
        } else {
          word += text[j++]
        }
      }
      inWord = true
      i = j + 1
    } else if (ch === '\\') {
      word += text[i + 1] ?? ''
      inWord = true
      i += 2
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      endWord()
      i++
    } else if (ch === '\n' || ch === ';') {
      endSegment()
      i++
    } else if (ch === '&' && text[i + 1] === '&') {
      endSegment()
      i += 2
    } else if (ch === '&' && text[i + 1] === '>') {
      endWord()
      pendingOp = '&>'
      i += text[i + 2] === '>' ? 3 : 2
    } else if (ch === '&') {
      endSegment()
      i++
    } else if (ch === '|') {
      endSegment()
      i += text[i + 1] === '|' || text[i + 1] === '&' ? 2 : 1
    } else if (ch === '>') {
      // A bare fd number before > (2>file) is not a word of its own.
      if (inWord && /^\d+$/.test(word)) {
        word = ''
        inWord = false
      } else {
        endWord()
      }
      let op = '>'
      i++
      if (text[i] === '>' || text[i] === '|' || text[i] === '&') {
        op += text[i]
        i++
      }
      pendingOp = op
    } else if (ch === '<') {
      endWord()
      pendingOp = '<'
      i++
    } else {
      word += ch
      inWord = true
      i++
    }
  }
  endSegment()
  return { segments, substitutions: substitutionBodies(text) }
}

function emptySegment() {
  return { words: [], redirects: [] }
}

// Bodies of $(...) and `...`, found by depth counting. Good enough for the guard's checks.
function substitutionBodies(text) {
  const bodies = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < text.length; j++) {
        if (text[j] === '(') {
          depth++
        } else if (text[j] === ')' && --depth === 0) {
          break
        }
      }
      bodies.push(text.slice(i + 2, j))
    } else if (text[i] === '`') {
      const end = text.indexOf('`', i + 1)
      if (end > i) {
        bodies.push(text.slice(i + 1, end))
        i = end
      }
    }
  }
  return bodies
}
