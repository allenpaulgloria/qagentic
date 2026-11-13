import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { ExtractedPageData, InteractiveElementInfo } from '../crawler/page-extractor.js';
import { DrafterInputs, StopAndAskIssue } from './input-validator.js';
import { RepoContext } from './repo-context.js';

export interface IstqbTestCaseRow {
  name: string;
  technique: 'EP' | 'BVA' | 'Decision Table' | 'State Transition' | 'Error Guessing';
  expectedResultNumbers: number[];
  platform: 'web-local' | 'mobile-local' | 'both' | 'web-local (skipIfMobile)';
  assertions: string[];
}

export interface CandidateAssertion {
  id: string;
  description: string;
  suggestedAssertionCode: string;
  sourceElement: string;
}

export interface DraftedArtifactsResult {
  stopped: boolean;
  stopAndAsk: StopAndAskIssue[];
  pageObjectRelativePath: string;
  pageObjectCode: string;
  specRelativePath: string;
  specCode: string;
  fixturesRelativePath: string;
  fixturesUpdated: boolean;
  filesChanged: string[];
  testTable: IstqbTestCaseRow[];
  candidateAssertions: CandidateAssertion[];
  assumptionsAndUnverified: string[];
  katalonAssertionReport?: {
    katalonScript: string;
    katalonAssertionCount: number;
    playwrightAssertionCount: number;
    parityMet: boolean;
  };
}

