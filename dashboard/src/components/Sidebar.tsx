import { useState, useEffect, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  Calendar,
  Users,
  Cloud,
  TrendingUp,
  Settings,
  Wrench,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Sun,
  Package,
  ShieldCheck,
  Target,
} from 'lucide-react'

const navItems = [
  { icon: Sun,             label: 'Morning Summary', sectionId: 'section-morning' },
  { icon: LayoutDashboard, label: 'Command Center',  sectionId: 'section-command' },
  { icon: TrendingUp,      label: 'Pipeline',        sectionId: 'section-pipeline' },
  { icon: Cloud,           label: 'Cloud Spend',     sectionId: 'section-cloudspend' },
  { icon: Calendar,        label: 'Calendar',        sectionId: 'section-calendar' },
  { icon: Users,           label: 'Accounts',        sectionId: 'section-accounts' },
]

export type DashboardViewMode = 'asa' | 'product'

interface SidebarProps {
  active: string
  onActiveChange: (label: string) => void
  aes?: { name: string; customerCount: number }[]
  productAlertCount?: number
  viewMode?: DashboardViewMode
  onViewModeChange?: (mode: DashboardViewMode) => void
}

export function Sidebar({ active, onActiveChange, aes, productAlertCount = 0, viewMode = 'asa', onViewModeChange }: SidebarProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const versionClickCount = useRef(0)
  const versionClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    return stored === null ? true : stored === 'true'
  })

  // Scroll-spy via IntersectionObserver (BKL-UX40)
  const [activeSection, setActiveSection] = useState<string | null>(null)

  useEffect(() => {
    const sections = document.querySelectorAll('[data-section]')
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.getAttribute('data-section'))
          }
        }
      },
      { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
    )
    sections.forEach((s) => observer.observe(s))
    return () => observer.disconnect()
  }, [])

  // BKL-UI-TITLE-01: Do NOT sync scroll-spy → onActiveChange. Scroll-spy is a
  // visual highlight only (via isActive() reading activeSection). Calling
  // onActiveChange from layout/scroll changes (e.g., switching "By AE" view)
  // mutates document.title via App.tsx's title useEffect, causing the title
  // to flip to "Pipeline | ASA Command Center" while the URL stays /dashboard.

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  function scrollTo(item: typeof navItems[0]) {
    onActiveChange(item.label)
    if (location.pathname.startsWith('/dashboard/products')) {
      navigate('/dashboard')
      return
    }
    const el = document.getElementById(item.sectionId)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const btnBase = `w-full flex items-center py-2.5 rounded-lg text-sm transition-colors ${
    collapsed ? 'justify-center px-2' : 'gap-3 px-3'
  }`

  const [accountsExpanded, setAccountsExpanded] = useState(false)

  function scrollToAeGroup(aeName: string) {
    document.querySelector(`[data-ae-group="${CSS.escape(aeName)}"]`)?.scrollIntoView({ behavior: 'smooth' })
  }

  function isActive(label: string, sectionId?: string): boolean {
    if (active === label) return true
    if (sectionId && activeSection === sectionId) return true
    return false
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

      {/* BKL-UX56: ASA/Product view toggle removed — always ASA view */}

      {/* Nav */}
      <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
        {navItems.filter(item => {
          // Hide Morning Summary nav in product view
          if (viewMode === 'product' && item.label === 'Morning Summary') return false
          return true
        }).map((item) => (
          <div key={item.label} className="relative group">
            <button
              onClick={() => {
                scrollTo(item)
                if (item.label === 'Accounts') setAccountsExpanded((v) => !v)
              }}
              aria-label={item.label}
              className={`${btnBase} ${
                isActive(item.label, item.sectionId)
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
              }`}
            >
              <item.icon className="w-4 h-4 shrink-0" />
              {!collapsed && <span className="whitespace-nowrap">{item.label}</span>}
              {!collapsed && item.label === 'Accounts' && aes && aes.length > 0 && (
                <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${accountsExpanded ? 'rotate-180' : ''}`} />
              )}
            </button>
            {collapsed && (
              <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                {item.label}
              </span>
            )}
            {/* AE sub-navigation under Accounts (BKL-UX48) */}
            {!collapsed && item.label === 'Accounts' && accountsExpanded && aes && aes.length > 0 && (
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

        {/* Products nav item (Wave 4) */}
        <div className="relative group mt-4">
          <a
            href="/dashboard/products"
            aria-label="Products"
            className={`${btnBase} text-text-secondary hover:text-text-primary hover:bg-border/30`}
          >
            <Package className="w-4 h-4 shrink-0" />
            {!collapsed && (
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                Products
                {productAlertCount > 0 && (
                  <span className="bg-amber-500/20 text-amber-400 border border-amber-500/40 text-xs font-medium px-1.5 py-0.5 rounded-full leading-none">
                    {productAlertCount}
                  </span>
                )}
              </span>
            )}
            {collapsed && productAlertCount > 0 && (
              <span className="absolute top-1 right-1 w-2 h-2 bg-amber-500 rounded-full" />
            )}
          </a>
          {collapsed && (
            <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
              Products
            </span>
          )}
        </div>

        {/* Settings — inline panel (stays within Dashboard) */}
        <div className="relative group">
          <button
            onClick={() => onActiveChange('Settings')}
            aria-label="Settings"
            className={`${btnBase} ${
              active === 'Settings' && !location.pathname.startsWith('/dashboard/admin')
                ? 'bg-accent/10 text-accent'
                : 'text-text-secondary hover:text-text-primary hover:bg-border/30'
            }`}
          >
            <Settings className="w-4 h-4 shrink-0" />
            {!collapsed && <span className="whitespace-nowrap">Settings</span>}
          </button>
          {collapsed && (
            <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
              Settings
            </span>
          )}
        </div>

        {viewMode !== 'product' && (
          <>
            <div className="relative group">
              <a
                href="/dashboard/setup"
                aria-label="Setup"
                className={`${btnBase} text-text-secondary hover:text-text-primary hover:bg-border/30`}
              >
                <Wrench className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">Setup</span>}
              </a>
              {collapsed && (
                <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                  Setup
                </span>
              )}
            </div>

            <div className="relative group">
              <a
                href="/dashboard/batch"
                aria-label="Batch"
                className={`${btnBase} text-text-secondary hover:text-text-primary hover:bg-border/30`}
              >
                <Target className="w-4 h-4 shrink-0" />
                {!collapsed && <span className="whitespace-nowrap">Batch</span>}
              </a>
              {collapsed && (
                <span className="pointer-events-none absolute left-full top-1/2 -translate-y-1/2 ml-2 px-2 py-1 rounded bg-surface border border-border text-xs text-text-primary whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity shadow-lg z-50">
                  Batch
                </span>
              )}
            </div>
          </>
        )}

        {/* Admin — hidden from sidebar, accessible via triple-click on version number (BKL-M43) */}
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
