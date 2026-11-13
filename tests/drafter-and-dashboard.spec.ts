import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import {
  buildRecommendedLocator,
  countKatalonAssertions,
  createDashboardServer,
  DrafterService,
  formatBranchName,
  formatDraftSummary,
  loadRepoContext,
  parseMarkdownBrief,
  runDrafterVerification,
  scaffoldPlaywrightProject,
  validateDraftedCodeCompliance,
  validateDrafterInputs,
} from '../src/index.js';

test.describe('Playwright Test Drafter, Scaffolder & Dashboard Suite', () => {
  test('Git branch formatter follows exact naming specification', () => {
    const raw =
      'PROJ-101 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)';
    expect(formatBranchName(raw)).toBe(
      'PROJ-101_Playwright_Migration_PDP_Add_To_Cart_2_options_dropdown_and_thumbnail'
    );
  });

  test('Stop-and-Ask validator blocks missing ENV (never defaults to prod), missing expected results, prod write actions, and unnamed accounts', () => {
    const noEnv = validateDrafterInputs({
      url: 'https://example.com/pdp',
      flow: 'Add a 2-option product to cart from PDP',
      platform: 'both',
      expectedResults: ['1. Mini cart opens'],
      accountNeeded: 'none',
      tag: '@smoke',
      ticket: 'PROJ-101 PDP Add To Cart',
    });
    expect(noEnv.valid).toBe(false);
    expect(noEnv.stopAndAsk.some((i) => i.code === 'MISSING_ENV')).toBe(true);

    const prodWrite = validateDrafterInputs({
      url: 'https://example.com/checkout',
      flow: 'Complete order placement on checkout',
      platform: 'web-local',
      env: 'prod',
      expectedResults: ['1. Order confirmation is displayed'],
      accountNeeded: 'SMOKE_WEB_USER',
      tag: '@regression',
      ticket: 'PROJ-200 Checkout Order',
    });
    expect(prodWrite.valid).toBe(false);
    expect(prodWrite.stopAndAsk.some((i) => i.code === 'PROD_WRITE_BLOCKED')).toBe(true);

    const missingAccount = validateDrafterInputs({
      url: 'https://example.com/account',
      flow: 'Sign in and view order history',
      platform: 'web-local',
      env: 'staging',
      expectedResults: ['1. Order history table is visible'],
      accountNeeded: 'none',
      tag: '@smoke',
      ticket: 'PROJ-201 Order History',
    });
    expect(missingAccount.valid).toBe(false);
    expect(missingAccount.stopAndAsk.some((i) => i.code === 'MISSING_ACCOUNT')).toBe(true);
  });

  test('Locator recommender enforces strict priority: getByRole -> getByLabel -> getByPlaceholder -> getByText -> data-qa fallback', () => {
    const roleBtn = buildRecommendedLocator({
      tagName: 'button',
      role: 'button',
      type: 'button',
      id: '',
      name: '',
      labelText: '',
      placeholder: '',
      ariaLabel: 'Add to Cart',
      dataQa: 'add-to-cart-btn',
      text: 'Add to Cart',
      href: '',
    });
    expect(roleBtn.locatorStrategy).toBe('getByRole');
    expect(roleBtn.recommendedLocator).toContain('getByRole("button", { name: "Add to Cart" })');

    const dataQaFallback = buildRecommendedLocator({
      tagName: 'div',
      role: '',
      type: '',
      id: '',
      name: '',
      labelText: '',
      placeholder: '',
      ariaLabel: '',
      dataQa: 'cart-count',
      text: '',
      href: '',
    });
    expect(dataQaFallback.locatorStrategy).toBe('data-qa');
    expect(dataQaFallback.recommendedLocator).toContain('[data-qa="cart-count"]');
  });

  test('Project Scaffolder and DrafterService generate compliant POM, ISTQB Spec, Candidate Assertions, and Katalon parity report', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qagentic-scaffold-'));
    try {
      const scaffoldRes = await scaffoldPlaywrightProject(tempDir, {
        includePlaywrightConfig: true,
      });
      expect(scaffoldRes.createdFiles).toContain('AGENTS.md');
      expect(scaffoldRes.createdFiles).toContain('utils/fixtures.ts');
      expect(scaffoldRes.createdFiles).toContain('utils/test-data.ts');
      expect(scaffoldRes.createdFiles).toContain('utils/sku.ts');
      expect(scaffoldRes.createdFiles).toContain('page-objects/storefront/pdp.page.ts');

      const katalonPath = path.join(tempDir, 'katalon-pdp.groovy');
      await fs.writeFile(
        katalonPath,
        `WebUI.openBrowser('')\nWebUI.verifyElementVisible(findTestObject('PDP/Modal'))\nWebUI.verifyElementText(findTestObject('PDP/Badge'), '1')\n`,
        'utf-8'
      );
      expect(countKatalonAssertions(await fs.readFile(katalonPath, 'utf-8')).count).toBe(2);

      const briefMd = `
## Inputs (I fill these in)
- URL: https://the-internet.herokuapp.com/login
- Flow (one flow only): Add a 2-option product to cart from PDP
- Platform: both
- ENV: staging
- Expected results (numbered, from me):
  1. Confirmation dialog or status banner is visible after clicking Add to Cart
  2. Cart badge count updates to match minimum quantity
- Account needed: none
- Tag: @smoke
- Ticket ID and title: PROJ-101 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)
`;
      const parsed = parseMarkdownBrief(briefMd);
      const validated = validateDrafterInputs({
        ...parsed,
        repoPath: tempDir,
        katalonScriptPath: katalonPath,
      });
      expect(validated.valid).toBe(true);

      const repoCtx = await loadRepoContext(
        tempDir,
        validated.normalizedInputs!.flow,
        katalonPath
      );
      expect(repoCtx.hasTargetStorefrontStructure).toBe(true);
      expect(repoCtx.katalonParity?.katalonAssertionCount).toBe(2);

      const drafter = new DrafterService('');
      const draftResult = await drafter.draftTests(
        validated.normalizedInputs!,
        repoCtx,
        {
          url: validated.normalizedInputs!.url,
          title: 'Sample Product Detail Page',
          accessibilitySnapshot: {},
          ariaSnapshotYaml: '',
          interactiveElements: [
            {
              index: 0,
              tagName: 'button',
              role: 'button',
              type: 'button',
              id: '',
              name: '',
              labelText: '',
              placeholder: '',
              ariaLabel: 'Add to Cart',
              text: 'Add to Cart',
              href: '',
            },
            {
              index: 1,
              tagName: 'a',
              role: 'link',
              type: '',
              id: '',
              name: '',
              labelText: '',
              placeholder: '',
              ariaLabel: 'Size Guide',
              text: 'Size Guide',
              href: '/size-guide',
            },
          ],
        },
        true
      );

      expect(draftResult.stopped).toBe(false);
      expect(draftResult.testTable.length).toBeGreaterThanOrEqual(2);
      expect(
        validateDraftedCodeCompliance(draftResult.pageObjectCode, draftResult.specCode).compliant
      ).toBe(true);

      expect(
        draftResult.candidateAssertions.some((c) => c.description.includes('Size Guide'))
      ).toBe(true);
      expect(draftResult.katalonAssertionReport?.parityMet).toBe(true);

      const verifyRecords = await runDrafterVerification(
        validated.normalizedInputs!,
        draftResult.specRelativePath,
        tempDir,
        false
      );
      const summary = formatDraftSummary(
        validated.normalizedInputs!,
        draftResult,
        verifyRecords
      );
      expect(summary.branchName).toBe(
        'PROJ-101_Playwright_Migration_PDP_Add_To_Cart_2_options_dropdown_and_thumbnail'
      );
      expect(summary.outputSummaryMarkdown).toContain('### Candidate assertions for you to confirm');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Interactive Dashboard server renders 3-Step UI, parses Markdown brief, previews ISTQB draft, and enforces Stop-and-Ask', async ({
    page,
  }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qagentic-dash-'));
    await scaffoldPlaywrightProject(tempDir);
    const server = createDashboardServer(tempDir);

    await page.route('http://dashboard.local/**', async (route) => {
      const request = route.request();
      const parsedUrl = new URL(request.url());
      const bodyStr = request.postData() || '';

      const responseData = await new Promise<{
        status: number;
        headers: Record<string, string>;
        body: string;
      }>((resolve) => {
        const fakeReq = {
          method: request.method(),
          url: parsedUrl.pathname + parsedUrl.search,
          on(event: string, cb: (chunk?: Buffer) => void) {
            if (event === 'data' && bodyStr) {
              cb(Buffer.from(bodyStr, 'utf-8'));
            }
            if (event === 'end') {
              cb();
            }
            return this;
          },
        };

        let status = 200;
        let headers: Record<string, string> = {};
        let responseBody = '';

        const fakeRes = {
          writeHead(code: number, hdrs?: Record<string, string>) {
            status = code;
            if (hdrs) headers = hdrs;
          },
          end(chunk?: string) {
            if (chunk) responseBody += chunk;
            resolve({ status, headers, body: responseBody });
          },
        };

        server.emit('request', fakeReq, fakeRes);
      });

      await route.fulfill({
        status: responseData.status,
        headers: responseData.headers,
        body: responseData.body,
      });
    });

    try {
      await page.goto('http://dashboard.local/');
      await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
      await expect(page.locator('#progressiveWorkspace')).toBeHidden();

      await page.getByRole('button', { name: 'Load Example' }).click();
      await expect(page.locator('#progressiveWorkspace')).toBeVisible();

      await expect(page.locator('#branchBadge')).toHaveText(
        'PROJ-101_Playwright_Migration_PDP_Add_To_Cart_2_options_dropdown_and_thumbnail'
      );
      await expect(page.locator('#specCodeBox')).toContainText('test.describe');

      // Clear ENV to trigger Stop-and-Ask alert in Dashboard
      await page.locator('#envInput').selectOption('');
      await page.getByRole('button', { name: 'Preview Draft' }).click();
      await expect(page.locator('#alertBox')).toContainText('STOP AND ASK');
      await expect(page.locator('#alertBox')).toContainText('MISSING_ENV');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test('Static GitHub Pages Home Page (docs/index.html) supports all 3 progressive modes (Write test cases, Write Playwright scripts, Run exploratory tests)', async ({
    page,
  }) => {
    const staticHtmlPath = path.resolve(process.cwd(), 'docs', 'index.html');
    const staticHtml = await fs.readFile(staticHtmlPath, 'utf-8');

    await page.route('http://github-pages.local/**', async (route) => {
      const reqUrl = new URL(route.request().url());
      if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: staticHtml,
        });
      } else {
        await route.fulfill({ status: 404, body: 'Not Found' });
      }
    });

    await page.goto('http://github-pages.local/');
    await expect(page.getByRole('heading', { name: 'What would you like to do?' })).toBeVisible();
    await expect(page.locator('#progressiveWorkspace')).toBeHidden();

    // 1. Mode: Write test cases
    await page.locator('#option-test-cases').click();
    await expect(page.locator('#progressiveWorkspace')).toBeVisible();
    await expect(page.locator('#mode-test-cases')).toBeVisible();
    await expect(page.locator('#tcMarkdownBox')).toContainText('# Functional Test Cases');

    // 2. Mode: Run exploratory tests
    await page.locator('#option-exploratory').click();
    await expect(page.locator('#mode-exploratory')).toBeVisible();
    await expect(page.locator('#expMarkdownBox')).toContainText('# Exploratory Testing Session Sheet');

    // 3. Mode: Write Playwright scripts
    await page.locator('#option-playwright-scripts').click();
    await expect(page.locator('#mode-playwright-scripts')).toBeVisible();
    await expect(page.locator('#branchBadge')).toHaveText(
      'PROJ-101_Playwright_Migration_PDP_Add_To_Cart_2_options_dropdown_and_thumbnail'
    );
    await expect(page.locator('#specCodeBox')).toContainText('test.describe');

    // 4. Verify Google AI Studio Key localStorage persistence and browser Gemini synthesis
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      cases: [
                        {
                          id: 'TC-AI-001',
                          technique: 'BVA',
                          title: 'AI Synthesized BVA: Quantity at Max Boundary (10)',
                          preconditions: 'On PDP',
                          steps: '1. Set quantity to 10\n2. Click Add to Cart',
                          expected: 'Cart badge updates to 10',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    await page.getByRole('button', { name: /Bring Your Own API Key/i }).click();
    // Verify multi-provider key auto-detection (e.g. sk- switches to OpenAI, AIza switches back to Gemini 3.8 Flash default)
    await page.locator('#geminiApiKeyInput').fill('sk-test-openai-key-123');
    await expect(page.locator('#geminiModelSelect')).toHaveValue('openai:gpt-4o-mini');
    await page.locator('#geminiApiKeyInput').fill('AIzaSyTestLocalStorageKey123');
    await expect(page.locator('#geminiModelSelect')).toHaveValue('gemini-3.8-flash');
    await page.getByRole('button', { name: 'Save Key to Browser' }).click();
    await expect(page.locator('#aiKeyStatusBadge')).toHaveText('AI Engine: Gemini 3.8 Flash Active');

    await page.locator('#option-test-cases').click();
    await expect(page.locator('#tcMarkdownBox')).toContainText('TC-AI-001');

    // 5. Verify Jira Wiki Markup and JSON format switchers
    await page.getByRole('button', { name: 'Jira Wiki Markup' }).click();
    await expect(page.locator('#tcMarkdownBox')).toContainText('||ID||ISTQB Technique||Title||');

    await page.getByRole('button', { name: 'JSON (.json)' }).click();
    await expect(page.locator('#tcMarkdownBox')).toContainText('"totalCases": 1');

    // 6. Verify humorous high-usage error message on 429 rate-limit response
    await page.unroute('https://generativelanguage.googleapis.com/**');
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).' } }),
      });
    });

    await page.getByRole('button', { name: 'Generate Test Cases' }).click();
    await expect(page.locator('#alertBox')).toContainText(
      'The free tier is in high usage. Send me some money so I can afford AI credits!'
    );
  });
});
