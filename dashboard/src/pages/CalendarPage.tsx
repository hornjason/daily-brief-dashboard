/**
 * CalendarPage — Route: /dashboard/calendar
 * GitHub Issue #239
 *
 * Extracted from the monolithic Dashboard component in App.tsx.
 * Displays: CalendarStrip with meeting prep triggers and all-events toggle.
 * Fetches its own calendar, case, and account data via useApi.
 */
import { useApi } from '../hooks/useApi'
import { CalendarStrip } from '../components/CalendarStrip'
import type { CalendarEvent, SupportCase, AccountInfo } from '../types'

interface CalendarPageProps {
  refreshKey: number
  activePodId: string
}

export function CalendarPage({ refreshKey, activePodId }: CalendarPageProps) {
  const calendarApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&_=${refreshKey}`)
  const calendarAllApi = useApi<{ events: CalendarEvent[] }>(`/api/calendar?range=week&all=true&_=${refreshKey}`)
  const casesApi = useApi<{ cases: SupportCase[]; totalCount: number }>(`/api/cases/all?_=${refreshKey}`)
  const podQuery = activePodId ? `&pod=${activePodId}` : ''
  const accountsApi = useApi<{ customers: AccountInfo[] }>(`/api/accounts?_=${refreshKey}${podQuery}`)

  return (
    <main className="flex-1 overflow-y-auto p-6 space-y-6">
      <section id="section-calendar" data-section="section-calendar">
        <CalendarStrip
          events={calendarApi.data?.events ?? []}
          allEvents={calendarAllApi.data?.events ?? []}
          cases={casesApi.data?.cases ?? []}
          accounts={accountsApi.data?.customers ?? []}
          loading={calendarApi.loading || calendarAllApi.loading}
        />
      </section>
    </main>
  )
}
