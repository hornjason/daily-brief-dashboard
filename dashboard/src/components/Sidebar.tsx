import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import * as Icons from 'lucide-react'
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sun,
  Users,
  Calendar,
  TrendingUp,
  Settings,
  Wrench,
  Package,
  Target,
  AlertTriangle,
} from 'lucide-react'

// Core navigation pages (hardcoded, always present)
const corePages = [
  { icon: Sun,             label: 'Home',             path: '/dashboard' },
  { icon: Users,           label: 'Accounts',         path: '/dashboard/accounts' },
  { icon: Calendar,        label: 'Calendar',         path: '/dashboard/calendar' },
  { icon: TrendingUp,      label: 'Book of Business', path: '/dashboard/book-of-business' },
  { icon: AlertTriangle,   label: 'Triage',           path: '/dashboard/triage' },
  { icon: Settings,        label: 'Admin',            path: '/dashboard/admin' },
]

export type DashboardViewMode = 'asa' | 'product'

interface SidebarProps {
  aes?: { name: string; customerCount: number }[]
  productAlertCount?: number
  viewMode?: DashboardViewMode
  onViewModeChange?: (mode: DashboardViewMode) => void
}

interface ModuleNavItem {
  name: string
  nav?: {
    path: string
    label: string
    icon: string
    group: 'actions' | 'intelligence'
    order: number
  }
}

interface ModuleGroup {
  name: string
  label: string
  modules: ModuleNavItem[]
}

