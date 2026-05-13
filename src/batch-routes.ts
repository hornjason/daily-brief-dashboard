/**
 * Batch Execution API — GitHub Issue #168
 *
 * POST /api/batch/execute — run actions across multiple customers with SSE streaming progress
 *
 * Supports:
 * - campaigns: generate campaigns for multiple customers
 * - news-refresh: refresh news radar for multiple customers
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { customers } from './server-state.ts'
import { FeatureModuleRegistry } from './feature-module-registry.ts'
import { toSlug } from './cache-layer.ts'
import { sanitizeErr } from './utils.ts'
import { generateCampaign, type CampaignRequest } from './campaigns-routes.ts'
import type { Customer } from './types.ts'

// ── Types ─────────────────────────────────────────────────────────────────────

interface BatchExecuteRequest {
  action: 'campaigns' | 'news-refresh'
  customerNames: string[]
  config?: {
    materialUrl?: string
    personas?: Array<{ role: string; relevantVPs: string[]; enabled: boolean }>
    style?: string
    valueProps?: Array<{ id: string; claim: string; detail: string }>
  }
}

interface BatchProgressEvent {
  customer: string
  status: 'running' | 'done' | 'failed'
  driveUrl?: string
  error?: string
}

interface BatchCompleteEvent {
  status: 'complete'
  succeeded: number
  failed: number
}

// ── Router ────────────────────────────────────────────────────────────────────

export function createBatchRouter(): Hono {
  const router = new Hono()

  router.post('/api/batch/execute', async (c) => {
    let body: BatchExecuteRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    const { action, customerNames, config } = body

    // Validate
    if (!action) {
      return c.json({ error: 'Missing action (campaigns | news-refresh)' }, 400)
    }
    if (!customerNames || !Array.isArray(customerNames) || customerNames.length === 0) {
      return c.json({ error: 'Missing customerNames array' }, 400)
    }
    if (action === 'campaigns' && !config?.materialUrl) {
      return c.json({ error: 'campaigns action requires config.materialUrl' }, 400)
    }

    // Stream SSE progress
    return streamSSE(c, async (stream) => {
      let succeeded = 0
      let failed = 0

      for (const name of customerNames) {
        // Send "running" event
        const runningEvent: BatchProgressEvent = { customer: name, status: 'running' }
        await stream.writeSSE({
          data: JSON.stringify(runningEvent),
          event: 'progress',
        })

        try {
          if (action === 'campaigns') {
            // Find customer
            const customer = customers.find((cu) => cu.name.toLowerCase() === name.toLowerCase())
              || customers.find((cu) => toSlug(cu.name) === name)

            if (!customer) {
              const errorEvent: BatchProgressEvent = {
                customer: name,
                status: 'failed',
                error: 'Customer not found',
              }
              await stream.writeSSE({
                data: JSON.stringify(errorEvent),
                event: 'progress',
              })
              failed++
              continue
            }

            // Generate campaign
            const result = await generateCampaign(customer, config!.materialUrl!)

            const doneEvent: BatchProgressEvent = {
              customer: name,
              status: 'done',
              driveUrl: result.driveUrl,
            }
            await stream.writeSSE({
              data: JSON.stringify(doneEvent),
              event: 'progress',
            })
            succeeded++
          } else if (action === 'news-refresh') {
            // Get news module
            const newsModule = FeatureModuleRegistry.get('news-radar')

            if (!newsModule) {
              const errorEvent: BatchProgressEvent = {
                customer: name,
                status: 'failed',
                error: 'news-radar module not registered',
              }
              await stream.writeSSE({
                data: JSON.stringify(errorEvent),
                event: 'progress',
              })
              failed++
              continue
            }

            // Execute fetch
            await newsModule.fetch(name)

            const doneEvent: BatchProgressEvent = {
              customer: name,
              status: 'done',
            }
            await stream.writeSSE({
              data: JSON.stringify(doneEvent),
              event: 'progress',
            })
            succeeded++
          }
        } catch (e: any) {
          const errorEvent: BatchProgressEvent = {
            customer: name,
            status: 'failed',
            error: sanitizeErr(e),
          }
          await stream.writeSSE({
            data: JSON.stringify(errorEvent),
            event: 'progress',
          })
          failed++
        }

        // Rate limit delay (2s between customers)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      // Send complete event
      const completeEvent: BatchCompleteEvent = {
        status: 'complete',
        succeeded,
        failed,
      }
      await stream.writeSSE({
        data: JSON.stringify(completeEvent),
        event: 'complete',
      })
    })
  })

  return router
}
