import { useState } from 'react'
import {
  LayoutDashboard,
  Shield,
  Calendar,
  Users,
  FileText,
  Settings,
} from 'lucide-react'

const navItems = [
  { icon: LayoutDashboard, label: 'Command Center', sectionId: 'section-command' },
  { icon: Shield,          label: 'Support Cases',  sectionId: 'section-cases' },
  { icon: Calendar,        label: 'Calendar',        sectionId: 'section-calendar' },
  { icon: Users,           label: 'Accounts',        sectionId: 'section-accounts' },
  { icon: FileText,        label: 'Briefs',           sectionId: 'section-briefs' },
]

export function Sidebar() {
  const [active, setActive] = useState('Command Center')

  function scrollTo(item: typeof navItems[0]) {
    setActive(item.label)
    const el = document.getElementById(item.sectionId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <aside className="w-60 min-h-screen bg-surface border-r border-border flex flex-col shrink-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-bg text-sm font-bold">
            AC
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary">ASA Command</div>
            <div className="text-xs text-text-secondary">Center</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.label}
            onClick={() => scrollTo(item)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
              active === item.label
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
            }`}
          >
            <item.icon className="w-4 h-4" />
            <span>{item.label}</span>
          </button>
        ))}

        {/* Settings — bottom of nav, no scroll target */}
        <button
          onClick={() => setActive('Settings')}
          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors mt-4 ${
            active === 'Settings'
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
          }`}
        >
          <Settings className="w-4 h-4" />
          <span>Settings</span>
        </button>
      </nav>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border">
        <div className="text-xs text-text-secondary">PAI Dashboard v0.1</div>
      </div>
    </aside>
  )
}
