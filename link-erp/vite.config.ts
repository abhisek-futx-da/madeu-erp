import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          icons: ['lucide-react']
        }
      }
    }
  },
  server: {
    port: Number(process.env.PORT) || 3000,
    host: true
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // The ERP suites mount large, stateful screens. Letting Vitest create one
    // worker per core caused unrelated 5-second interaction timeouts on busy
    // release machines; four files in parallel stays fast without starving
    // jsdom's event loop.
    minWorkers: 1,
    maxWorkers: 4,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}']
  }
})
