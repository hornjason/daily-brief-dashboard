import { z } from 'zod'

export const ConnectionHealthSchema = z.object({
  transport: z.string(),
  lastProbe: z.string().datetime().nullable(),
  degradedReason: z.string().nullable(),
  confidence: z.enum(['fresh', 'stale', 'unknown']),
})

export type ConnectionHealth = z.infer<typeof ConnectionHealthSchema>

/** Derive confidence from lastProbe timestamp */
export function deriveConfidence(lastProbe: string | null): 'fresh' | 'stale' | 'unknown' {
  if (!lastProbe) return 'unknown'
  const ageMs = Date.now() - new Date(lastProbe).getTime()
  return ageMs < 5 * 60 * 1000 ? 'fresh' : 'stale'
}
