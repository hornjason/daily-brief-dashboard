import plugin from 'tailwindcss/plugin'

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0D1117',
        surface: '#161B22',
        border: '#30363D',
        accent: '#00BCD4',
        'text-primary': '#E6EDF3',
        'text-secondary': '#A8B5C2',
        critical: '#F85149',
        warning: '#D29922',
        success: '#3FB950',
        // Timeline type colors
        'tl-meeting': '#00BCD4',
        'tl-email': '#A371F7',
        'tl-doc': '#F0883E',
        'surface-hover': '#1C2128',
        'surface-active': '#21262D',
        'border-strong': '#484F58',
        'accent-muted': 'rgba(0,188,212,0.12)',
        // Health status
        'health-red': '#F85149',
        'health-amber': '#D29922',
        'health-green': '#3FB950',
        'health-red-bg': 'rgba(248, 81, 73, 0.10)',
        'health-red-border': 'rgba(248, 81, 73, 0.25)',
        'health-amber-bg': 'rgba(210, 153, 34, 0.10)',
        'health-amber-border': 'rgba(210, 153, 34, 0.25)',
        'health-green-bg': 'rgba(63, 185, 80, 0.10)',
        'health-green-border': 'rgba(63, 185, 80, 0.25)',
        // Signal types
        'signal-competitive': '#DA7756',
        'signal-competitive-bg': 'rgba(218, 119, 86, 0.12)',
        'signal-silent': '#8B949E',
        'signal-silent-bg': 'rgba(139, 148, 158, 0.12)',
        // Delta markers
        'delta-new': '#58A6FF',
        'delta-new-bg': 'rgba(88, 166, 255, 0.10)',
        // Sparkline colors
        'spark-up': '#3FB950',
        'spark-down': '#F85149',
        'spark-neutral': '#484F58',
        'spark-up-fill': 'rgba(63, 185, 80, 0.15)',
        'spark-down-fill': 'rgba(248, 81, 73, 0.15)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      fontSize: {
        xs: ['0.8125rem', { lineHeight: '1.25rem' }],
        'hero': ['18px', { lineHeight: '1.2', fontWeight: '700' }],
        'signal': ['11px', { lineHeight: '1.3', fontWeight: '500' }],
        'priority': ['14px', { lineHeight: '1.4', fontWeight: '600' }],
      },
      borderRadius: {
        card: '0.75rem',
        modal: '1rem',
        badge: '0.375rem',
        pill: '9999px',
      },
    },
  },
  plugins: [
    plugin(function({ addUtilities }) {
      addUtilities({
        '.tabular-nums': {
          'font-variant-numeric': 'tabular-nums',
          'font-feature-settings': "'tnum' 1, 'zero' 1",
        },
      })
    }),
  ],
}
