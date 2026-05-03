import { useState, useEffect } from 'react'
import type { CalendarEvent, SupportCase } from '../types'

export interface EmailHighlight {
  customer: string
  subject: string
  from: string
  date: string
  snippet: string
  actionRequired: boolean
}

export interface DriveFile {
  name: string
  mimeType: string
  modifiedTime?: string
  webViewLink?: string
  customer?: string
}

export interface CustomerSubscription {
  subscriptionNumber: string
  productName: string
  quantity: number
  endDate: string
  daysLeft: number
  status: string
}

export interface CustomerMeta {
  name: string
  domain?: string
  accountNumbers?: number[]
  ae?: string
  segment?: string
  region?: string
}

export interface CustomerSSEState {
  meta: CustomerMeta | null
  meetings: CalendarEvent[]
  emails: EmailHighlight[]
  drive: DriveFile[]
  cases: SupportCase[]
  subscriptions: CustomerSubscription[]
  loading: boolean
  completedAt: string | null
  error: string | null
}

const emptyState = (): CustomerSSEState => ({
  meta: null,
  meetings: [],
  emails: [],
  drive: [],
  cases: [],
  subscriptions: [],
  loading: true,
  completedAt: null,
  error: null,
})

export function useCustomerSSE(customerName: string): CustomerSSEState {
  const [state, setState] = useState<CustomerSSEState>(emptyState)

  useEffect(() => {
    if (!customerName) return

    setState(emptyState())

    const es = new EventSource(`/customer/${encodeURIComponent(customerName)}/events`)

    es.addEventListener('meta', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, meta: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] meta parse failed', err) }
    })
    es.addEventListener('meetings', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, meetings: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] meetings parse failed', err) }
    })
    es.addEventListener('emails', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, emails: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] emails parse failed', err) }
    })
    es.addEventListener('drive', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, drive: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] drive parse failed', err) }
    })
    es.addEventListener('cases', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, cases: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] cases parse failed', err) }
    })
    es.addEventListener('subscriptions', (e: MessageEvent) => {
      try { setState((s) => ({ ...s, subscriptions: JSON.parse(e.data) })) } catch (err) { console.error('[useCustomerSSE] subscriptions parse failed', err) }
    })
    es.addEventListener('complete', (e: MessageEvent) => {
      try {
        const { timestamp } = JSON.parse(e.data)
        setState((s) => ({ ...s, loading: false, completedAt: timestamp }))
      } catch (err) { console.error('[useCustomerSSE] complete parse failed', err) }
      es.close()
    })

    es.onerror = () => {
      setState((s) => ({ ...s, loading: false, error: 'Connection error — data may be incomplete' }))
      es.close()
    }

    return () => es.close()
  }, [customerName])

  return state
}
