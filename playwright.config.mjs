import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./bk095d/tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {},
  },
  webServer: { command: "node scripts/serve-preview.cjs", url: "http://127.0.0.1:4173/login", reuseExistingServer: !process.env.CI },
});
