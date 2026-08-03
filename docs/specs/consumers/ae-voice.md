---
doc-type: consumer-spec
status: active
owner: jason
updated: 2026-08-03
---

# Consumer Spec: AE Voice

## Overview
Analyzes sent emails from an Account Executive (AE) to create a voice profile capturing their writing style, tone, and communication patterns. The profile can be used to generate emails that authentically replicate the AE's voice.

## Source Files
- `src/ae-voice.ts` — detection logic, profile caching, Gemini analysis, Drive delivery
- `src/ae-voice-routes.ts` — HTTP endpoints for voice profile access and detection

## Delivery
- **Local Cache:** `data/cache/style-guides/{ae-slug}.json` (600 permissions)
- **Drive:** `Config/style-guide.json` in AE's Drive folder
- **Skill Voices Fallback:** `~/.claude/skills/ContentCampaign/voices/{ae-slug}.md` (read-only)

## API Endpoints
- `GET /api/ae/:name/voice` — load voice profile (cache → skill → null)
- `POST /api/ae/:name/voice/detect` — analyze sent emails and create/update profile

## Required Sections
Voice profile includes:
- **Voice Characteristics** (5-8 bullet points): tone, formality, sentence structure, vocabulary, greeting/sign-off style, CTA patterns
- **Prompt Instruction** (2-3 sentences): AI instruction to replicate the voice
- **Example Email**: Most representative snippet from analyzed emails
- **Metadata**: `detectedFrom` (email count + customer count), `detectedAt` (ISO timestamp)

## Quality Validator
None currently. Voice detection uses structured JSON schema validation via Gemini `responseSchema` parameter but does not implement `validateAndRetry()` pattern.

## TC Compliance

| Requirement | Status | Evidence |
|---|---|---|
| @consumer-contract v1.0 | ❌ | Missing contract declaration |
| ensureFresh | ⚠️ | N/A — reads cached emails (not signals), no `loadCustomerSignals()` call. Email cache freshness managed by email-intelligence module. |
| templateAll | ⚠️ | N/A — direct Gemini prompt (line 186-201), no signal template usage. This consumer analyzes raw email text, not structured signals. |
| validateAndRetry | ❌ | Missing — line 217 calls `callGemini()` but no validator import or retry logic. Uses `responseSchema` for structure enforcement only. |
| getAccountTeam | ⚠️ | N/A — consumer operates on AE entity, not customer. Reads `aes` array directly (line 147). |
| Drive delivery | ✅ | ae-voice.ts:236-258 — uploads to `Config/style-guide.json` in AE Drive folder |
| callGemini | ✅ | ae-voice.ts:217 — via wrapper, no direct `@google/generative-ai` imports |
| GROUNDING_RULES | ⚠️ | N/A — AE voice detection does not need GROUNDING_RULES (not customer-facing content generation) |

### Compliance Notes

**TC-1 Contract Declaration:** Missing `@consumer-contract v1.0` comment. Should be added at top of `ae-voice.ts` after imports.

**TC-2 Signal Freshness:** Not applicable — this consumer reads from the email cache (written by email-intelligence module), not from `loadCustomerSignals()`. Email freshness is managed upstream. No `ensureFresh` call needed here.

**TC-3 Template Engine:** Not applicable — voice detection analyzes raw email text directly rather than using structured signal templates. The consumer builds a custom Gemini prompt from email snippets (lines 186-201), which is appropriate for this use case.

**TC-4 Quality Validator:** Missing. Should implement a validator that checks:
- `characteristics.length >= 5`
- `promptInstruction.split(' ').length >= 15` (minimum depth)
- `exampleEmail` contains subject line and body
- No placeholder text ("TBD", "[Insert]", etc.)

Validator should be created at `src/quality-validators/ae-voice-validator.ts` and called via `validateAndRetry()` before caching.

**TC-5 Gemini Standardization:** Compliant — uses `callGemini()` wrapper (line 217).

**TC-6 Drive Delivery:** Compliant — uploads to `Config/style-guide.json` in AE's Drive folder via `uploadVoiceProfileToDrive()` (lines 236-258). Non-blocking async upload with error logging.

**TC-7 Account Team Integration:** Not applicable — this consumer operates on AE entities, not customers. Reads `aes` array directly from `server-state.ts` (line 147). Does not generate customer-specific content.

**TC-8 GROUNDING_RULES:** Not applicable — AE voice profiles are stylistic metadata, not customer-facing content that requires evidence grounding.

### Partial Compliance Justification

This consumer is **partially exempt** from the standard consumer contract because:
1. It operates on AE entities, not customer signals
2. It analyzes raw email text, not structured signals
3. It produces metadata (voice profiles), not customer-facing content
4. Email freshness is managed by upstream email-intelligence module

**Required fixes for full compliance:**
- Add `@consumer-contract v1.0` declaration
- Implement `src/quality-validators/ae-voice-validator.ts`
- Wire `validateAndRetry()` before caching (line 290)
- Add architecture-compliance.test.ts assertion for contract declaration
