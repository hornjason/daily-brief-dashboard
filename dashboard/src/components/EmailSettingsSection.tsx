import { Mail } from 'lucide-react'
import { useSettingsForm } from '../hooks/useSettingsForm'
import { SettingsCard } from './SettingsCard'

interface EmailConfig {
  enabled: boolean
  deliveryTime: string
  timezone: string
  schedule: string
  recipientEmail: string
  sections: {
    meetings: boolean
    emails: boolean
    cases: boolean
    pipeline: boolean
    brief: boolean
  }
}

export function EmailSettingsSection() {
  const { draft, setDraft, saving, saved, error, dirty, handleSave } =
    useSettingsForm<EmailConfig>({
      fetchUrl: '/api/settings/email',
      saveUrl: '/api/settings/email',
      saveMethod: 'PUT',
    })

  if (!draft) return null

  const sectionFields: Array<{ key: keyof EmailConfig['sections']; label: string }> = [
    { key: 'meetings', label: 'Meetings' },
    { key: 'emails',   label: 'Emails' },
    { key: 'cases',    label: 'Support Cases' },
    { key: 'pipeline', label: 'Pipeline' },
    { key: 'brief',    label: 'Customer Briefs' },
  ]

  return (
    <SettingsCard
      title="Morning Brief Email"
      error={error}
      dirty={dirty}
      saving={saving}
      saved={saved}
      onSave={handleSave}
      saveLabel="Save Email Settings"
      saveIcon={<Mail className="w-3.5 h-3.5" />}
    >
      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-text-primary">Enable email delivery</p>
          <p className="text-xs text-text-secondary">Send a morning brief email at the scheduled time</p>
        </div>
        <button
          onClick={() => setDraft(d => d ? { ...d, enabled: !d.enabled } : d)}
          className={`relative w-10 h-5 rounded-full transition-colors ${draft.enabled ? 'bg-accent' : 'bg-border'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${draft.enabled ? 'translate-x-5' : 'translate-x-0.5'}`} />
        </button>
      </div>

      {draft.enabled && (
        <>
          {/* Delivery time */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-text-primary">Delivery time</p>
              <p className="text-xs text-text-secondary">When to send the morning brief (ET)</p>
            </div>
            <input
              type="time"
              value={draft.deliveryTime}
              onChange={e => setDraft(d => d ? { ...d, deliveryTime: e.target.value } : d)}
              className="w-28 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Schedule */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-text-primary">Schedule</p>
              <p className="text-xs text-text-secondary">Which days to deliver</p>
            </div>
            <select
              value={draft.schedule}
              onChange={e => setDraft(d => d ? { ...d, schedule: e.target.value } : d)}
              className="w-28 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
            >
              <option value="weekdays">Weekdays</option>
              <option value="daily">Daily</option>
            </select>
          </div>

          {/* Email address */}
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <p className="text-sm text-text-primary">Recipient email</p>
              <p className="text-xs text-text-secondary">Where to send the morning brief</p>
            </div>
            <input
              type="email"
              placeholder="you@example.com"
              value={draft.recipientEmail}
              onChange={e => setDraft(d => d ? { ...d, recipientEmail: e.target.value } : d)}
              className="w-52 bg-surface-hover border border-border rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          {/* Section toggles */}
          <div>
            <p className="text-sm text-text-primary mb-2">Include sections</p>
            <div className="space-y-2">
              {sectionFields.map(({ key, label }) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={draft.sections[key]}
                    onChange={() => setDraft(d => d ? { ...d, sections: { ...d.sections, [key]: !d.sections[key] } } : d)}
                    className="w-4 h-4 rounded border-border bg-surface-hover accent-accent"
                  />
                  <span className="text-sm text-text-secondary">{label}</span>
                </label>
              ))}
            </div>
          </div>
        </>
      )}
    </SettingsCard>
  )
}
