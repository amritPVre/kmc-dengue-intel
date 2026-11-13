/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'Roboto', 'Arial', 'sans-serif'],
      },
      colors: {
        ink: '#0F1B2D',
        paper: '#F6F5F1',
        kmc: { 50: '#E8F4F2', 100: '#CDE8E3', 500: '#0F766E', 600: '#0B5F59', 700: '#084844', 900: '#04201E' },
        risk: { low: '#FBE7A1', mod: '#F7AE57', high: '#E25E3A', vhigh: '#9E1B32' },
      },
    },
  },
  plugins: [],
};
