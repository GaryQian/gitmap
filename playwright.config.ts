import { defineConfig } from '@playwright/test';

// 127.0.0.1, not localhost: Vite binds `localhost` to IPv6 only on this platform, and Playwright's
// readiness probe then tries IPv4 and never sees the server come up.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:5199' },
  webServer: {
    command: 'npx vite --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
