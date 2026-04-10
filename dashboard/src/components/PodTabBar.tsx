/**
 * BKL-UX52: Pod tab bar — full-width 48px, dark background, blue underline on active tab.
 * Pod names come from the /api/pods endpoint.
 */
import type { PodInfo } from '../types'

interface PodTabBarProps {
  pods: PodInfo[]
  activePodId: string
  onChange: (podId: string) => void
}

export function PodTabBar({ pods, activePodId, onChange }: PodTabBarProps) {
  if (pods.length <= 1) return null

  return (
    <div className="w-full h-12 bg-[#18181b] flex items-end px-6 gap-1 shrink-0">
      {pods.map(pod => {
        const isActive = pod.id === activePodId
        return (
          <button
            key={pod.id}
            onClick={() => onChange(pod.id)}
            className={`px-5 py-2.5 text-sm font-medium transition-colors relative ${
              isActive
                ? 'text-white'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {pod.name}
            {isActive && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-blue-500 rounded-t" />
            )}
          </button>
        )
      })}
    </div>
  )
}
