# Security Baseline (do not regress)

- `sanitizeCell()` on all Sheets writes before `valueInputOption: 'RAW'`
- `sanitizeErr(e)` on all API error responses — never return raw `e.message`
- `escapeXml()` on all values interpolated into brief XML sources
- Cache/config files written with `mode: 0o600`
- `dumpDom()` gated behind `CCSP_DEBUG=true` — never in production
- `sanitizeText()` rejects HTML tags (returns null -> 400), does not strip
