// src/browser-utils.ts — Shared Chromium launch flags (no imports from other src/ modules)

/** Base Chromium flags required for container stability (2GB shm, 8GB mem) */
export const BASE_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--renderer-process-limit=2',
  '--no-restore-last-session', // BKL-UX74: prevent stale tabs (e.g. Supportable) from restoring on launch
]
