// BKL-ARCH-23: Shared XML helpers used by both buildXmlSources and
// buildDeltaXmlSources. Pure functions only — no I/O, no module state.

/**
 * Escape characters that have special meaning in XML attribute or text
 * content. Note: only the five attribute-significant chars are handled here;
 * the previous customer.ts implementation deliberately did NOT escape `'`,
 * and we preserve that behaviour for byte-identical output.
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
