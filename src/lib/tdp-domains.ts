/**
 * src/lib/tdp-domains.ts
 * Single source of truth for TDP (Technology Domain Pattern) domain names and keywords.
 * Both inferTdpFromProduct and TDP_KEYWORDS import from here.
 * GitHub Issue #882
 */

export interface TdpDomain {
  keywords: string[]
  aliases: string[]
}

export const TDP_DOMAINS: Record<string, TdpDomain> = {
  'Automation': {
    keywords: ['ansible', 'automation', 'automate', 'playbook', 'ops', 'aap', 'puppet', 'chef', 'terraform'],
    aliases: [],
  },
  'Container Management': {
    keywords: ['openshift', 'container', 'kubernetes', 'k8s', 'docker', 'ocp', 'pod', 'helm'],
    aliases: ['Container Mgmt'],
  },
  'Server and Cloud Computing': {
    keywords: ['rhel', 'linux', 'server', 'cloud', 'migrate', 'os', 'standardize'],
    aliases: ['Server/Cloud OS'],
  },
  'AI Platform': {
    keywords: ['ai', 'ml', 'inference', 'model', 'rhoai', 'openshift ai', 'data science', 'gpu'],
    aliases: ['AI'],
  },
  'Virtualization': {
    keywords: ['virtualization', 'virt', 'vmware', 'vsphere', 'vm', 'migrate', 'hypervisor'],
    aliases: [],
  },
  'Management': {
    keywords: ['satellite', 'management', 'insights', 'patch', 'compliance'],
    aliases: [],
  },
  'Security': {
    keywords: ['security', 'compliance', 'acs', 'stackrox', 'ciso'],
    aliases: [],
  },
  'Application Development': {
    keywords: ['app', 'application', 'developer', 'devops', 'cicd', 'pipeline'],
    aliases: ['App Platform'],
  },
}

/**
 * Normalize a TDP name to its canonical form.
 * If name is already canonical, returns it unchanged.
 * If name is an alias, returns the canonical name.
 * If name is unrecognized, returns it unchanged (passthrough).
 */
export function normalizeTdp(name: string): string {
  if (TDP_DOMAINS[name]) return name
  for (const [canonical, domain] of Object.entries(TDP_DOMAINS)) {
    if (domain.aliases.includes(name)) return canonical
  }
  return name
}

/**
 * Get TDP keywords in the format used by tactic-scorer.ts.
 * Includes both canonical names AND aliases as keys (all mapping to the
 * same keyword lists) so that nodeMatchesTdp works with either form.
 */
export function getTdpKeywords(): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [name, domain] of Object.entries(TDP_DOMAINS)) {
    result[name] = domain.keywords
    for (const alias of domain.aliases) {
      result[alias] = domain.keywords
    }
  }
  return result
}
