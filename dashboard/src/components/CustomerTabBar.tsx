/**
 * GitHub Issue #142: Account detail tab navigation chrome
 * Five tabs: Overview, Campaigns, News, Intelligence, Tools
 * GitHub Issue #200: Added Intelligence tab
 * Follows PodTabBar styling pattern
 */

type AccountTab = 'overview' | 'campaigns' | 'news' | 'intelligence' | 'tools'

interface CustomerTabBarProps {
  activeTab: AccountTab
  onChange: (tab: AccountTab) => void
}

const TAB_LABELS: Record<AccountTab, string> = {
  overview: 'Overview',
  campaigns: 'Campaigns',
  news: 'News',
  intelligence: 'Intelligence',
  tools: 'Tools',
}

const TABS: AccountTab[] = ['overview', 'campaigns', 'news', 'intelligence', 'tools']

export function CustomerTabBar({ activeTab, onChange }: CustomerTabBarProps) {
  return (
    <div className="w-full h-12 bg-[#18181b] flex items-end px-6 gap-1 shrink-0 overflow-x-auto">
      {TABS.map(tab => {
        const isActive = tab === activeTab
        return (
          <button
            key={tab}
            onClick={() => onChange(tab)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors relative whitespace-nowrap ${
              isActive
                ? 'text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {TAB_LABELS[tab]}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t" />
            )}
          </button>
        )
      })}
    </div>
  )
}

export type { AccountTab }
