// BKL-ARCH-23: shared helpers for signal-source unit tests.
import { escapeXml } from '../../../../src/customer/signals/xml-utils.ts'
import type { RenderContext } from '../../../../src/customer/signals/types.ts'

const fmt = (iso: string) => {
  try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) }
  catch { return iso }
}

export function makeCtx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    escapeXml,
    fmt,
    today: '2026-05-02',
    // Default to no failure / no staleness — sourceStatusAttr returns ''.
    sourceStatusAttr: () => '',
    emailLimit: 5,
    ...overrides,
  }
}
