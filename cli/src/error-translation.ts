const translations: Array<{ test: RegExp; text: string }> = [
  { test: /context deadline exceeded.*(?:build )?disk|(?:build )?disk.*context deadline exceeded/i, text: 'build disk monitor timed out' },
  { test: /context deadline exceeded/i, text: 'an operation timed out while waiting for a response' },
  { test: /no space left on device/i, text: 'the build disk is full' },
  { test: /connection refused/i, text: 'the service refused the connection' },
]

/** Translate known low-level failures; unknown errors remain visible verbatim. */
export function translateFailure(reason: string): string {
  const line = reason.split('\n')[0]?.trim() || reason.trim()
  return translations.find(({ test }) => test.test(line))?.text ?? line
}

/** A stable key for grouping the same user-visible cause across services. */
export function failureKey(reason: string): string {
  return translateFailure(reason).toLowerCase()
}
