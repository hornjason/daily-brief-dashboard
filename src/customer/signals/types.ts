// BKL-ARCH-23: Signal source contracts for customer brief XML generation.
// Each signal source owns one <source> block. collect() normalises raw
// inputs (and may do I/O for the docs source). render() is pure and emits
// byte-identical XML to the legacy buildXmlSources() implementation.

import type { ScraperName } from '../../scraper-status-store.ts'
import type { Customer, CalendarEvent, EmailHighlight, DriveFile, SupportCase, CustomerSubscription, ProductSubscription } from '../../types.ts'
import type { PipelineRecord } from '../../pipeline.ts'
import type { CCSPRecord } from '../../sheets.ts'
import type { DocClassification } from '../../doc-extraction.ts'
import type { EmailIntelligence, SilentContact } from '../../email-extraction.ts'
import type { MeetingPrep } from '../../calendar-extraction.ts'

// ── Per-source status (resolved from scraper-status-store) ──────────────────

export interface SignalStatus {
  scraper?: ScraperName
  syncedDate: string
  staleness: 'ok' | 'stale' | 'failed'
  lastSuccess: string | null
  lastError: string | null
}

// ── Discriminated SignalBundle union — one variant per <source> block ───────

export type SignalBundle =
  | { kind: 'subscriptions'; status: SignalStatus; summary: CustomerSubscription[]; detailed: ProductSubscription[] }
  | { kind: 'cases';         status: SignalStatus; items: SupportCase[] }
  | { kind: 'meetings';      status: SignalStatus; items: CalendarEvent[]; preps: Map<string, MeetingPrep> }
  | { kind: 'emails';        status: SignalStatus; items: EmailHighlight[]; classifications: Map<string, EmailIntelligence>; silentContacts: SilentContact[] }
  | { kind: 'docs';          status: SignalStatus; items: DriveFile[]; classifications: Map<string, DocClassification> }
  | { kind: 'pipeline';      status: SignalStatus; items: PipelineRecord[] }
  | { kind: 'ccsp';          status: SignalStatus; items: CCSPRecord[] }

// ── Render context — derived once per buildXmlSources call, passed read-only ─

export interface RenderContext {
  escapeXml: (s: string) => string
  fmt: (iso: string) => string
  today: string
  sourceStatusAttr: (scraper: ScraperName) => string
  emailLimit: number
}

// ── Inputs to collect() — superset of all inputs across all sources ─────────

export interface CollectInputs {
  customer: Customer
  meetings?: CalendarEvent[]
  emails?: EmailHighlight[]
  docs?: DriveFile[]
  cases?: SupportCase[]
  subscriptions?: CustomerSubscription[]
  products?: ProductSubscription[]
  pipeline?: PipelineRecord[]
  ccsp?: CCSPRecord[]
  meetingPreps?: MeetingPrep[]
  emailClassifications?: Map<string, EmailIntelligence>
  docClassifications?: Map<string, DocClassification>
  silentContacts?: SilentContact[]
}

// ── SignalSource interface — implemented per kind ───────────────────────────

export interface SignalSource<B extends SignalBundle = SignalBundle> {
  kind: B['kind']
  collect(input: CollectInputs): Promise<B | null>
  render(bundle: B, ctx: RenderContext): string
}
