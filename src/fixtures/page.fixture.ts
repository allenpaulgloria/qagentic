import { LoginPage } from '../pages/login.page.js';
import { test as base, expect } from '@playwright/test';

// I am defining the custom fixture interface to register all generated Page Object Models for dependency injection into test specs.
export interface PageFixtures {
  loginPage: LoginPage;
  // [POM_TYPES_ANCHOR]
}

// I am extending the base Playwright test harness so specs receive initialized Page Objects directly without instantiating classes manually.
export const test = base.extend<PageFixtures>({
  loginPage: async ({ page }, use) => {
    // I am instantiating LoginPage inside the test fixture and providing it to the requesting spec.
    await use(new LoginPage(page));
  },
  // [POM_FIXTURES_ANCHOR]
});

export { expect };
