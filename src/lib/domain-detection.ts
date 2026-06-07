/**
 * src/lib/domain-detection.ts
 * Domain detection utilities extracted from meeting-prep-service.ts (#651)
 *
 * Pure functions for detecting partner/customer domains from email addresses
 * and deriving company names from email domains.
 */

import type { Customer } from '../types.ts'

/**
 * Derive a company name from an email address domain.
 * e.g., "courtney@insight.com" -> "Insight"
 */
export function deriveCompanyFromDomain(email: string): string {
  const domain = email.split('@')[1] ?? ''
  const company = domain.split('.')[0] ?? ''
  return company.charAt(0).toUpperCase() + company.slice(1)
}

/**
 * Detect partner domains from meeting attendee emails.
 * Partner domains = external emails that don't match the customer's domain or alias domains.
 */
export function detectPartnerDomains(
  attendeeEmails: string[],
  customer: Customer
): { partnerDomains: string[]; customerDomains: string[] } {
  const customerDomains = [customer.domain, ...(customer.aliasDomains ?? [])].filter(Boolean) as string[]
  const externalEmails = attendeeEmails.filter(e => !e.endsWith('@redhat.com'))

  const partnerDomains = new Set<string>()
  for (const email of externalEmails) {
    const domain = email.split('@')[1] ?? ''
    if (domain && !customerDomains.some(cd => domain.endsWith(cd))) {
      partnerDomains.add(domain)
    }
  }

  return { partnerDomains: [...partnerDomains], customerDomains }
}
