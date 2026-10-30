import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

// I am loading environment variables from the .env file at startup so credentials and API keys are available across the test suite.
dotenv.config();

// I am configuring Playwright exclusively for headless Chromium execution with trace capture on failure for deterministic debugging.
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
