import type { SupportCase, Renewal, Customer, CustomerSubscription } from './types.ts'

const SSO_URL = 'https://sso.redhat.com/auth/realms/redhat-external/protocol/openid-connect/token'
const SUPPORT_API = 'https://api.access.redhat.com/support/v1'
const MGMT_API = 'https://api.access.redhat.com/management/v1'

let cachedToken: string | null = null
let tokenExpiry = 0

async function getToken(): Promise<string> {
  const now = Date.now()
  if (cachedToken && now < tokenExpiry - 60_000) return cachedToken

  const offline = process.env.REDHAT_OFFLINE_TOKEN
  if (!offline) throw new Error('REDHAT_OFFLINE_TOKEN not set — add it to .env')

  const res = await fetch(SSO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'rhsm-api',
      refresh_token: offline,
    }),
  })
  if (!res.ok) throw new Error(`RH SSO ${res.status}: ${await res.text()}`)

  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = data.access_token
  tokenExpiry = now + data.expires_in * 1000
  return cachedToken
}

async function rhGet(url: string): Promise<any> {
  const token = await getToken()
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`RH API ${res.status}: ${await res.text()}`)
  return res.json()
}

async function rhPost(url: string, body: object): Promise<any> {
  const token = await getToken()
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`RH API ${res.status}: ${await res.text()}`)
  return res.json()
}

export async function fetchCases(): Promise<SupportCase[]> {
  const data = await rhPost(`${SUPPORT_API}/cases/filter`, { offset: 0, maxResults: 100 })
  const cases: any[] = Array.isArray(data) ? data : (data.cases ?? [])

  const open = cases.filter((c) => {
    const s = (c.status ?? '').toLowerCase()
    return s.includes('wait') || s.includes('progress') || s === 'new'
  })

  return open
    .map((c) => {
      const created = new Date(c.createdDate ?? 0)
      const daysOpen = Math.max(0, Math.floor((Date.now() - created.getTime()) / 86_400_000))
      return {
        caseNumber: c.caseNumber ?? '',
        summary: c.summary ?? '',
        status: c.status ?? '',
        severity: String(c.severity ?? '4'),
        accountNumber: c.accountNumber ?? '',
        daysOpen,
        product: c.product,
      } satisfies SupportCase
    })
    .sort((a, b) => parseInt(a.severity) - parseInt(b.severity) || b.daysOpen - a.daysOpen)
}

export async function fetchCustomerCases(customer: Customer): Promise<SupportCase[]> {
  const accountNums = (customer.accountNumbers ?? []).map(String)
  if (accountNums.length === 0) return []
  const all = await fetchCases().catch(() => [] as SupportCase[])
  return all.filter((c) => accountNums.includes(String(c.accountNumber)))
}

export async function fetchCustomerSubscriptions(customer: Customer): Promise<CustomerSubscription[]> {
  const accountNums = (customer.accountNumbers ?? []).map(String)
  if (accountNums.length === 0) return []

  const data = await rhGet(`${MGMT_API}/subscriptions?limit=200`).catch(() => null)
  if (!data) return []
  const subs: any[] = Array.isArray(data) ? data : (data.body ?? [])

  const today = Date.now()
  return subs
    .filter((s) => accountNums.includes(String(s.accountNumber)) && s.status === 'Active')
    .map((s) => ({
      subscriptionNumber: s.subscriptionNumber ?? '',
      productName: s.subscriptionName ?? s.productName ?? 'Unknown',
      quantity: Number(s.quantity ?? 1),
      endDate: s.endDate ?? '',
      daysLeft: s.endDate ? Math.ceil((new Date(s.endDate).getTime() - today) / 86_400_000) : 9999,
      status: s.status ?? '',
    } satisfies CustomerSubscription))
    .sort((a, b) => a.daysLeft - b.daysLeft)
}

export async function fetchRenewals(customers: Customer[] = []): Promise<Renewal[]> {
  const data = await rhGet(`${MGMT_API}/subscriptions?limit=200`)
  const subs: any[] = Array.isArray(data) ? data : (data.body ?? [])

  const cutoff = new Date(Date.now() + 120 * 86_400_000)
  const today = Date.now()

  return subs
    .filter((s) => s.status === 'Active' && s.endDate && new Date(s.endDate) <= cutoff)
    .map((s) => {
      const daysLeft = Math.ceil((new Date(s.endDate).getTime() - today) / 86_400_000)
      const subNum = s.subscriptionNumber ?? ''

      // Match customer by accountNumber if customers.json has it populated
      const matched = customers.find(
        (c) => (c as any).accountNumbers?.map(String).includes(String(s.accountNumber))
      )

      return {
        subscriptionNumber: subNum,
        subscriptionName: s.subscriptionName,
        customerName: matched?.name,
        endDate: s.endDate,
        daysLeft,
        quantity: Number(s.quantity ?? 1),
        status: s.status,
        portalUrl: 'https://access.redhat.com/management/subscriptions',
      } satisfies Renewal
    })
    .sort((a, b) => a.daysLeft - b.daysLeft)
}
