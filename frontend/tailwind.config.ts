import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces
        canvas:       'var(--bg)',
        surface:      'var(--surface)',
        'surface-hi': 'var(--surface-raised)',
        // Borders
        wire:         'var(--border)',
        'wire-dim':   'var(--border-subtle)',
        // Text (also generates bg-primary etc. but those go unused)
        primary:      'var(--text-primary)',
        secondary:    'var(--text-secondary)',
        muted:        'var(--text-muted)',
        faint:        'var(--text-faint)',
        // Accent / status
        accent:       'var(--accent)',
        'eve-green':  'var(--green)',
        'eve-amber':  'var(--amber)',
        'eve-red':    'var(--red)',
      },
    },
  },
  plugins: [],
}
export default config
