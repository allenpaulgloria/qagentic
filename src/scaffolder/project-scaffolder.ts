import fs from 'node:fs/promises';
import path from 'node:path';

export interface ScaffoldOptions {
  overwrite?: boolean;
  includePlaywrightConfig?: boolean;
}

export interface ScaffoldResult {
  targetDir: string;
  createdFiles: string[];
  skippedFiles: string[];
}

async function writeIfMissing(
  targetDir: string,
  relativePath: string,
  content: string,
  overwrite: boolean,
  createdFiles: string[],
  skippedFiles: string[]
): Promise<void> {
  const fullPath = path.join(targetDir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });

  if (!overwrite) {
    try {
      await fs.access(fullPath);
      skippedFiles.push(relativePath);
      return;
    } catch {
      // File does not exist, proceed to create
    }
  }

  await fs.writeFile(fullPath, content, 'utf-8');
  createdFiles.push(relativePath);
}

// I am scaffolding the complete Playwright storefront automation structure so teams can hit the ground running.
export async function scaffoldPlaywrightProject(
  targetDir: string,
  options: ScaffoldOptions = {}
): Promise<ScaffoldResult> {
  const resolvedDir = path.resolve(targetDir);
  const overwrite = Boolean(options.overwrite);
  const createdFiles: string[] = [];
  const skippedFiles: string[] = [];

  await writeIfMissing(
    resolvedDir,
    'AGENTS.md',
    `# Playwright Automation Agent Rules

- One spec file per flow. The same spec runs on \`web-local\` and \`mobile-local\`.
- Always import \`{ test, expect, skipIfMobile }\` from \`utils/fixtures.ts\`.
- Encapsulate Page Objects under \`page-objects/storefront/\`. Put mobile viewport differences (hamburger menu, app banner) inside Page Objects using platform helpers, never inside spec bodies.
- Locator priority: \`getByRole\` (with accessible name) -> \`getByLabel\` -> \`getByPlaceholder\` -> \`getByText\` -> \`data-qa\` fallback.
- Web-first assertions only (\`toBeVisible\`, \`toHaveText\`, \`toHaveURL\`, \`toHaveCount\`). Never use \`waitForTimeout\`, \`networkidle\`, \`page.$\`, or \`waitForSelector\`.
- Never place literal prices, SKUs, promo codes, emails, or passwords in specs; load them from \`utils/test-data.ts\` or \`utils/sku.ts\`.
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    '.cursor/rules/playwright-best-practices.mdc',
    `---
description: Playwright best practices for semantic locators, POM fixtures, and web-first assertions
globs: ["tests/**/*.ts", "page-objects/**/*.ts", "utils/**/*.ts"]
---

# Playwright Best Practices

1. **Locator Priority**:
   - \`getByRole\` with accessible name
   - \`getByLabel\`
   - \`getByPlaceholder\`
   - \`getByText\` for unique copy
   - \`[data-qa="..."]\` only as a fallback
   - Use \`.filter()\` and locator chaining instead of CSS class selectors.
2. **Assertions**:
   - Use web-first assertions only: \`toBeVisible\`, \`toHaveText\`, \`toHaveURL\`, \`toHaveCount\`.
   - Zero \`waitForTimeout\`, \`networkidle\`, \`page.$\`, or \`waitForSelector\`.
3. **Platform Isolation**:
   - Desktop-only cases use \`skipIfMobile\`. Do not put platform checks inside the test body.
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    '.cursor/rules/katalon-conversion.mdc',
    `---
description: Rules for converting legacy Katalon scripts to Playwright specs
globs: ["tests/**/*.ts"]
---

# Katalon to Playwright Conversion

- Replace \`WebUI.verifyElementPresent\` and \`WebUI.verifyElementVisible\` with \`await expect(locator).toBeVisible()\`.
- Replace \`WebUI.verifyElementText\` with \`await expect(locator).toHaveText(...)\`.
- Replace hardcoded \`WebUI.delay\` calls with Playwright auto-waiting and web-first assertions.
- Map all test data references to \`utils/test-data.ts\` and \`utils/sku.ts\`.
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    '.cursor/skills/katalon-assertion-parity/SKILL.md',
    `---
name: katalon-assertion-parity
description: Verify assertion parity between a legacy Katalon script and a migrated Playwright spec
---

# Katalon Assertion Parity

1. Count all \`WebUI.verify*\`, \`WS.verify*\`, and \`assert*\` statements in the source Katalon script.
2. Count all \`await expect(...)\` web-first assertions in the drafted Playwright spec.
3. Report both counts and highlight any unmapped verifications.
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'docs/HOW-TO-RUN.md',
    `# How to Run Playwright Tests

## Local Execution

Run desktop web tests:
\`\`\`bash
npx cross-env RUN_ON=local ENV=staging npx playwright test tests/<spec>.spec.ts --project=web-local --workers=1
\`\`\`

Run mobile viewport tests:
\`\`\`bash
npx cross-env RUN_ON=local ENV=staging npx playwright test tests/<spec>.spec.ts --project=mobile-local --workers=1
\`\`\`

## Linting

\`\`\`bash
npm run lint
\`\`\`
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'utils/test-data.ts',
    `// I am centralizing non-secret test data loaders and account env var references so specs never contain literal prices, promo codes, emails, or passwords.

export interface TestAccountCredentials {
  email: string;
  password: string;
}

export const TEST_DATA = {
  QUANTITY_MIN: 1,
  QUANTITY_MAX: 10,
  QUANTITY_OVER_MAX: 11,
  VALID_PROMO_CODE: process.env.TEST_PROMO_CODE || 'PROMO_FROM_ENV',
  EXPECTED_CURRENCY_SYMBOL: process.env.EXPECTED_CURRENCY_SYMBOL || '$',
} as const;

export function getAccountFromEnv(envVarName: string): TestAccountCredentials {
  const raw = process.env[envVarName] || '';
  const [email = '', password = ''] = raw.split(':');
  return { email, password };
}
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'utils/sku.ts',
    `// I am providing environment-aware SKU loaders so specs reference logical SKU keys rather than literal product codes.

export type SkuKey = 'TWO_OPTION_PRODUCT' | 'SINGLE_OPTION_PRODUCT' | 'OUT_OF_STOCK_PRODUCT';

const SKU_MAP: Record<string, Record<SkuKey, string>> = {
  dev: {
    TWO_OPTION_PRODUCT: process.env.DEV_SKU_TWO_OPTION || 'SKU-DEV-2OPT',
    SINGLE_OPTION_PRODUCT: process.env.DEV_SKU_SINGLE || 'SKU-DEV-1OPT',
    OUT_OF_STOCK_PRODUCT: process.env.DEV_SKU_OOS || 'SKU-DEV-OOS',
  },
  staging: {
    TWO_OPTION_PRODUCT: process.env.STAGING_SKU_TWO_OPTION || 'SKU-STG-2OPT',
    SINGLE_OPTION_PRODUCT: process.env.STAGING_SKU_SINGLE || 'SKU-STG-1OPT',
    OUT_OF_STOCK_PRODUCT: process.env.STAGING_SKU_OOS || 'SKU-STG-OOS',
  },
  prod: {
    TWO_OPTION_PRODUCT: process.env.PROD_SKU_TWO_OPTION || 'SKU-PRD-2OPT',
    SINGLE_OPTION_PRODUCT: process.env.PROD_SKU_SINGLE || 'SKU-PRD-1OPT',
    OUT_OF_STOCK_PRODUCT: process.env.PROD_SKU_OOS || 'SKU-PRD-OOS',
  },
};

export function getSku(key: SkuKey, env: string = process.env.ENV || 'staging'): string {
  const normalizedEnv = env.toLowerCase();
  const table = SKU_MAP[normalizedEnv] || SKU_MAP.staging;
  return table[key];
}
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'page-objects/storefront/base.page.ts',
    `import { Page, Locator } from '@playwright/test';

// I am providing base storefront Page Object helpers including mobile viewport controls (hamburger menu and app banner dismissal).
export class BaseStorefrontPage {
  readonly page: Page;
  readonly mobileMenuButton: Locator;
  readonly appBannerCloseButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.mobileMenuButton = page.getByRole('button', { name: /menu|navigation/i });
    this.appBannerCloseButton = page.getByRole('button', { name: /close app banner|dismiss/i });
  }

  isMobileViewport(): boolean {
    const size = this.page.viewportSize();
    return Boolean(size && size.width < 768);
  }

  async dismissAppBannerIfPresent(): Promise<void> {
    if (this.isMobileViewport() && (await this.appBannerCloseButton.isVisible())) {
      await this.appBannerCloseButton.click();
    }
  }

  async openNavigationIfNeeded(): Promise<void> {
    if (this.isMobileViewport() && (await this.mobileMenuButton.isVisible())) {
      await this.mobileMenuButton.click();
    }
  }
}
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'page-objects/storefront/pdp.page.ts',
    `import { Page, Locator } from '@playwright/test';
import { BaseStorefrontPage } from './base.page.js';

// I am encapsulating Product Detail Page (PDP) locators and interactions following the semantic locator hierarchy.
export class PdpPage extends BaseStorefrontPage {
  readonly productHeading: Locator;
  readonly optionDropdown: Locator;
  readonly quantityInput: Locator;
  readonly addToCartButton: Locator;
  readonly miniCartDrawer: Locator;
  readonly cartBadgeCount: Locator;

  constructor(page: Page) {
    super(page);
    this.productHeading = page.getByRole('heading').first();
    this.optionDropdown = page.getByRole('combobox').first();
    this.quantityInput = page.getByLabel(/quantity|qty/i);
    this.addToCartButton = page.getByRole('button', { name: /add to cart|add to bag/i });
    this.miniCartDrawer = page.getByRole('dialog');
    this.cartBadgeCount = page.locator('[data-qa="cart-count"]');
  }

  async gotoProduct(url: string): Promise<void> {
    await this.page.goto(url);
    await this.dismissAppBannerIfPresent();
  }

  async selectDropdownOption(optionName: string): Promise<void> {
    await this.optionDropdown.selectOption({ label: optionName });
  }

  async selectThumbnailOption(optionLabel: string): Promise<void> {
    await this.page.getByRole('button', { name: optionLabel }).click();
  }

  async setQuantity(quantity: number): Promise<void> {
    await this.quantityInput.fill(String(quantity));
  }

  async addToCart(): Promise<void> {
    await this.addToCartButton.click();
  }
}
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  await writeIfMissing(
    resolvedDir,
    'utils/fixtures.ts',
    `import { test as base, expect } from '@playwright/test';
import { PdpPage } from '../page-objects/storefront/pdp.page.js';

export interface StorefrontFixtures {
  pdpPage: PdpPage;
  // [STOREFRONT_FIXTURES_TYPES]
}

export const test = base.extend<StorefrontFixtures>({
  pdpPage: async ({ page }, use) => {
    await use(new PdpPage(page));
  },
  // [STOREFRONT_FIXTURES_IMPL]
});

// I am providing a declarative helper to skip desktop-only cases on mobile-local without putting platform checks inside test bodies.
export function skipIfMobile(testInfo: { project: { name: string } }, reason = 'Desktop-only case'): void {
  test.skip(testInfo.project.name.includes('mobile'), reason);
}

export { expect };
`,
    overwrite,
    createdFiles,
    skippedFiles
  );

  if (options.includePlaywrightConfig) {
    await writeIfMissing(
      resolvedDir,
      'playwright.config.ts',
      `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'web-local',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-local',
      use: { ...devices['iPhone 13'] },
    },
  ],
});
`,
      overwrite,
      createdFiles,
      skippedFiles
    );
  }

  return {
    targetDir: resolvedDir,
    createdFiles,
    skippedFiles,
  };
}

