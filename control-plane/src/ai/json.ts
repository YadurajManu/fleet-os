/**
 * The first complete JSON object in a reply, by matching braces.
 *
 * Taking everything between the first `{` and the last `}` looks equivalent
 * and is not: a reply that is one object followed by a sentence, or by a
 * second object, slices into something that parses as neither. That ended a
 * real investigation one step in — "Unexpected non-whitespace character after
 * JSON at position 70" — with the usable object sitting in the first seventy
 * characters, and later ended a manifest review the same way at position 36.
 *
 * Braces inside strings do not count, and neither does an escaped quote, or
 * a path in a log line closes the object early.
 *
 * Shared rather than copied. It was written for the investigation loop and the
 * review parsed replies its own way, so the review kept the bug for as long as
 * it took somebody to run it against a model that answers with two objects.
 */
export function firstObject(raw: string): string | null {
  const start = raw.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\' && inString) {
      escaped = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return raw.slice(start, i + 1)
  }

  return null
}
