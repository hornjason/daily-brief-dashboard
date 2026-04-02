import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'

interface TopBarProps {
  lastSynced: string | null
  loading: boolean
  onRefresh: () => void
  activeAe?: string | null
}

interface WeatherData {
  enabled: boolean
  tempF?: string
  condition?: string
  feelsLikeF?: string
  error?: string
}

function weatherEmoji(condition: string): string {
  const c = condition.toLowerCase()
  if (c.includes('thunder') || c.includes('storm')) return '⛈'
  if (c.includes('snow') || c.includes('blizzard')) return '❄️'
  if (c.includes('rain') || c.includes('drizzle') || c.includes('shower')) return '🌧'
  if (c.includes('fog') || c.includes('mist') || c.includes('haze')) return '🌫'
  if (c.includes('overcast') || c.includes('cloudy')) return '☁️'
  if (c.includes('partly') || c.includes('scattered')) return '⛅'
  if (c.includes('clear') || c.includes('sunny')) return '☀️'
  return '🌤'
}

export function TopBar({ lastSynced, loading, onRefresh, activeAe }: TopBarProps) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const [weather, setWeather] = useState<WeatherData | null>(null)

  useEffect(() => {
    fetch('/api/weather')
      .then(r => r.json())
      .then((d: WeatherData) => { if (d.enabled) setWeather(d) })
      .catch(() => {})
  }, [])

  return (
    <header className="h-14 bg-surface border-b border-border px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-text-primary">Command Center</h1>
        <span className="text-sm text-text-secondary">{today}</span>
        {activeAe && (
          <span className="text-xs text-accent px-2 py-0.5 bg-accent-muted rounded-badge">{activeAe}</span>
        )}
        {weather && !weather.error && weather.tempF && (
          <span className="text-sm text-text-secondary flex items-center gap-1">
            <span>{weatherEmoji(weather.condition ?? '')}</span>
            <span>{weather.tempF}°F</span>
            {weather.condition && (
              <span className="text-text-secondary/80 hidden sm:inline">· {weather.condition}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        {lastSynced && (
          <span className="text-xs text-text-secondary">Last synced: {lastSynced}</span>
        )}
        <button
          onClick={onRefresh}
          disabled={loading}
          aria-label={loading ? 'Dashboard is refreshing' : 'Refresh dashboard'}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border border-border text-text-secondary text-sm hover:border-text-secondary hover:text-text-primary disabled:opacity-40 transition-all ${loading ? 'pointer-events-none' : ''}`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Refreshing\u2026' : 'Refresh'}
        </button>
      </div>
    </header>
  )
}
