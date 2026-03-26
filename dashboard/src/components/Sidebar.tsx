import { useState } from 'react'
import {
  LayoutDashboard,
  Calendar,
  Users,
  Cloud,
  TrendingUp,
  Settings,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'

const navItems = [
  { icon: LayoutDashboard, label: 'Command Center', sectionId: 'section-command' },
  { icon: TrendingUp,      label: 'Pipeline',        sectionId: 'section-pipeline' },
  { icon: Cloud,           label: 'Cloud Spend',     sectionId: 'section-cloudspend' },
  { icon: Calendar,        label: 'Calendar',        sectionId: 'section-calendar' },
  { icon: Users,           label: 'Accounts',        sectionId: 'section-accounts' },
]

interface SidebarProps {
  active: string
  onActiveChange: (label: string) => void
}

export function Sidebar({ active, onActiveChange }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    return stored === null ? true : stored === 'true'
  })

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  function scrollTo(item: typeof navItems[0]) {
    onActiveChange(item.label)
    const el = document.getElementById(item.sectionId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const btnBase = `w-full flex items-center py-2.5 rounded-lg text-sm transition-colors ${
    collapsed ? 'justify-center px-2' : 'gap-3 px-3'
  }`

  return (
    <aside
      className={`relative ${collapsed ? 'w-14' : 'w-52'} transition-[width] duration-200 ease-in-out min-h-screen bg-surface border-r border-border flex flex-col shrink-0 overflow-visible`}
    >
      {/* Floating edge toggle — straddles the right border */}
      <button
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="absolute top-6 -right-3 z-20 w-6 h-6 rounded-full bg-surface border border-border shadow-sm flex items-center justify-center text-text-secondary hover:text-accent hover:border-accent transition-colors"
      >
        {collapsed
          ? <ChevronRight className="w-3 h-3" />
          : <ChevronLeft className="w-3 h-3" />
        }
      </button>

      {/* Logo */}
      <div className={`border-b border-border flex items-center ${collapsed ? 'justify-center px-3 py-5' : 'gap-3 px-5 py-5'}`}>
        <div className="w-8 h-8 rounded-lg bg-accent flex items-center justify-center text-bg text-sm font-bold shrink-0">
          AC
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary whitespace-nowrap">ASA Command</div>
            <div className="text-xs text-text-secondary">Center</div>
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-hidden">
        {navItems.map((item) => (
          <button
            key={item.label}
            onClick={() => scrollTo(item)}
            title={collapsed ? item.label : undefined}
            className={`${btnBase} ${
              active === item.label
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
            }`}
          >
            <item.icon className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
          </button>
        ))}

        <button
          onClick={() => onActiveChange('Settings')}
          title={collapsed ? 'Settings' : undefined}
          className={`${btnBase} mt-4 ${
            active === 'Settings'
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
          }`}
        >
          <Settings className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="whitespace-nowrap">Settings</span>}
        </button>
      </nav>

      {/* Footer */}
      {!collapsed && (
        <div className="px-5 py-4 border-t border-border">
          <div className="text-xs text-text-secondary">PAI Dashboard v0.1</div>
        </div>
      )}
    </aside>
  )
}
