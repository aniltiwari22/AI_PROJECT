/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      // Semantic names backed by CSS variables, so a component written once
      // renders correctly in both themes without conditional classes.
      colors: {
        bg: 'hsl(var(--bg) / <alpha-value>)',
        elevated: 'hsl(var(--bg-elevated) / <alpha-value>)',
        surface: 'hsl(var(--surface) / <alpha-value>)',
        'surface-strong': 'hsl(var(--surface-strong) / <alpha-value>)',
        line: 'hsl(var(--border) / <alpha-value>)',
        'line-strong': 'hsl(var(--border-strong) / <alpha-value>)',
        content: 'hsl(var(--text) / <alpha-value>)',
        muted: 'hsl(var(--text-muted) / <alpha-value>)',
        faint: 'hsl(var(--text-faint) / <alpha-value>)',
        accent: 'hsl(var(--accent) / <alpha-value>)',
        'accent-strong': 'hsl(var(--accent-strong) / <alpha-value>)',
        'accent-contrast': 'hsl(var(--accent-contrast) / <alpha-value>)',
        warm: 'hsl(var(--warm) / <alpha-value>)',
        success: 'hsl(var(--success) / <alpha-value>)',
        danger: 'hsl(var(--danger) / <alpha-value>)'
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'SFMono-Regular', 'Consolas', 'monospace']
      },
      borderRadius: {
        xl: '0.9rem',
        '2xl': '1.25rem',
        '3xl': '1.75rem'
      },
      boxShadow: {
        soft: '0 1px 2px hsl(268 40% 4% / 0.06), 0 8px 24px -12px hsl(268 40% 4% / 0.28)',
        lift: '0 2px 6px hsl(268 40% 4% / 0.10), 0 18px 40px -18px hsl(268 40% 4% / 0.45)'
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'bounce-dot': {
          '0%, 80%, 100%': { transform: 'translateY(0)', opacity: '0.35' },
          '40%': { transform: 'translateY(-5px)', opacity: '1' }
        },
        breathe: {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.06)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      animation: {
        'fade-up': 'fade-up 0.32s cubic-bezier(0.16, 1, 0.3, 1)',
        'fade-in': 'fade-in 0.22s ease-out',
        'bounce-dot': 'bounce-dot 1.35s ease-in-out infinite',
        breathe: 'breathe 3.4s ease-in-out infinite',
        shimmer: 'shimmer 2.2s linear infinite'
      }
    }
  },
  plugins: []
};
