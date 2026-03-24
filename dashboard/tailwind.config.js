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
        'text-secondary': '#8B949E',
        critical: '#F85149',
        warning: '#D29922',
        success: '#3FB950',
        // Timeline type colors
        'tl-meeting': '#00BCD4',
        'tl-email': '#A371F7',
        'tl-doc': '#F0883E',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