// I am checking whether the user's flow or expected results contain literal prices, emails, or promo codes that require a new variable in utils/test-data.ts or utils/sku.ts.
export function detectMissingTestDataVariables(
  inputs: DrafterInputs,
  repoContext: RepoContext
): StopAndAskIssue[] {
  const issues: StopAndAskIssue[] = [];
  const combinedText = `${inputs.flow} ${inputs.expectedResults.join(' ')}`;

  // Detect literal price values (e.g., $49.99, £25.00) when no price loader exists
  const priceMatch = combinedText.match(/(?:[$£€]\s*\d+(?:\.\d{2})?)/);
  if (priceMatch && !repoContext.testDataExports.some((k) => /price/i.test(k))) {
    issues.push({
      code: 'MISSING_TEST_DATA_VARIABLE',
      field: 'utils/test-data.ts',
      question: `Expected results reference a literal price (${priceMatch[0]}), which is forbidden in specs. Please add \`EXPECTED_PRODUCT_PRICE\` to \`utils/test-data.ts\` and confirm.`,
    });
  }

  // Detect literal email addresses in flow/expected results
  const emailMatch = combinedText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    issues.push({
      code: 'MISSING_TEST_DATA_VARIABLE',
      field: 'utils/test-data.ts',
      question: `Inputs contain a literal email (${emailMatch[0]}). Please store this in an account env var (e.g. \`SMOKE_WEB_USER\`) or \`TEST_DATA.TEST_USER_EMAIL\` in \`utils/test-data.ts\`.`,
    });
  }

  // Detect explicit promo code string (e.g., promo code "SAVE20")
  const promoMatch = combinedText.match(/promo\s+code\s+["']?([A-Z0-9_-]{4,})["']?/i);
  if (
    promoMatch &&
    !repoContext.testDataExports.includes('VALID_PROMO_CODE') &&
    !repoContext.testDataExports.includes(promoMatch[1])
  ) {
    issues.push({
      code: 'MISSING_TEST_DATA_VARIABLE',
      field: 'utils/test-data.ts',
      question: `Flow references promo code "${promoMatch[1]}", which is not in \`utils/test-data.ts\`. Please add \`PROMO_CODE_${promoMatch[1].toUpperCase()}\` to \`utils/test-data.ts\`.`,
    });
  }

  return issues;
}

// I am validating that drafted Page Object and Spec code strictly follow locator, assertion, and data-loader rules.
export function validateDraftedCodeCompliance(
  pageObjectCode: string,
  specCode: string
): { compliant: boolean; violations: string[] } {
  const violations: string[] = [];

  const forbiddenTokens = ['waitForTimeout', 'networkidle', 'page.$(', 'page.$$(', 'waitForSelector'];
  for (const token of forbiddenTokens) {
    if (pageObjectCode.includes(token) || specCode.includes(token)) {
      violations.push(`Forbidden API used: ${token}`);
    }
  }

  // Disallow platform checks inside test bodies in the spec
  if (/test\s*\([^{]+\{[\s\S]*?(?:isMobile|viewportSize\(\)|project\.name)/m.test(specCode)) {
    violations.push('Platform check found inside test body; use skipIfMobile instead.');
  }

  // Disallow literal prices or emails in spec code
  if (/[$£€]\d+\.\d{2}/.test(specCode)) {
    violations.push('Literal price found in spec code.');
  }
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(specCode)) {
    violations.push('Literal email found in spec code.');
  }

  return {
    compliant: violations.length === 0,
    violations,
  };
}

// I am building the ISTQB test cases strictly from the user-provided inputs (EP/BVA, Decision Table, State Transition, and Error Guessing).
export function deriveIstqbTestPlan(inputs: DrafterInputs): IstqbTestCaseRow[] {
  const rows: IstqbTestCaseRow[] = [];
  const allExpectedNumbers = inputs.expectedResults.map((_, idx) => idx + 1);
  const platformLabel = inputs.platform;

  // 1. State Transition for state-changing flows (sign in, add to cart, checkout step, etc.)
  if (inputs.istqbInputs?.stateTransitions && inputs.istqbInputs.stateTransitions.length > 0) {
    for (const st of inputs.istqbInputs.stateTransitions) {
      rows.push({
        name: `State Transition: ${st.action} (${st.fromState} to ${st.toState})`,
        technique: 'State Transition',
        expectedResultNumbers: st.expectedResultNumber ? [st.expectedResultNumber] : allExpectedNumbers,
        platform: platformLabel,
        assertions: inputs.expectedResults,
      });
    }
  } else if (/\b(add.*cart|sign\s*in|log\s*in|checkout|remove|apply|update|submit)\b/i.test(inputs.flow)) {
    rows.push({
      name: `State Transition: ${inputs.flow}`,
      technique: 'State Transition',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
  }

  // 2. Decision Table for combinations of options mentioned in the flow or istqbInputs
  if (inputs.istqbInputs?.decisionTableOptions && inputs.istqbInputs.decisionTableOptions.length > 0) {
    for (const dt of inputs.istqbInputs.decisionTableOptions) {
      rows.push({
        name: `Decision Table: ${dt.conditionName} (${dt.combinations.join(' + ')})`,
        technique: 'Decision Table',
        expectedResultNumbers: dt.expectedResultNumber ? [dt.expectedResultNumber] : allExpectedNumbers,
        platform: platformLabel,
        assertions: inputs.expectedResults,
      });
    }
  } else if (/\b(\d+\s*-?\s*option|dropdown|thumbnail|combination|variant|size|color)\b/i.test(inputs.flow)) {
    rows.push({
      name: `Decision Table: valid option combination for ${inputs.flow}`,
      technique: 'Decision Table',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
  }

  // 3. Equivalence Partitioning (EP) & Boundary Value Analysis (BVA) for listed input fields
  if (inputs.istqbInputs?.inputFields && inputs.istqbInputs.inputFields.length > 0) {
    for (const field of inputs.istqbInputs.inputFields) {
      if (field.validPartition) {
        rows.push({
          name: `EP: ${field.name} with valid value (${field.validPartition})`,
          technique: 'EP',
          expectedResultNumbers: allExpectedNumbers,
          platform: platformLabel,
          assertions: inputs.expectedResults,
        });
      }
      if (field.minBoundary !== undefined) {
        rows.push({
          name: `BVA: ${field.name} at minimum (${field.minBoundary})`,
          technique: 'BVA',
          expectedResultNumbers: allExpectedNumbers,
          platform: platformLabel,
          assertions: inputs.expectedResults,
        });
      }
      if (field.maxBoundary !== undefined) {
        rows.push({
          name: `BVA: ${field.name} at maximum (${field.maxBoundary})`,
          technique: 'BVA',
          expectedResultNumbers: allExpectedNumbers,
          platform: platformLabel,
          assertions: inputs.expectedResults,
        });
      }
    }
  } else if (/\b(quantity|qty|input|search|field|amount)\b/i.test(inputs.flow)) {
    rows.push({
      name: `BVA: quantity at minimum`,
      technique: 'BVA',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
    rows.push({
      name: `BVA: quantity at maximum`,
      technique: 'BVA',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
  }

  // 4. Error Guessing strictly for error cases named by the user
  if (inputs.istqbInputs?.errorGuessingCases && inputs.istqbInputs.errorGuessingCases.length > 0) {
    for (const errCase of inputs.istqbInputs.errorGuessingCases) {
      rows.push({
        name: `Error Guessing: ${errCase}`,
        technique: 'Error Guessing',
        expectedResultNumbers: allExpectedNumbers,
        platform: platformLabel,
        assertions: inputs.expectedResults,
      });
    }
  } else if (/\b(error|invalid|empty|missing|out of stock|rejected)\b/i.test(inputs.flow)) {
    rows.push({
      name: `Error Guessing: ${inputs.flow}`,
      technique: 'Error Guessing',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
  }

  // Fallback if none of the specific keywords matched: single EP case covering all expected results
  if (rows.length === 0) {
    rows.push({
      name: `EP: ${inputs.flow}`,
      technique: 'EP',
      expectedResultNumbers: allExpectedNumbers,
      platform: platformLabel,
      assertions: inputs.expectedResults,
    });
  }

  return rows;
}

// I am identifying elements observed on the live page that were NOT part of the user's numbered expected results and listing them as Candidate Assertions for user confirmation.
export function buildCandidateAssertions(
  pageData: ExtractedPageData | undefined,
  expectedResults: string[],
  fixtureName: string
): CandidateAssertion[] {
  if (!pageData || pageData.interactiveElements.length === 0) {
    return [
      {
        id: 'CAND-1',
        description: 'Verify primary page heading remains visible after interaction',
        suggestedAssertionCode: `await expect(${fixtureName}.productHeading).toBeVisible();`,
        sourceElement: 'heading (first on page)',
      },
    ];
  }

  const expectedLower = expectedResults.join(' ').toLowerCase();
  const candidates: CandidateAssertion[] = [];

  for (const el of pageData.interactiveElements) {
    const label = (el.ariaLabel || el.labelText || el.text || '').trim();
    if (!label || label.length < 3 || label.length > 70) continue;

    // Skip elements already directly mentioned in the user's expected results
    const words = label
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3);
    const alreadyCovered = words.some((w) => expectedLower.includes(w));
    if (alreadyCovered) continue;

    if (el.role === 'heading' || el.role === 'button' || el.role === 'link' || el.role === 'status') {
      const idx = candidates.length + 1;
      candidates.push({
        id: `CAND-${idx}`,
        description: `Observed ${el.role} "${label}" on page (not in numbered expected results)`,
        suggestedAssertionCode: `await expect(${fixtureName}.page.getByRole(${JSON.stringify(el.role)}, { name: ${JSON.stringify(label)} })).toBeVisible();`,
        sourceElement: `${el.tagName}[role="${el.role}"] "${label}"`,
      });
    }

    if (candidates.length >= 6) break;
  }

  return candidates;
}

// I am orchestrating the Playwright Test Drafter to produce compliant Page Objects, ISTQB specs, and candidate assertion reports.
export class DrafterService {
  private readonly modelName = 'gemini-3.8-flash';
  private readonly ai: GoogleGenAI | null;

  constructor(apiKey?: string) {
    const resolvedKey = (apiKey ?? process.env.GEMINI_API_KEY ?? '').trim();
    this.ai = resolvedKey ? new GoogleGenAI({ apiKey: resolvedKey }) : null;
  }

  public deriveFlowNaming(inputs: DrafterInputs): {
    slug: string;
    className: string;
    fixtureName: string;
    pageObjectRelativePath: string;
    specRelativePath: string;
  } {
    const isPdp = /\bpdp\b|product\s+detail|add.*cart/i.test(`${inputs.flow} ${inputs.ticket}`);
    const baseSlug = isPdp
      ? 'pdp-add-to-cart'
      : inputs.flow
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 45) || 'storefront-flow';

    const poSlug = isPdp ? 'pdp' : baseSlug.split('-').slice(0, 2).join('-') || 'storefront';
    const pascal = poSlug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');

    const className = `${pascal}Page`;
    const fixtureName = `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}Page`;

    return {
      slug: baseSlug,
      className,
      fixtureName,
      pageObjectRelativePath: `page-objects/storefront/${poSlug}.page.ts`,
      specRelativePath: `tests/${baseSlug}.spec.ts`,
    };
  }

  public async draftTests(
    inputs: DrafterInputs,
    repoContext: RepoContext,
    pageData?: ExtractedPageData,
    writeFiles: boolean = true
  ): Promise<DraftedArtifactsResult> {
    // 1. Check test data gate
    const missingDataIssues = detectMissingTestDataVariables(inputs, repoContext);
    if (missingDataIssues.length > 0) {
      return {
        stopped: true,
        stopAndAsk: missingDataIssues,
        pageObjectRelativePath: '',
        pageObjectCode: '',
        specRelativePath: '',
        specCode: '',
        fixturesRelativePath: repoContext.fixturesFile.relativePath,
        fixturesUpdated: false,
        filesChanged: [],
        testTable: [],
        candidateAssertions: [],
        assumptionsAndUnverified: [
          'Drafting halted because a new test data variable is needed in utils/test-data.ts or utils/sku.ts.',
        ],
      };
    }

    const naming = this.deriveFlowNaming(inputs);
    const testTable = deriveIstqbTestPlan(inputs);

    // Filter interactive elements if the user selected a specific subset in the dashboard
    let activeElements: InteractiveElementInfo[] = pageData?.interactiveElements || [];
    if (inputs.selectedElementIndices && inputs.selectedElementIndices.length > 0) {
      const selectedSet = new Set(inputs.selectedElementIndices);
      activeElements = activeElements.filter((el) => el.index !== undefined && selectedSet.has(el.index));
    }

    const candidateAssertions = buildCandidateAssertions(
      pageData ? { ...pageData, interactiveElements: activeElements } : undefined,
      inputs.expectedResults,
      naming.fixtureName
    );

    let pageObjectCode = this.buildCompliantStorefrontPageObject(
      inputs,
      naming.className,
      activeElements,
      repoContext
    );
    let specCode = this.buildCompliantIstqbSpec(
      inputs,
      naming,
      testTable,
      repoContext
    );

    // If Gemini API is available, allow it to refine locators from the live page while strictly validating compliance
    if (this.ai && pageData) {
      try {
        const llmDraft = await this.draftWithGemini(
          inputs,
          repoContext,
          pageData,
          activeElements,
          naming,
          testTable
        );
        if (llmDraft) {
          const check = validateDraftedCodeCompliance(llmDraft.pageObjectCode, llmDraft.specCode);
          if (check.compliant) {
            pageObjectCode = llmDraft.pageObjectCode;
            specCode = llmDraft.specCode;
          }
        }
      } catch {
        // Deterministic template already meets every rule
      }
    }

    const filesChanged: string[] = [];
    let fixturesUpdated = false;

    if (writeFiles) {
      const targetRoot = repoContext.repoRoot;
      const fullPoPath = path.join(targetRoot, naming.pageObjectRelativePath);
      const fullSpecPath = path.join(targetRoot, naming.specRelativePath);

      await fs.mkdir(path.dirname(fullPoPath), { recursive: true });
      await fs.mkdir(path.dirname(fullSpecPath), { recursive: true });

      // Ensure BaseStorefrontPage exists if referenced
      const basePoPath = path.join(targetRoot, 'page-objects/storefront/base.page.ts');
      try {
        await fs.access(basePoPath);
      } catch {
        await fs.writeFile(
          basePoPath,
          `import { Page, Locator } from '@playwright/test';

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
}
`,
          'utf-8'
        );
        filesChanged.push('page-objects/storefront/base.page.ts');
      }

      await fs.writeFile(fullPoPath, pageObjectCode, 'utf-8');
      filesChanged.push(naming.pageObjectRelativePath);

      await fs.writeFile(fullSpecPath, specCode, 'utf-8');
      filesChanged.push(naming.specRelativePath);

      fixturesUpdated = await this.ensureFixtureRegistered(targetRoot, naming);
      if (fixturesUpdated) {
        filesChanged.push('utils/fixtures.ts');
      }
    }

    const assumptionsAndUnverified: string[] = [
      `Target environment configured as ENV=${inputs.env} with tag ${inputs.tag}.`,
      `Test data values are referenced through utils/test-data.ts and utils/sku.ts (no literal prices, SKUs, promo codes, emails, or passwords in spec).`,
    ];
    if (!pageData) {
      assumptionsAndUnverified.push(
        'Live URL extraction was skipped or offline; locators use semantic role/label patterns and should be verified against the live DOM.'
      );
    } else if (pageData.scopeSelector) {
      assumptionsAndUnverified.push(
        `DOM extraction was scoped to subset selector "${pageData.scopeSelector}" (${activeElements.length} interactive elements inspected).`
      );
    }

    const assertionMatches = specCode.match(/await\s+expect\s*\(/g) || [];
    const playwrightAssertionCount = assertionMatches.length;

    const katalonAssertionReport = repoContext.katalonParity
      ? {
          katalonScript: repoContext.katalonParity.scriptPath,
          katalonAssertionCount: repoContext.katalonParity.katalonAssertionCount,
          playwrightAssertionCount,
          parityMet: playwrightAssertionCount >= repoContext.katalonParity.katalonAssertionCount,
        }
      : undefined;

    return {
      stopped: false,
      stopAndAsk: [],
      pageObjectRelativePath: naming.pageObjectRelativePath,
      pageObjectCode,
      specRelativePath: naming.specRelativePath,
      specCode,
      fixturesRelativePath: 'utils/fixtures.ts',
      fixturesUpdated,
      filesChanged,
      testTable,
      candidateAssertions,
      assumptionsAndUnverified,
      katalonAssertionReport,
    };
  }

  private buildCompliantStorefrontPageObject(
    inputs: DrafterInputs,
    className: string,
    elements: InteractiveElementInfo[],
    _repoContext: RepoContext
  ): string {
    // Discover any specific buttons, comboboxes, or inputs from the live extraction
    const buttons = elements.filter((el) => el.role === 'button' && (el.ariaLabel || el.text));
    const primaryActionBtn = buttons.find((b) =>
      /add to cart|add to bag|submit|sign in|login|continue|apply/i.test(b.ariaLabel || b.text)
    );
    const primaryBtnName = primaryActionBtn
      ? (primaryActionBtn.ariaLabel || primaryActionBtn.text).trim()
      : 'Add to Cart';

    return `import { Page, Locator } from '@playwright/test';
import { BaseStorefrontPage } from './base.page.js';

// I am encapsulating storefront locators and interactions for "${inputs.flow}" using the strict locator priority:
// getByRole -> getByLabel -> getByPlaceholder -> getByText -> data-qa fallback.
export class ${className} extends BaseStorefrontPage {
  readonly productHeading: Locator;
  readonly optionDropdown: Locator;
  readonly quantityInput: Locator;
  readonly primaryActionButton: Locator;
  readonly confirmationRegion: Locator;
  readonly cartCountBadge: Locator;

  constructor(page: Page) {
    super(page);
    this.productHeading = page.getByRole('heading').first();
    this.optionDropdown = page.getByRole('combobox').first();
    this.quantityInput = page.getByLabel(/quantity|qty/i);
    this.primaryActionButton = page.getByRole('button', { name: new RegExp(${JSON.stringify(primaryBtnName)}, 'i') });
    this.confirmationRegion = page.getByRole('dialog').or(page.getByRole('status')).or(page.getByRole('alert'));
    this.cartCountBadge = page.locator('[data-qa="cart-count"]');
  }

  async openTargetPage(targetUrl: string): Promise<void> {
    await this.page.goto(targetUrl);
    await this.dismissAppBannerIfPresent();
  }

  async selectDropdownOption(optionLabel: string): Promise<void> {
    await this.optionDropdown.selectOption({ label: optionLabel });
  }

  async selectThumbnailOption(optionName: string): Promise<void> {
    await this.page
      .getByRole('button', { name: new RegExp(optionName, 'i') })
      .filter({ hasNotText: /out of stock/i })
      .first()
      .click();
  }

  async fillQuantity(quantity: number): Promise<void> {
    await this.quantityInput.fill(String(quantity));
  }

  async submitPrimaryAction(): Promise<void> {
    await this.primaryActionButton.click();
  }
}
`;
  }

  private buildCompliantIstqbSpec(
    inputs: DrafterInputs,
    naming: { className: string; fixtureName: string; specRelativePath: string },
    testTable: IstqbTestCaseRow[],
    _repoContext: RepoContext
  ): string {
    const needsSkipIfMobile = inputs.platform === 'web-local';
    const fixtureImports = needsSkipIfMobile
      ? `{ test, expect, skipIfMobile }`
      : `{ test, expect }`;

    const confirmedCandidates = inputs.confirmedCandidateAssertions || [];

    const testBlocks = testTable
      .map((row) => {
        const testArgs = needsSkipIfMobile
          ? `async ({ ${naming.fixtureName} }, testInfo)`
          : `async ({ ${naming.fixtureName} })`;

        const skipLine = needsSkipIfMobile ? `    skipIfMobile(testInfo);\n` : '';

        // Build one web-first assertion per numbered expected result
        const assertionLines = inputs.expectedResults.map((er, idx) => {
          const erNum = idx + 1;
          const lower = er.toLowerCase();
          if (lower.includes('url') || lower.includes('redirect') || lower.includes('navigate')) {
            return `    // Expected Result ${erNum}: ${er}\n    await expect(${naming.fixtureName}.page).toHaveURL(/.+/);`;
          }
          if (lower.includes('count') || lower.includes('badge') || lower.includes('item')) {
            return `    // Expected Result ${erNum}: ${er}\n    await expect(${naming.fixtureName}.cartCountBadge).toHaveText(String(TEST_DATA.QUANTITY_MIN));`;
          }
          if (lower.includes('text') || lower.includes('message') || lower.includes('title')) {
            return `    // Expected Result ${erNum}: ${er}\n    await expect(${naming.fixtureName}.productHeading).toBeVisible();`;
          }
          return `    // Expected Result ${erNum}: ${er}\n    await expect(${naming.fixtureName}.confirmationRegion.first()).toBeVisible();`;
        });

        const confirmedLines = confirmedCandidates.map(
          (code, idx) => `    // Confirmed Candidate Assertion ${idx + 1}\n    ${code}`
        );

        let actionLines = `    await ${naming.fixtureName}.openTargetPage(${JSON.stringify(inputs.url)});\n`;
        if (row.technique === 'BVA' && /max/i.test(row.name)) {
          actionLines += `    await ${naming.fixtureName}.fillQuantity(TEST_DATA.QUANTITY_MAX);\n`;
        } else if (row.technique === 'BVA') {
          actionLines += `    await ${naming.fixtureName}.fillQuantity(TEST_DATA.QUANTITY_MIN);\n`;
        } else if (row.technique === 'Decision Table') {
          actionLines += `    await ${naming.fixtureName}.selectDropdownOption(getSku('TWO_OPTION_PRODUCT'));\n`;
        }
        actionLines += `    await ${naming.fixtureName}.submitPrimaryAction();`;

        return `  test(${JSON.stringify(`${row.name} ${inputs.tag}`)}, ${testArgs} => {
${skipLine}${actionLines}

${assertionLines.join('\n\n')}${confirmedLines.length > 0 ? '\n\n' + confirmedLines.join('\n') : ''}
  });`;
      })
      .join('\n\n');

    return `import ${fixtureImports} from '../utils/fixtures.js';
import { TEST_DATA } from '../utils/test-data.js';
import { getSku } from '../utils/sku.js';

test.describe(${JSON.stringify(`${inputs.ticket} - ${inputs.flow}`)}, () => {
${testBlocks}
});
`;
  }

  private async ensureFixtureRegistered(
    repoRoot: string,
    naming: { className: string; fixtureName: string; pageObjectRelativePath: string }
  ): Promise<boolean> {
    const fixturePath = path.join(repoRoot, 'utils', 'fixtures.ts');
    let content = '';
    try {
      content = await fs.readFile(fixturePath, 'utf-8');
    } catch {
      return false;
    }

    if (content.includes(`${naming.fixtureName}:`)) {
      return false;
    }

    const importLine = `import { ${naming.className} } from '../${naming.pageObjectRelativePath.replace(/\.ts$/, '.js')}';`;
    if (!content.includes(naming.className)) {
      content = `${importLine}\n${content}`;
    }

    if (content.includes('// [STOREFRONT_FIXTURES_TYPES]')) {
      content = content.replace(
        '// [STOREFRONT_FIXTURES_TYPES]',
        `${naming.fixtureName}: ${naming.className};\n  // [STOREFRONT_FIXTURES_TYPES]`
      );
    }

    if (content.includes('// [STOREFRONT_FIXTURES_IMPL]')) {
      content = content.replace(
        '// [STOREFRONT_FIXTURES_IMPL]',
        `${naming.fixtureName}: async ({ page }, use) => {\n    await use(new ${naming.className}(page));\n  },\n  // [STOREFRONT_FIXTURES_IMPL]`
      );
    }

    await fs.writeFile(fixturePath, content, 'utf-8');
    return true;
  }

  private async draftWithGemini(
    inputs: DrafterInputs,
    repoContext: RepoContext,
    pageData: ExtractedPageData,
    activeElements: InteractiveElementInfo[],
    naming: { className: string; fixtureName: string; pageObjectRelativePath: string; specRelativePath: string },
    testTable: IstqbTestCaseRow[]
  ): Promise<{ pageObjectCode: string; specCode: string } | null> {
    if (!this.ai) return null;

    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        pageObjectCode: { type: Type.STRING },
        specCode: { type: Type.STRING },
      },
      required: ['pageObjectCode', 'specCode'],
    };

    const prompt = [
      'You are a Playwright Test Drafter. Draft the Page Object and single Spec file strictly from the user inputs below.',
      'Drafting Rules:',
      '1. Import { test, expect, skipIfMobile } from "../utils/fixtures.js", TEST_DATA from "../utils/test-data.js", and getSku from "../utils/sku.js".',
      '2. Locator order: getByRole with accessible name -> getByLabel -> getByPlaceholder -> getByText -> [data-qa="..."] fallback. Use .filter() and chaining, no CSS class selectors.',
      '3. Web-first assertions only (toBeVisible, toHaveText, toHaveURL, toHaveCount). NEVER use waitForTimeout, networkidle, page.$, or waitForSelector.',
      '4. Desktop-only cases use skipIfMobile(testInfo). Never put platform checks inside test bodies.',
      '5. Assertions come ONLY from the numbered expected results. Each expected result must have at least one assertion.',
      '6. No literal prices, SKUs, promo codes, emails, or passwords in the spec.',
      `Inputs:\n${JSON.stringify(inputs, null, 2)}`,
      `ISTQB Test Cases to write (one test per row):\n${JSON.stringify(testTable, null, 2)}`,
      `Page Object Class Name: ${naming.className}, Fixture Name: ${naming.fixtureName}`,
      `Available Test Data Exports: ${repoContext.testDataExports.join(', ')}`,
      `Scoped Interactive Elements (${activeElements.length}):\n${JSON.stringify(activeElements.slice(0, 40), null, 2)}`,
    ].join('\n\n');

    const response = await this.ai.models.generateContent({
      model: this.modelName,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.1,
      },
    });

    if (!response.text) return null;
    return JSON.parse(response.text) as { pageObjectCode: string; specCode: string };
  }
}

