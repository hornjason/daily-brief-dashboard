const ROLE_PREFIXES = /^(VP|Director|Head|Sr\.|Sr|Chief|Manager|CIO|CTO|CFO|COO|CMO|CISO|SVP|EVP|President|Executive)\b/i

export function isRealPersonName(name: string): boolean {
  if (!name || name.trim().length < 4) return false
  const trimmed = name.trim()
  if (/\bat\b/i.test(trimmed)) return false
  if (ROLE_PREFIXES.test(trimmed)) return false
  return true
}