export function Sidebar({ aes, productAlertCount = 0, viewMode = 'asa', onViewModeChange }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const versionClickCount = useRef(0)
  const versionClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    return stored === null ? true : stored === 'true'
  })

  // Module navigation state
  const [modules, setModules] = useState<ModuleNavItem[]>([])
  const [groupCollapsed, setGroupCollapsed] = useState<Record<string, boolean>>({
    actions: localStorage.getItem('sidebar-group-actions') === 'false',
    intelligence: localStorage.getItem('sidebar-group-intelligence') === 'false',
  })

  const btnBase = `w-full flex items-center py-2.5 rounded-lg text-sm transition-colors ${
    collapsed ? 'justify-center px-2' : 'gap-3 px-3'
  }`

  const [accountsExpanded, setAccountsExpanded] = useState(false)

  // Fetch module navigation on mount
  useEffect(() => {
    fetch('/api/feature-modules/nav')
      .then(r => r.json())
      .then((data: ModuleNavItem[]) => {
        setModules(data.filter(m => m.nav))
      })
      .catch(err => console.error('[Sidebar] Failed to fetch module nav:', err))
  }, [])

  // Group modules by nav.group
  const moduleGroups: ModuleGroup[] = [
    {
      name: 'actions',
      label: 'ACTIONS',
      modules: modules
        .filter(m => m.nav?.group === 'actions')
        .sort((a, b) => (a.nav!.order ?? 0) - (b.nav!.order ?? 0)),
    },
    {
      name: 'intelligence',
      label: 'INTELLIGENCE',
      modules: modules
        .filter(m => m.nav?.group === 'intelligence')
        .sort((a, b) => (a.nav!.order ?? 0) - (b.nav!.order ?? 0)),
    },
  ].filter(g => g.modules.length > 0)

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  function toggleGroup(groupName: string) {
    setGroupCollapsed(prev => {
      const next = !prev[groupName]
      localStorage.setItem(`sidebar-group-${groupName}`, String(!next))
      return { ...prev, [groupName]: next }
    })
  }

  function scrollToAeGroup(aeName: string) {
    document.querySelector(`[data-ae-group="${CSS.escape(aeName)}"]`)?.scrollIntoView({ behavior: 'smooth' })
  }

  function isActive(path: string): boolean {
    if (path === '/dashboard') {
      return location.pathname === '/dashboard'
    }
    return location.pathname.startsWith(path)
  }

  function getIconComponent(iconName: string): React.ComponentType<{ className?: string }> {
    const Icon = (Icons as any)[iconName]
    return Icon ?? Package
  }

  return (
    <aside
      className={`sticky top-0 self-start ${collapsed ? 'w-14' : 'w-52'} transition-[width] duration-200 ease-in-out h-screen bg-surface border-r border-border flex flex-col shrink-0 overflow-visible`}
    >
      {/* Floating edge toggle — straddles the right border */}
      <button
        onClick={toggle}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
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
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {/* Core pages */}
        {corePages.map((page) => (
          <div key={page.path} className="relative group">
            {page.label === 'Accounts' ? (
              <button
                onClick={() => {
                  navigate(page.path)
                  setAccountsExpanded((v) => !v)
                }}
                aria-label={page.label}
                className={`${btnBase} ${
                  isActive(page.path)
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
                }`}
              >
                <page.icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">{page.label}</span>}
                {!collapsed && aes && aes.length > 0 && (
                  <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${accountsExpanded ? 'rotate-180' : ''}`} />
                )}
              </button>
            ) : (
              <Link
                to={page.path}
                aria-label={page.label}
                className={`${btnBase} ${
                  isActive(page.path)
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
                }`}
              >
                <page.icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">{page.label}</span>}
              </Link>
            )}
            {collapsed && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                {page.label}
              </span>
            )}
            {/* AE sub-navigation under Accounts (BKL-UX48) */}
            {!collapsed && page.label === 'Accounts' && accountsExpanded && aes && aes.length > 0 && (
              <div className="mt-1 mb-1">
                {aes.map((ae) => (
                  <button
                    key={ae.name}
                    onClick={() => scrollToAeGroup(ae.name)}
                    className="w-full flex items-center gap-2 pl-10 pr-3 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-surface-hover rounded transition-colors min-w-0"
                    aria-label={`${ae.name} - ${ae.customerCount} customers`}
                  >
                    <span className="truncate" title={ae.name}>{ae.name}</span>
                    <span className="ml-auto text-text-secondary tabular-nums">{ae.customerCount}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Module groups */}
        {moduleGroups.map(group => (
          <div key={group.name} className="mt-4">
            {!collapsed && (
              <button
                onClick={() => toggleGroup(group.name)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-semibold tracking-wider text-zinc-500 hover:text-zinc-400 transition-colors uppercase"
              >
                <span>{group.label}</span>
                <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${groupCollapsed[group.name] ? '-rotate-90' : ''}`} />
              </button>
            )}
            {!groupCollapsed[group.name] && group.modules.map(module => {
              if (!module.nav) return null
              const Icon = getIconComponent(module.nav.icon)
              return (
                <div key={module.name} className="relative group">
                  <Link
                    to={module.nav.path}
                    aria-label={module.nav.label}
                    className={`${btnBase} ${collapsed ? '' : 'pl-6'} ${
                      isActive(module.nav.path)
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    {!collapsed && <span className="whitespace-nowrap">{module.nav.label}</span>}
                  </Link>
                  {collapsed && (
                    <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                      {module.nav.label}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        ))}

        {/* Setup and Batch — secondary nav items */}
        {viewMode !== 'product' && (
          <div className="mt-4 pt-4 border-t border-border/50">
            <div className="relative group">
              <Link
                to="/dashboard/setup"
                aria-label="Setup"
                className={`${btnBase} ${
                  isActive('/dashboard/setup')
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
                }`}
              >
                <Wrench className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">Setup</span>}
              </Link>
              {collapsed && (
                <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                  Setup
                </span>
              )}
            </div>

            <div className="relative group">
              <Link
                to="/dashboard/batch"
                aria-label="Batch"
                className={`${btnBase} ${
                  isActive('/dashboard/batch')
                    ? 'bg-accent/10 text-accent'
                    : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
                }`}
              >
                <Target className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">Batch</span>}
              </Link>
              {collapsed && (
                <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                  Batch
                </span>
              )}
            </div>
          </div>
        )}
      </nav>

      {/* Footer — triple-click version number to access Admin (BKL-M43) */}
      {!collapsed && (
        <div className="px-5 py-4 border-t border-border">
          <div
            className="text-xs text-text-secondary cursor-default select-none"
            onClick={() => {
              versionClickCount.current += 1
              if (versionClickTimer.current) clearTimeout(versionClickTimer.current)
              if (versionClickCount.current >= 3) {
                versionClickCount.current = 0
                navigate('/dashboard/admin')
              } else {
                versionClickTimer.current = setTimeout(() => { versionClickCount.current = 0 }, 1500)
              }
            }}
          >PAI Dashboard v0.1</div>
        </div>
      )}
    </aside>
  )
}
