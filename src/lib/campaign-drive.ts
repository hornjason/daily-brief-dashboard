/**
 * Campaign Drive Persistence — Google Drive upload for campaigns
 * Extracted from campaign-service.ts (#1172).
 */

import { google } from 'googleapis'
import { Readable } from 'stream'
import { driveClient } from './drive-client.ts'
import { makeAuth, GOOGLE_UNIFIED_TOKEN_PATH } from '../google.ts'
import { getAccountTeam } from '../account-team.ts'
import type { Customer } from '../types.ts'
import type { CustomerSignals } from './signal-loader.ts'

export async function ensureCampaignsSubfolder(customerFolderId: string): Promise<string> {
  return driveClient.ensureChildFolder(customerFolderId, 'Campaigns')
}

export async function uploadCampaignToDrive(
  customerFolderId: string,
  customer: Customer,
  materialTitle: string,
  materialUrl: string,
  markdown: string,
  aeName: string,
  signals: CustomerSignals,
  accountTeamOverride?: import('../types.ts').AccountTeamMember[],
  existingFileIds?: { driveFileId?: string; driveHtmlFileId?: string },
  campaignDirective?: string,
  prebuiltHtml?: string,
): Promise<{ driveUrl: string; htmlUrl: string; driveFileId: string; driveHtmlFileId: string }> {
  const campaignsFolderId = await ensureCampaignsSubfolder(customerFolderId)
  const campaignLabel = campaignDirective
    ? campaignDirective.split(/[.!?\n]/)[0].trim().substring(0, 60)
    : materialTitle
  const docName = `${campaignLabel} - ${customer.name}`

  const accountTeam = accountTeamOverride ?? getAccountTeam(customer)
  const htmlContent = prebuiltHtml ?? ''

  const auth = makeAuth(GOOGLE_UNIFIED_TOKEN_PATH)
  const drive = google.drive({ version: 'v3', auth })

  let driveFileId = ''
  let driveUrl = ''

  if (existingFileIds?.driveFileId) {
    try {
      await drive.files.update({
        fileId: existingFileIds.driveFileId,
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        supportsAllDrives: true,
      })
      driveFileId = existingFileIds.driveFileId
      driveUrl = `https://docs.google.com/document/d/${driveFileId}/edit`
      console.log(`[campaigns] Updated Google Doc in-place (PATCH): ${driveUrl}`)
    } catch (e: any) {
      if (e?.code === 404 || e?.status === 404) {
        console.warn(`[campaigns] Cached doc ${existingFileIds.driveFileId} not found — creating new`)
      } else {
        console.warn(`[campaigns] Doc update failed — creating new:`, e?.message)
      }
    }
  }

  if (!driveFileId) {
    const docResponse = await drive.files.create({
      requestBody: {
        name: docName,
        mimeType: 'application/vnd.google-apps.document',
        parents: [campaignsFolderId],
      },
      media: {
        mimeType: 'text/html',
        body: Readable.from(Buffer.from(htmlContent)),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    })
    driveFileId = docResponse.data.id ?? ''
    driveUrl = docResponse.data.webViewLink ?? `https://docs.google.com/document/d/${driveFileId}/edit`
    console.log(`[campaigns] Created Google Doc from HTML: ${docName} → ${driveUrl}`)
  }

  let htmlFileId = ''
  let htmlUrl = ''

  if (existingFileIds?.driveHtmlFileId) {
    try {
      const updateResponse = await drive.files.update({
        fileId: existingFileIds.driveHtmlFileId,
        media: {
          mimeType: 'text/html',
          body: Readable.from(Buffer.from(htmlContent)),
        },
        fields: 'id,webViewLink',
        supportsAllDrives: true,
      })
      htmlFileId = updateResponse.data.id ?? existingFileIds.driveHtmlFileId
      htmlUrl = updateResponse.data.webViewLink ?? `https://drive.google.com/file/d/${htmlFileId}/view`
      console.log(`[campaigns] Updated HTML file in-place (PATCH): ${htmlFileId}`)
    } catch (e: any) {
      if (e?.code === 404 || e?.status === 404) {
        console.warn(`[campaigns] Cached HTML file ${existingFileIds.driveHtmlFileId} not found (404) — creating new`)
      } else {
        console.warn(`[campaigns] HTML update failed — creating new:`, e?.message)
      }
    }
  }

  if (!htmlFileId) {
    const htmlResponse = await drive.files.create({
      requestBody: {
        name: `${docName}.html`,
        parents: [campaignsFolderId],
      },
      media: {
        mimeType: 'text/html',
        body: Readable.from(Buffer.from(htmlContent)),
      },
      fields: 'id,webViewLink',
      supportsAllDrives: true,
    })
    htmlFileId = htmlResponse.data.id ?? ''
    htmlUrl = htmlResponse.data.webViewLink ?? `https://drive.google.com/file/d/${htmlFileId}/view`
    console.log(`[campaigns] Created HTML file: ${docName}.html → ${htmlUrl}`)
  }

  return { driveUrl, htmlUrl, driveFileId, driveHtmlFileId: htmlFileId }
}
