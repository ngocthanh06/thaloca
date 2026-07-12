import { defineConfig } from '@playwright/test'

// These tests exercise the frontend only, against a mocked window.go.main.App
// (see tests/mockApp.ts) — the real Wails/Go backend is not involved. That
// mirrors how this app was manually verified throughout development and
// turns those one-off checks into a repeatable suite.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
  },
})
