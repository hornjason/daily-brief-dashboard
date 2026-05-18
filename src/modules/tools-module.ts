// src/modules/tools-module.ts
// GitHub Issue #146 — Business value tools feature module registration
// GitHub Issue #150 — NotebookLM sync on artifact upload

import { FeatureModuleRegistry, type NavDeclaration, type AccountTabDeclaration, type ModuleScope } from '../feature-module-registry'
import { customers } from '../server-state'
import { findCustomerDriveFolder } from '../lib/customer-folder'
import { createOrUpdateNotebook } from '../notebooklm'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google'
import { google } from 'googleapis'

FeatureModuleRegistry.register({
  name: 'tools',

  scope: 'customer',

  nav: {
    label: 'Tools',
    icon: 'Wrench',
    group: 'actions',
    path: '/dashboard/tools',
    order: 30,
  },

  accountTab: {
    label: 'Tools',
    icon: 'Wrench',
    order: 40,
  },

  cachePaths: (slug: string) => [
    `data/cache/tools/${slug}.json`,
  ],

  driveArtifacts: (slug: string) => [
    `${slug}/tools/`,
  ],

  notebookSources: true,

  refreshInterval: null,  // on-demand only

  async fetch(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },

  async cleanup(customerName: string): Promise<void> {
    // No-op: Phase 1 shell only
    return Promise.resolve()
  },

  async syncNow(customerName: string): Promise<void> {
    // GitHub Issue #150 — sync customer artifacts to NotebookLM
    if (process.env.NOTEBOOKLM_ENABLED !== 'true') {
      console.log(`[tools-module] NotebookLM sync skipped for ${customerName} — NOTEBOOKLM_ENABLED not set`)
      return
    }

    // Find customer in customers array (case-insensitive lookup)
    const customer = customers.find(c => c.name.toLowerCase() === customerName.toLowerCase())
    if (!customer) {
      throw new Error(`Customer '${customerName}' not found`)
    }

    // Resolve customer Drive folder
    const customerFolderId = await findCustomerDriveFolder(customer)

    // Find Account Intelligence subfolder
    const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
    const drive = google.drive({ version: 'v3', auth })

    const existing = await drive.files.list({
      q: `'${customerFolderId}' in parents and name = 'Account Intelligence' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id,name)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const intelligenceFolderId = existing.data.files?.[0]?.id
    if (!intelligenceFolderId) {
      console.log(`[tools-module] No Account Intelligence subfolder found for ${customerName}`)
      return
    }

    // List files in intelligence subfolder
    const fileList = await drive.files.list({
      q: `'${intelligenceFolderId}' in parents and trashed = false`,
      fields: 'files(id,name,modifiedTime)',
      orderBy: 'modifiedTime desc',
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const driveFiles = (fileList.data.files ?? []).map(f => ({
      id: f.id ?? '',
      name: f.name ?? '',
      modifiedTime: f.modifiedTime ?? '',
    }))

    // Sync to NotebookLM
    await createOrUpdateNotebook(customer, driveFiles)
    console.log(`[tools-module] Synced ${driveFiles.length} files to NotebookLM for ${customerName}`)
  },
})
