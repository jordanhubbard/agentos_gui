/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        'os-bg':      'var(--os-bg)',
        'os-surface': 'var(--os-surface)',
        'os-border':  'var(--os-border)',
        'os-accent':  'var(--os-accent)',
        'os-text':    'var(--os-text)',
        'os-muted':   'var(--os-muted)',
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
