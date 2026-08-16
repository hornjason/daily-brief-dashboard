import { google } from 'googleapis'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'

const GOOGLE_DOC_URL_PATTERN = /^https?:\/\/(docs\.google\.com\/(document|presentation|spreadsheets)|drive\.google\.com\/file)\/d\//

export function isGoogleDocUrl(url: string): boolean {
  return GOOGLE_DOC_URL_PATTERN.test(url)
}

export function extractFileId(url: string): string | null {
  const match = url.match(/\/d\/([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
}

export async function extractMaterialContent(fileId: string): Promise<{ title: string; content: string }> {
  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  const meta = await drive.files.get({
    fileId,
    fields: 'name,mimeType',
    supportsAllDrives: true,
  })

  const title = meta.data.name ?? 'Untitled'

  const exportRes = await drive.files.export(
    { fileId, mimeType: 'text/plain' },
    { responseType: 'text' },
  )

  const content = typeof exportRes.data === 'string' ? exportRes.data : String(exportRes.data)

  return { title, content }
}
