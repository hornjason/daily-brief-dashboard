/**
 * Exec Resolver — Campaign-specific contact orchestration (#1162, ADR-046 §4)
 *
 * Orchestrates executive resolution for campaign generation:
 *   1. Resolve contacts from persona config or defaults
 *   2. Pad to minimum 6 contacts
 *   3. Filter placeholder names
 *   4. Re-resolve via Tier 2 if needed
 *   5. Enforce tier split (3+ executive, 3+ manager)
 *   6. Backfill inferred emails
 *
 * Uses executive-resolver.ts for low-level contact lookup (Tier 1/2/3).
 * This module is the campaign-specific orchestrator layer.
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { resolveExecutivesByRole, type ResolvedExecutive } from './executive-resolver.ts'
import { isRealPersonName } from './contact-quality.ts'
import { assertExecResolutionOutput } from './campaign-contracts.ts'
import { CONFIG_DIR } from './paths.ts'

// ── Types ───────────────────────────────────────────────────────────────────

export interface PersonaConfig {
  role: string
  enabled: boolean
  relevantVPs?: string[]
  linkedinUrl?: string
  name?: string
}

export interface ExecResolverInput {
  personas?: PersonaConfig[]
  customerName: string
  customerDomain?: string
}

// ── Constants ───────────────────────────────────────────────────────────────

const MIN_CONTACTS = 6
const MIN_TIER_CONTACTS = 3

const DEFAULT_PERSONAS: PersonaConfig[] = [
  { role: 'CIO', enabled: true },
  { role: 'CTO', enabled: true },
  { role: 'VP Engineering', enabled: true },
  { role: 'Solutions Architect', enabled: true },
  { role: 'Director of IT', enabled: true },
  { role: 'Director of Platform Engineering', enabled: true },
  { role: 'CFO', enabled: true },
  { role: 'DevOps Engineer', enabled: true },
]

const FALLBACK_PAD_ROLES = [
  'VP Engineering',
  'Director of Security',
  'Head of Cloud Operations',
  'CTO',
  'Sr. Director IT',
  'VP Digital Transformation',
]

const TIER2_FALLBACK_ROLES = [
  'IT Operations Manager',
  'Cloud Architect',
  'Head of Engineering',
  'VP Engineering',
  'Director of Infrastructure',
  'Engineering Manager',
]

const MANAGER_ROLES = [
  'Director of IT',
  'Director of Infrastructure',
  'Director of Platform Engineering',
  'Sr. Manager, Cloud Operations',
  'Head of DevOps',
  'Director of Security',
]

const EXECUTIVE_ROLES = [
  'CIO',
  'CTO',
  'VP Engineering',
  'VP Operations',
  'Chief Information Officer',
  'VP Infrastructure',
]

// ── Tier Classification ─────────────────────────────────────────────────────

export function classifyEmailTier(title: string): 'executive' | 'manager' {
  const titleLower = title.toLowerCase()
  if (/\b(ceo|cfo|cto|cio|ciso|chief|c-level)\b/i.test(titleLower)) return 'executive'
  if (/\bvp\b|vice president/i.test(titleLower)) return 'executive'
  return 'manager'
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makePlaceholder(role: string, companyName: string): ResolvedExecutive {
  return {
    name: `${role} at ${companyName}`,
    title: role,
    role,
    resolvedAt: new Date().toISOString(),
  }
}

function lookupDomain(customerName: string): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(resolve(CONFIG_DIR, 'customers.json'), 'utf-8'))
    const lowerName = customerName.toLowerCase()
    const cfgCustomer = (cfg.customers ?? []).find(
      (c: any) =>
        c.name?.toLowerCase() === lowerName ||
        c.name?.toLowerCase().includes(lowerName) ||
        lowerName.includes(c.name?.toLowerCase()),
    )
    return cfgCustomer?.domain
  } catch (e: any) {
    console.warn(`[exec-resolver] Domain lookup failed: ${e?.message}`)
    return undefined
  }
}

async function backfillEmails(execs: ResolvedExecutive[], domain: string, customerName: string): Promise<number> {
  const { detectEmailPattern, generateEmailFromPattern } = await import('./email-pattern-detector.ts')
  const pattern = await detectEmailPattern(domain, customerName)

  let backfilled = 0
  for (const exec of execs) {
    if (exec.email) continue
    const realName = exec.name.replace(/ at .+$/, '').trim()
    const nameParts = realName.split(/\s+/)
    const isRoleName = /^(VP|Director|Head|Sr\.|Chief|Manager|CIO|CFO|CEO|CTO|CISO)\b/i.test(nameParts[0])
    if (
      nameParts.length >= 2 &&
      !isRoleName &&
      /^[A-Za-z]/.test(nameParts[0]) &&
      /^[A-Za-z]/.test(nameParts[nameParts.length - 1])
    ) {
      const firstName = nameParts[0].toLowerCase()
      const lastName = nameParts[nameParts.length - 1].toLowerCase()
      const { email, emailSource } = generateEmailFromPattern(firstName, lastName, domain, pattern)
      exec.email = email
      exec.emailSource = emailSource
      backfilled++
    }
  }
  return backfilled
}

// ── Tier Split Enforcement ──────────────────────────────────────────────────

async function resolveTierContacts(
  roles: string[],
  execs: ResolvedExecutive[],
  customerName: string,
  customerDomain?: string,
  needed: number = 3,
): Promise<number> {
  const existingNames = new Set(execs.map(e => e.name.toLowerCase()))
  const existingTitles = new Set(execs.map(e => e.title.toLowerCase()))
  let added = 0

  for (const role of roles) {
    if (added >= needed) break
    if (existingTitles.has(role.toLowerCase())) continue

    try {
      const resolved = await resolveExecutivesByRole([role], customerName, customerDomain)
      if (resolved.length > 0) {
        if (!existingNames.has(resolved[0].name.toLowerCase())) {
          execs.push(resolved[0])
          existingNames.add(resolved[0].name.toLowerCase())
          existingTitles.add(role.toLowerCase())
          added++
        } else {
          console.log(`[exec-resolver] Skipping duplicate contact ${resolved[0].name} for role ${role}`)
        }
      } else {
        const placeholder = makePlaceholder(role, customerName)
        execs.push(placeholder)
        existingNames.add(placeholder.name.toLowerCase())
        existingTitles.add(role.toLowerCase())
        added++
      }
    } catch (e: any) {
      console.warn(`[exec-resolver] Failed to resolve ${role} (non-fatal):`, e?.message)
      const placeholder = makePlaceholder(role, customerName)
      execs.push(placeholder)
      existingNames.add(placeholder.name.toLowerCase())
      existingTitles.add(role.toLowerCase())
      added++
    }
  }

  return added
}

async function enforceTierSplit(
  execs: ResolvedExecutive[],
  customerName: string,
  customerDomain?: string,
): Promise<void> {
  if (execs.length === 0) return

  const execTierCount = execs.filter(e => classifyEmailTier(e.title) === 'executive').length
  const managerTierCount = execs.filter(e => classifyEmailTier(e.title) === 'manager').length

  console.log(`[exec-resolver] Tier split before enforcement: ${execTierCount} executive, ${managerTierCount} manager`)

  // Pad manager tier if insufficient
  if (managerTierCount < MIN_TIER_CONTACTS && execs.length >= MIN_TIER_CONTACTS) {
    const needed = MIN_TIER_CONTACTS - managerTierCount
    console.log(`[exec-resolver] Insufficient manager tier contacts (${managerTierCount}/${MIN_TIER_CONTACTS}) — adding ${needed} manager-level roles`)
    const added = await resolveTierContacts(MANAGER_ROLES, execs, customerName, customerDomain, needed)
    const newManagerCount = execs.filter(e => classifyEmailTier(e.title) === 'manager').length
    console.log(`[exec-resolver] Added ${added} manager-level contacts — new split: ${execTierCount} executive, ${newManagerCount} manager`)
  }

  // Pad executive tier if insufficient
  const currentExecCount = execs.filter(e => classifyEmailTier(e.title) === 'executive').length
  if (currentExecCount < MIN_TIER_CONTACTS && execs.length >= MIN_TIER_CONTACTS) {
    const needed = MIN_TIER_CONTACTS - currentExecCount
    console.log(`[exec-resolver] Insufficient executive tier contacts (${currentExecCount}/${MIN_TIER_CONTACTS}) — adding ${needed} executive-level roles`)
    const added = await resolveTierContacts(EXECUTIVE_ROLES, execs, customerName, customerDomain, needed)
    const newExecCount = execs.filter(e => classifyEmailTier(e.title) === 'executive').length
    const finalManagerCount = execs.filter(e => classifyEmailTier(e.title) === 'manager').length
    console.log(`[exec-resolver] Added ${added} executive-level contacts — new split: ${newExecCount} executive, ${finalManagerCount} manager`)
  }

  // Log final distribution
  const finalExecCount = execs.filter(e => classifyEmailTier(e.title) === 'executive').length
  const finalManagerCount = execs.filter(e => classifyEmailTier(e.title) === 'manager').length
  const tier1Count = execs.filter(e => e.leadershipContext).length
  const tier2Count = execs.length - tier1Count
  console.log(`[exec-resolver] Final contact distribution: ${execs.length} total (${tier1Count} Tier 1 intel, ${tier2Count} Tier 2 Gemini) — Email tiers: ${finalExecCount} executive, ${finalManagerCount} manager`)
}

// ── Main Orchestrator ───────────────────────────────────────────────────────

export async function resolveAllContacts(input: ExecResolverInput): Promise<ResolvedExecutive[]> {
  const { customerName, customerDomain } = input
  const userPersonas = input.personas?.filter(p => p.enabled)

  const enabledPersonas: PersonaConfig[] = userPersonas?.length ? userPersonas : DEFAULT_PERSONAS

  let resolvedExecs: ResolvedExecutive[] = []

  try {
    // Step 1: Add pre-named personas directly
    const namedPersonas = enabledPersonas.filter(p => p.name)
    for (const p of namedPersonas) {
      resolvedExecs.push({
        name: p.name!,
        title: p.role,
        role: p.role,
        resolvedAt: new Date().toISOString(),
        ...(p.linkedinUrl ? { linkedinUrl: p.linkedinUrl } : {}),
      })
    }

    // Step 2: Resolve unnamed personas via executive-resolver
    const rolesToResolve = enabledPersonas
      .filter(p => !p.linkedinUrl && !p.name)
      .map(p => p.role)
    if (rolesToResolve.length > 0) {
      const resolved = await resolveExecutivesByRole(rolesToResolve, customerName, customerDomain)
      resolvedExecs.push(...resolved)
    }

    // Step 3: Pad to minimum contacts with placeholder roles
    if (resolvedExecs.length < MIN_CONTACTS) {
      const resolvedRoles = new Set(resolvedExecs.map(r => r.role.toLowerCase()))
      const paddingRoles = enabledPersonas
        .map(p => p.role)
        .filter(r => !resolvedRoles.has(r.toLowerCase()))
      for (const role of paddingRoles) {
        if (resolvedExecs.length >= MIN_CONTACTS) break
        resolvedExecs.push(makePlaceholder(role, customerName))
      }
      if (resolvedExecs.length < MIN_CONTACTS) {
        for (const role of FALLBACK_PAD_ROLES) {
          if (resolvedExecs.length >= MIN_CONTACTS) break
          if (!resolvedRoles.has(role.toLowerCase())) {
            resolvedExecs.push(makePlaceholder(role, customerName))
          }
        }
      }
      console.log(`[exec-resolver] Padded contacts to ${resolvedExecs.length} for ${customerName}`)
    }

    // Step 4: Filter placeholder names (e.g., "VP Engineering at CompanyX")
    const prePadCount = resolvedExecs.length
    resolvedExecs = resolvedExecs.filter(e => isRealPersonName(e.name))
    if (resolvedExecs.length < prePadCount) {
      console.log(`[exec-resolver] Filtered ${prePadCount - resolvedExecs.length} placeholder contacts for ${customerName}`)
    }

    // Step 5: Re-pad with Tier 2 contacts if filter dropped count below minimum
    if (resolvedExecs.length < MIN_CONTACTS) {
      const needed = MIN_CONTACTS - resolvedExecs.length
      console.log(`[exec-resolver] Contact count ${resolvedExecs.length}/${MIN_CONTACTS} after filter — attempting to re-resolve ${needed} additional contacts via Tier 2`)
      try {
        const existingNames = new Set(resolvedExecs.map(e => e.name.toLowerCase()))
        const additionalContacts = await resolveExecutivesByRole(TIER2_FALLBACK_ROLES, customerName, customerDomain)

        let added = 0
        for (const contact of additionalContacts) {
          if (added >= needed) break
          if (!existingNames.has(contact.name.toLowerCase())) {
            resolvedExecs.push(contact)
            existingNames.add(contact.name.toLowerCase())
            added++
          }
        }
        if (added > 0) {
          console.log(`[exec-resolver] Re-padded with ${added} Tier 2 contacts for ${customerName}`)
        } else {
          console.log(`[exec-resolver] No additional Tier 2 contacts found — proceeding with ${resolvedExecs.length} contacts`)
        }
      } catch (e: any) {
        console.warn(`[exec-resolver] Tier 2 re-resolution failed (non-fatal):`, e?.message ?? e)
      }
    }

    // Step 6: Tier split enforcement (#1137, #1143)
    await enforceTierSplit(resolvedExecs, customerName, customerDomain)
  } catch (e: any) {
    console.warn(`[exec-resolver] Executive resolution failed (non-fatal):`, e?.message ?? e)
  }

  // Step 7: Email backfill
  let emailDomain = customerDomain
  if (!emailDomain) {
    emailDomain = lookupDomain(customerName)
  }
  console.log(`[exec-resolver] Email domain: ${emailDomain ?? 'NONE'}, contacts: ${resolvedExecs.length}, missing email: ${resolvedExecs.filter(e => !e.email).length}`)
  if (emailDomain) {
    const backfilled = await backfillEmails(resolvedExecs, emailDomain, customerName)
    console.log(`[exec-resolver] Email backfill: ${backfilled} new, ${resolvedExecs.filter(e => e.email).length}/${resolvedExecs.length} have email for ${customerName}`)
  }

  // Step 8: Contract assertion
  try {
    assertExecResolutionOutput(resolvedExecs)
  } catch (e: any) {
    if (process.env.NODE_ENV === 'test') throw e
    console.warn(`[exec-resolver] Exec resolution contract warning:`, e?.message)
  }

  return resolvedExecs
}
