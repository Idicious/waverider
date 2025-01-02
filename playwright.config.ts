import { defineConfig } from "@playwright/test";

export default defineConfig({
  projects: [{ name: "Desktop", use: { browserName: "chromium" } }],
  testDir: "./e2e",
  outputDir: "./e2e/test-results",
  timeout: 30000,
  webServer: {
    command: "npm run dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
  use: {
    headless: true,
    viewport: { width: 1280, height: 720 },
    ignoreHTTPSErrors: true,
    baseURL: "http://localhost:5173",
  },
});
