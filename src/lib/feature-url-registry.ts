/**
 * Feature URL Registry — static typed array parsed from EMAIL-OUTREACH-SPEC.md
 *
 * Provides verified Red Hat feature URLs for campaign email generation.
 * URLs are resolved mechanically by feature key — Gemini never provides URLs.
 *
 * Source: ~/.claude/PAI/Specs/EMAIL-OUTREACH-SPEC.md § Verified Feature URL Registry
 * Last synced: 2026-08-12
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface FeatureRegistryEntry {
  featureKey: string
  featureName: string
  url: string
  product: 'ansible' | 'openshift' | 'rhel'
}

// ── Registry ─────────────────────────────────────────────────────────────────

const FEATURE_REGISTRY: readonly FeatureRegistryEntry[] = [
  // ── Ansible Automation Platform ──
  {
    featureKey: 'ansible-automation-platform',
    featureName: 'Ansible Automation Platform',
    url: 'https://www.redhat.com/en/technologies/management/ansible',
    product: 'ansible',
  },
  {
    featureKey: 'event-driven-ansible',
    featureName: 'Event-Driven Ansible',
    url: 'https://www.redhat.com/en/technologies/management/ansible/event-driven-ansible',
    product: 'ansible',
  },
  {
    featureKey: 'ansible-lightspeed-coding-assistant',
    featureName: 'Ansible Lightspeed / Coding Assistant',
    url: 'https://www.redhat.com/en/technologies/management/ansible/automation-coding-assistant',
    product: 'ansible',
  },
  {
    featureKey: 'automation-mesh',
    featureName: 'Automation Mesh',
    url: 'https://www.redhat.com/en/technologies/management/ansible/automation-mesh',
    product: 'ansible',
  },
  {
    featureKey: 'execution-environments',
    featureName: 'Execution Environments',
    url: 'https://www.redhat.com/en/technologies/management/ansible/automation-execution-environments',
    product: 'ansible',
  },
  {
    featureKey: 'automation-dashboard-aap-2-6',
    featureName: 'Automation Dashboard (AAP 2.6)',
    url: 'https://www.redhat.com/en/blog/whats-new-in-ansible-automation-platform-2.6',
    product: 'ansible',
  },
  {
    featureKey: 'aiops-overview',
    featureName: 'AIOps Overview',
    url: 'https://www.redhat.com/en/technologies/management/ansible/ai-automation',
    product: 'ansible',
  },
  {
    featureKey: 'event-driven-automation',
    featureName: 'Event-Driven Automation (concept)',
    url: 'https://www.redhat.com/en/topics/automation/what-is-event-driven-automation',
    product: 'ansible',
  },
  {
    featureKey: 'aiops-ansible-splunk-servicenow',
    featureName: 'AIOps + Ansible (Splunk/ServiceNow)',
    url: 'https://www.redhat.com/en/blog/aiops-and-ansible-automation-platform-where-ai-intelligence-meets-trusted-execution',
    product: 'ansible',
  },
  {
    featureKey: 'vertex-ai-eda-mlops',
    featureName: 'Vertex AI + EDA (MLOps)',
    url: 'https://www.redhat.com/en/blog/aiops-and-mlops-made-simple-automating-vertex-ai-red-hat-ansible-automation-platform',
    product: 'ansible',
  },
  {
    featureKey: 'ai-monitoring-agent',
    featureName: 'AI Monitoring Agent',
    url: 'https://developers.redhat.com/articles/2026/02/10/debug-ansible-errors-faster-ai-monitoring-agent',
    product: 'ansible',
  },
  {
    featureKey: 'mcp-server-for-aap',
    featureName: 'MCP Server for AAP',
    url: 'https://www.redhat.com/en/blog/it-automation-agentic-ai-introducing-mcp-server-red-hat-ansible-automation-platform',
    product: 'ansible',
  },

  // ── OpenShift ──
  {
    featureKey: 'openshift-container-platform',
    featureName: 'OpenShift Container Platform',
    url: 'https://www.redhat.com/en/technologies/cloud-computing/openshift',
    product: 'openshift',
  },
  {
    featureKey: 'openshift-virtualization',
    featureName: 'OpenShift Virtualization',
    url: 'https://www.redhat.com/en/technologies/cloud-computing/openshift/virtualization',
    product: 'openshift',
  },
  {
    featureKey: 'openshift-ai',
    featureName: 'OpenShift AI',
    url: 'https://www.redhat.com/en/products/ai/openshift-ai',
    product: 'openshift',
  },
  {
    featureKey: 'advanced-cluster-management',
    featureName: 'Advanced Cluster Management (ACM)',
    url: 'https://www.redhat.com/en/technologies/management/advanced-cluster-management',
    product: 'openshift',
  },
  {
    featureKey: 'advanced-cluster-security',
    featureName: 'Advanced Cluster Security (ACS)',
    url: 'https://www.redhat.com/en/technologies/cloud-computing/openshift/advanced-cluster-security-kubernetes',
    product: 'openshift',
  },
  {
    featureKey: 'getting-started-with-openshift',
    featureName: 'Getting Started with OpenShift',
    url: 'https://developers.redhat.com/products/openshift/getting-started',
    product: 'openshift',
  },
  {
    featureKey: 'virtualization-in-2026',
    featureName: 'Virtualization in 2026 (blog)',
    url: 'https://www.redhat.com/en/blog/virtualization-2026-building-platform-vms-containers-and-ai',
    product: 'openshift',
  },

  // ── RHEL & Other ──
  {
    featureKey: 'red-hat-enterprise-linux',
    featureName: 'Red Hat Enterprise Linux',
    url: 'https://www.redhat.com/en/technologies/linux-platforms/enterprise-linux',
    product: 'rhel',
  },
  {
    featureKey: 'rhel-ai',
    featureName: 'RHEL AI',
    url: 'https://www.redhat.com/en/products/ai/enterprise-linux-ai',
    product: 'rhel',
  },
  {
    featureKey: 'red-hat-developer-hub',
    featureName: 'Red Hat Developer Hub',
    url: 'https://www.redhat.com/en/products/developer-hub',
    product: 'rhel',
  },
  {
    featureKey: 'container-security',
    featureName: 'Container Security (concept)',
    url: 'https://www.redhat.com/en/topics/security/container-security',
    product: 'rhel',
  },
  {
    featureKey: 'kubernetes-clusters',
    featureName: 'Kubernetes Clusters (concept)',
    url: 'https://www.redhat.com/en/topics/containers/what-is-a-kubernetes-cluster',
    product: 'rhel',
  },
  {
    featureKey: 'aiops',
    featureName: 'AIOps (concept)',
    url: 'https://www.redhat.com/en/topics/ai/what-is-aiops',
    product: 'rhel',
  },
  {
    featureKey: 'ai-infrastructure-guide',
    featureName: 'AI Infrastructure Guide',
    url: 'https://access.redhat.com/articles/7118390',
    product: 'rhel',
  },
] as const

// ── Lookup index (built once at import) ──────────────────────────────────────

const keyIndex = new Map<string, FeatureRegistryEntry>(
  FEATURE_REGISTRY.map(entry => [entry.featureKey, entry])
)

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Resolve a feature key to its verified URL.
 * Returns null if the key is not in the registry.
 */
export function resolveFeatureUrl(featureKey: string): string | null {
  return keyIndex.get(featureKey)?.url ?? null
}

/**
 * Resolve a feature key to its full registry entry.
 * Returns null if the key is not in the registry.
 */
export function resolveFeatureEntry(featureKey: string): FeatureRegistryEntry | null {
  return keyIndex.get(featureKey) ?? null
}

/**
 * Return all valid feature keys — used as Gemini enum constraint
 * so the model can only select from verified entries.
 */
export function getFeatureKeys(): string[] {
  return FEATURE_REGISTRY.map(entry => entry.featureKey)
}

export function getFeatureUrlMap(): string {
  return FEATURE_REGISTRY.map(e => `${e.featureKey}: [${e.featureName}](${e.url})`).join('\n')
}
