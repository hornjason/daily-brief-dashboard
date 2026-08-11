// src/route-registry.ts
// Route Registry — Layer 10 API Surface catalog
//
// Centralizes the route inventory for the Hono-based API surface.
// This registry enables pattern consistency enforcement (#174) and provides
// a single source of truth for architecture compliance tests.

export interface RouteComponent {
  /** Route module name (human-readable) */
  name: string
  /** File path relative to src/ */
  filePath: string
  /** HTTP methods supported (e.g., GET, POST, DELETE, PATCH) */
  methods: string
  /** Description of what this route module handles */
  description: string
}

const _routes: RouteComponent[] = []

export const RouteRegistry = {
  /** Register a route component */
  register(component: RouteComponent): void {
    _routes.push(component)
  },

  /** Get all registered routes */
  list(): RouteComponent[] {
    return [..._routes]
  },

  /** Get route count */
  count(): number {
    return _routes.length
  },
}

// ── Admin & Monitoring Routes ────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Admin Routes',
  filePath: 'admin-routes.ts',
  methods: 'GET, POST',
  description: 'Admin, monitoring, telemetry, and Drive diagnostic endpoints',
})

// ── Account Executive Management ─────────────────────────────────────────────
RouteRegistry.register({
  name: 'AE Routes',
  filePath: 'ae-routes.ts',
  methods: 'GET, POST',
  description: 'AE management, Drive folder validation, and settings distribution',
})

// ── Authentication ───────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Auth Routes',
  filePath: 'auth-routes.ts',
  methods: 'GET, POST',
  description: 'Authentication flows, token management, and session handling',
})

// ── Backup & Restore ─────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Backup Routes',
  filePath: 'backup-routes.ts',
  methods: 'GET, POST',
  description: 'Data backup operations and backup status queries',
})

RouteRegistry.register({
  name: 'Restore Routes',
  filePath: 'restore-routes.ts',
  methods: 'POST',
  description: 'Data restoration from backups',
})

// ── Batch Operations ─────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Batch Routes',
  filePath: 'batch-routes.ts',
  methods: 'POST',
  description: 'Batch processing operations across multiple entities',
})

// ── Campaign Management ──────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Campaigns Routes',
  filePath: 'campaigns-routes.ts',
  methods: 'GET, POST',
  description: 'Marketing campaign management and execution',
})

// ── Cloud Marketplace ────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Cloud Marketplace Routes',
  filePath: 'cloud-marketplace-routes.ts',
  methods: 'GET',
  description: 'Cloud marketplace data and product listings',
})

// ── Customer Operations ──────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Customer Routes',
  filePath: 'customer-routes.ts',
  methods: 'GET, POST',
  description: 'Customer data, briefs, intelligence, and account operations',
})

// ── Dashboard ────────────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Dashboard Routes',
  filePath: 'dashboard-routes.ts',
  methods: 'GET',
  description: 'Main dashboard data aggregation and presentation',
})

// ── Document Sources ─────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Document Sources Routes',
  filePath: 'document-sources-routes.ts',
  methods: 'GET',
  description: 'Document source management and metadata queries',
})

// ── Events ───────────────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Events Routes',
  filePath: 'events-routes.ts',
  methods: 'GET',
  description: 'Event data, attendee profiles, and event management',
})

// ── Feature Modules ──────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Feature Module Routes',
  filePath: 'feature-module-routes.ts',
  methods: 'GET',
  description: 'Feature module registry queries and metadata',
})

// ── Intelligence Graph ───────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Graph Routes',
  filePath: 'graph-routes.ts',
  methods: 'GET, POST',
  description: 'Intelligence graph queries, expansion motion, and graph health',
})

// ── Intelligence Surfaces ────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Intelligence Routes',
  filePath: 'intelligence-routes.ts',
  methods: 'GET, POST, DELETE, PATCH',
  description: 'Red Hat intelligence: news, roadmap, events, and RSS feeds',
})

// ── Meeting Preparation ──────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Meeting Prep Routes',
  filePath: 'meeting-prep-routes.ts',
  methods: 'GET, POST',
  description: 'Meeting preparation data and agenda generation',
})

// ── Motion Override ──────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Motion Override Routes',
  filePath: 'motion-override-routes.ts',
  methods: 'GET, POST, DELETE',
  description: 'Strategic motion overrides and configuration',
})

// ── News ─────────────────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'News Routes',
  filePath: 'news-routes.ts',
  methods: 'GET',
  description: 'News feed data and article queries',
})

// ── Node Role Management ─────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Node Role Routes',
  filePath: 'node-role-routes.ts',
  methods: 'GET',
  description: 'Multi-node deployment role identification',
})

// ── People & Contacts ────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'People Routes',
  filePath: 'people-routes.ts',
  methods: 'GET',
  description: 'People directory, contact info, and org charts',
})

// ── Playbooks ────────────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Playbook Routes',
  filePath: 'playbook-routes.ts',
  methods: 'GET',
  description: 'Playbook library and execution workflows',
})

// ── Product Intelligence ─────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Product Intel Routes',
  filePath: 'product-intel-routes.ts',
  methods: 'GET, POST',
  description: 'Product intelligence queries and semantic search',
})

// ── Region Access Control ────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Region Access Routes',
  filePath: 'region-access-routes.ts',
  methods: 'GET',
  description: 'Region-based access control and customer visibility',
})

// ── Setup & Bootstrap ────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Setup Routes',
  filePath: 'setup-routes.ts',
  methods: 'GET, POST',
  description: 'Initial setup, bootstrap, and configuration workflows',
})

// ── Territory Management ─────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Territory Routes',
  filePath: 'territory-routes.ts',
  methods: 'GET, POST, DELETE',
  description: 'Territory definitions, assignments, and hierarchies',
})

// ── Tools & Utilities ────────────────────────────────────────────────────────
RouteRegistry.register({
  name: 'Tools Routes',
  filePath: 'tools-routes.ts',
  methods: 'GET, POST',
  description: 'Utility endpoints and developer tools',
})
