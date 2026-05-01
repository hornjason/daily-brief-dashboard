// ── BKL-BACKUP-01: Backup admin routes ──────────────────────────────────────
import { Hono } from 'hono'
import { _backupNowImmediate, restoreFromBackup, getBackupSheetId, getLastBackupTimestamp } from './backup-config.ts'
import { loadServerState } from './server-state.ts'
import { sanitizeErr } from './utils.ts'

export function createBackupRouter(): Hono {
  const router = new Hono()

  // POST /api/admin/backup — trigger an immediate backup
  router.post('/api/admin/backup', async (c) => {
    try {
      const result = await _backupNowImmediate()
      return c.json(result)
    } catch (e: any) {
      return c.json({ ok: false, error: sanitizeErr(e) }, 500)
    }
  })

  // GET /api/admin/backup/status — current backup sheet info
  router.get('/api/admin/backup/status', (c) => {
    const sheetId = getBackupSheetId()
    return c.json({
      sheetId,
      lastBackup: getLastBackupTimestamp(),
      hasSheet: !!sheetId,
    })
  })

  // POST /api/admin/backup/restore — restore config from backup sheet
  router.post('/api/admin/backup/restore', async (c) => {
    try {
      const result = await restoreFromBackup()
      // Reload server state from the freshly restored files
      if (result.ok) {
        loadServerState()
      }
      return c.json(result)
    } catch (e: any) {
      return c.json({ ok: false, sections: [], errors: [sanitizeErr(e)] }, 500)
    }
  })

  return router
}
