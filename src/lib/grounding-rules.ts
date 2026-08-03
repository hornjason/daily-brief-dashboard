/**
 * Shared grounding rules for Gemini prompt construction.
 * All consumers generating AI content MUST import and include these.
 * See: architecture-compliance.test.ts for enforcement.
 */

export const GROUNDING_RULES = {
  FACTUAL: 'Every claim, metric, dollar amount, date, and name MUST come from the provided context data.',
  NO_FABRICATION: 'Never extrapolate, estimate, or generate plausible-sounding data that is not in the provided context.',
  MISSING_DATA: 'If the context does not contain a specific data point, do not fabricate it — omit or say "data unavailable."',
  FINANCIAL_ACCURACY: 'Pipeline dollar figures MUST match the exact amounts in the provided pipeline data. Do not round, estimate, or fabricate financial figures.',
  TEAM_NAMES: 'Team member names MUST come from the account team data. Never invent names or use generic titles.',
  SPECIFIC_REFERENCES: 'Generic references ("the team", "key stakeholders", "relevant accounts", "industry peers", "companies like yours") are PROHIBITED — use specific names and account names from the data.',
} as const

export const GROUNDING_RULES_BLOCK = `## GROUNDING RULES (MANDATORY — ZERO EXCEPTIONS)
1. ${GROUNDING_RULES.FACTUAL}
2. ${GROUNDING_RULES.NO_FABRICATION}
3. ${GROUNDING_RULES.MISSING_DATA}
4. ${GROUNDING_RULES.FINANCIAL_ACCURACY}
5. ${GROUNDING_RULES.TEAM_NAMES}
6. ${GROUNDING_RULES.SPECIFIC_REFERENCES}`
