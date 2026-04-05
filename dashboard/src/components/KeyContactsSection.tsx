import { useMemo } from 'react'
import { Users, Calendar, Mail } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface Contact {
  email: string
  name: string
  interactions: number
  sources: Set<'meeting' | 'email'>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-border/40 rounded animate-pulse-slow ${className}`} />
}

const SKIP_EMAILS = /noreply|no-reply|gemini-notes|calendar-notification|notifications|donotreply|bounce|mailer-daemon|jhorn@redhat\.com/i

function parseEmailAddress(raw: string): string {
  const angleMatch = raw.match(/<([^>]+)>/)
  const email = angleMatch ? angleMatch[1].trim() : raw.replace(/^"[^"]*"\s*/, '').trim()
  return email.toLowerCase()
}

function parseSenderName(raw: string): string | null {
  const angleMatch = raw.match(/^"?([^"<]+?)"?\s*</)
  if (angleMatch) {
    const name = angleMatch[1].trim().replace(/^"|"$/g, '')
    if (name && !name.includes('@')) return name
  }
  return null
}

// ── KeyContactsSection ────────────────────────────────────────────────────────

export function KeyContacts({ meetings, emails, loading }: { meetings: any[]; emails: any[]; loading: boolean }) {
  const contacts = useMemo((): Contact[] => {
    const map = new Map<string, Contact>()

    function touch(email: string, rawName: string | null, source: 'meeting' | 'email') {
      if (!email || !email.includes('@') || SKIP_EMAILS.test(email)) return
      const existing = map.get(email)
      if (existing) {
        existing.interactions++
        existing.sources.add(source)
        if (!existing.name && rawName) existing.name = rawName
      } else {
        const fallback = email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())
        map.set(email, { email, name: rawName ?? fallback, interactions: 1, sources: new Set([source]) })
      }
    }

    for (const ev of meetings) {
      for (const addr of ev.attendees ?? []) {
        touch(addr.toLowerCase(), null, 'meeting')
      }
    }

    for (const em of emails) {
      if (!em.from) continue
      const email = parseEmailAddress(em.from)
      const name = parseSenderName(em.from)
      touch(email, name, 'email')
    }

    return Array.from(map.values())
      .sort((a, b) => b.interactions - a.interactions)
      .slice(0, 10)
  }, [meetings, emails])

  if (!loading && contacts.length === 0) return null

  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center gap-2 mb-4">
        <Users className="w-4 h-4 text-accent" />
        <h2 className="text-base font-semibold text-text-primary">Key Contacts</h2>
        {!loading && <span className="text-xs text-text-secondary">{contacts.length}</span>}
      </div>

      {loading && (
        <div className="space-y-2.5">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-8" />)}
        </div>
      )}

      {!loading && (
        <div className="space-y-2">
          {contacts.map((c) => {
            const domain = c.email.split('@')[1] ?? ''
            const isExternal = !domain.endsWith('redhat.com')
            return (
              <div key={c.email} className="flex items-center gap-3">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${
                  isExternal ? 'bg-accent/15 text-accent' : 'bg-border/60 text-text-secondary'
                }`}>
                  {c.name[0]?.toUpperCase() ?? '?'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary truncate" title={c.name}>{c.name}</p>
                  <p className="text-xs text-text-secondary truncate" title={c.email}>{c.email}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {c.sources.has('meeting') && <span title="Met in meeting"><Calendar className="w-3 h-3 text-text-secondary" /></span>}
                  {c.sources.has('email') && <span title="Email contact"><Mail className="w-3 h-3 text-text-secondary" /></span>}
                  <span className="text-xs text-text-secondary">{c.interactions}×</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
