export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#080b11',
        panel: '#0e131b',
        line: '#1d2733',
        accent: '#d6a758',
        positive: '#47d6a3',
        negative: '#fa7185',
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 36px rgba(214,167,88,0.12)',
      },
    },
  },
  plugins: [],
};
