import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, Page } from '@playwright/test';

// I am defining the structure for interactive DOM elements so the LLM synthesizer and dashboard have exact role, label, placeholder, text, and fallback data-qa metadata.
export interface InteractiveElementInfo {
  index?: number;
  tagName: string;
  role: string;
  type: string;
  id: string;
  name: string;
  labelText: string;
  placeholder: string;
  ariaLabel: string;
  dataQa?: string;
  text: string;
  href: string;
  recommendedLocator?: string;
  locatorStrategy?: 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'data-qa';
}

// I am defining options for fast single-URL or DOM-subset scraping so sessions stay fast and avoid noisy headers/footers.
export interface ExtractPageOptions {
  scopeSelector?: string;
  rolesFilter?: string[];
  maxElements?: number;
  waitUntil?: 'domcontentloaded' | 'load' | 'networkidle';
  timeoutMs?: number;
  useCache?: boolean;
  cacheDir?: string;
  checkMobileDifferences?: boolean;
}

// I am defining the complete page extraction payload passed downstream to the scenario synthesizer, drafter, and dashboard.
export interface ExtractedPageData {
  url: string;
  title: string;
  scopeSelector?: string;
  extractedAt?: string;
  durationMs?: number;
  fromCache?: boolean;
  accessibilitySnapshot: unknown;
  ariaSnapshotYaml: string;
  interactiveElements: InteractiveElementInfo[];
  mobileDifferenceNotes?: string[];
}

// I am maintaining an in-memory snapshot cache keyed by URL and scope so repeated drafting in a session is instantaneous.
const memorySnapshotCache = new Map<string, ExtractedPageData>();

// I am declaring the legacy Playwright accessibility interface to maintain compatibility across Playwright versions while calling page.accessibility.snapshot().
interface PageWithAccessibility extends Page {
  accessibility?: {
    snapshot: () => Promise<unknown>;
  };
}

// I am computing the highest-priority Playwright locator string following the strict order: getByRole -> getByLabel -> getByPlaceholder -> getByText -> data-qa fallback.
export function buildRecommendedLocator(el: Omit<InteractiveElementInfo, 'recommendedLocator' | 'locatorStrategy'>): {
  recommendedLocator: string;
  locatorStrategy: 'getByRole' | 'getByLabel' | 'getByPlaceholder' | 'getByText' | 'data-qa';
} {
  const accessibleName = (el.ariaLabel || el.labelText || el.text || '').trim();
  const cleanRole = (el.role || '').trim();

  if (
    cleanRole &&
    ['button', 'link', 'heading', 'checkbox', 'radio', 'combobox', 'textbox', 'tab', 'menuitem', 'switch'].includes(
      cleanRole
    ) &&
    accessibleName
  ) {
    return {
      recommendedLocator: `page.getByRole(${JSON.stringify(cleanRole)}, { name: ${JSON.stringify(accessibleName)} })`,
      locatorStrategy: 'getByRole',
    };
  }

  if (el.labelText.trim()) {
    return {
      recommendedLocator: `page.getByLabel(${JSON.stringify(el.labelText.trim())})`,
      locatorStrategy: 'getByLabel',
    };
  }

  if (el.placeholder.trim()) {
    return {
      recommendedLocator: `page.getByPlaceholder(${JSON.stringify(el.placeholder.trim())})`,
      locatorStrategy: 'getByPlaceholder',
    };
  }

  if (el.text.trim() && el.text.trim().length <= 80) {
    return {
      recommendedLocator: `page.getByText(${JSON.stringify(el.text.trim())}, { exact: true })`,
      locatorStrategy: 'getByText',
    };
  }

  if (el.dataQa && el.dataQa.trim()) {
    return {
      recommendedLocator: `page.locator('[data-qa=${JSON.stringify(el.dataQa.trim())}]')`,
      locatorStrategy: 'data-qa',
    };
  }

  if (cleanRole) {
    return {
      recommendedLocator: `page.getByRole(${JSON.stringify(cleanRole)})`,
      locatorStrategy: 'getByRole',
    };
  }

  return {
    recommendedLocator: `page.getByText(${JSON.stringify(accessibleName || el.tagName)})`,
    locatorStrategy: 'getByText',
  };
}

// I am polyfilling page.accessibility.snapshot() when running on modern Playwright builds where accessibility.snapshot was superseded by ariaSnapshot.
function ensureAccessibilitySnapshotSupport(page: PageWithAccessibility, scopeSelector?: string): void {
  if (!page.accessibility) {
    page.accessibility = {
      snapshot: async () => {
        const rootSelector = scopeSelector && scopeSelector.trim() ? scopeSelector.trim() : 'body';
        const rootLocator = page.locator(rootSelector).first();
        const rootCount = await rootLocator.count();
        const targetLocator = rootCount > 0 ? rootLocator : page.locator('body');

        // I am capturing the semantic ARIA tree snapshot from the scoped root or document body to preserve accessibility hierarchy.
        const ariaYaml = await targetLocator.ariaSnapshot();
        const children = await page.evaluate((scopedRootSel) => {
          const rootNode =
            (scopedRootSel ? document.querySelector(scopedRootSel) : document.body) || document.body;
          const relevantNodes = Array.from(
            rootNode.querySelectorAll(
              'h1, h2, h3, h4, p, a, button, input, select, textarea, label, [role], [data-qa], #flash, .flash'
            )
          );

          return relevantNodes.map((el) => {
            const explicitRole = el.getAttribute('role');
            const tag = el.tagName.toLowerCase();
            let role = explicitRole || tag;
            if (!explicitRole) {
              if (tag === 'a' && el.hasAttribute('href')) role = 'link';
              else if (tag === 'button') role = 'button';
              else if (tag === 'input') {
                const type = (el.getAttribute('type') || 'text').toLowerCase();
                if (type === 'submit' || type === 'button' || type === 'reset') role = 'button';
                else if (type === 'checkbox') role = 'checkbox';
                else if (type === 'radio') role = 'radio';
                else role = 'textbox';
              } else if (tag === 'textarea') role = 'textbox';
              else if (tag === 'select') role = 'combobox';
              else if (/^h[1-6]$/.test(tag)) role = 'heading';
              else if (tag === 'form') role = 'form';
            }

            let name = (el.getAttribute('aria-label') || '').trim();
            const id = el.getAttribute('id');
            if (!name && id) {
              const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
              if (label && label.textContent) name = label.textContent.trim();
            }
            if (!name) {
              const parentLabel = el.closest('label');
              if (parentLabel && parentLabel.textContent) name = parentLabel.textContent.trim();
            }
            if (!name) {
              const placeholder = el.getAttribute('placeholder');
              if (placeholder) name = placeholder.trim();
            }
            if (!name) {
              name = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120);
            }

            return {
              role,
              name,
              tag,
              id: id || undefined,
              dataQa: el.getAttribute('data-qa') || undefined,
            };
          });
        }, scopeSelector || '');

        return {
          role: 'WebArea',
          name: await page.title(),
          ariaSnapshot: ariaYaml,
          children,
        };
      },
    };
  }
}

function getCacheKey(targetUrl: string, options?: ExtractPageOptions): string {
  const raw = JSON.stringify({
    url: targetUrl,
    scopeSelector: options?.scopeSelector || '',
    rolesFilter: options?.rolesFilter || [],
    maxElements: options?.maxElements || 0,
    checkMobileDifferences: Boolean(options?.checkMobileDifferences),
  });
  return crypto.createHash('sha1').update(raw).digest('hex');
}

// I am launching headless Chromium, navigating to the target URL, and extracting either the full page or a targeted DOM subset so sessions stay fast.
export async function extractPageStructure(
  targetUrl: string,
  options?: ExtractPageOptions
): Promise<ExtractedPageData> {
  const startTime = Date.now();
  const cacheKey = getCacheKey(targetUrl, options);

  if (options?.useCache && memorySnapshotCache.has(cacheKey)) {
    const cached = memorySnapshotCache.get(cacheKey)!;
    return {
      ...cached,
      fromCache: true,
      durationMs: Date.now() - startTime,
    };
  }

  if (options?.useCache && options?.cacheDir) {
    try {
      const diskCachePath = path.join(options.cacheDir, `${cacheKey}.json`);
      const content = await fs.readFile(diskCachePath, 'utf-8');
      const parsed = JSON.parse(content) as ExtractedPageData;
      memorySnapshotCache.set(cacheKey, parsed);
      return {
        ...parsed,
        fromCache: true,
        durationMs: Date.now() - startTime,
      };
    } catch {
      // I am proceeding with live extraction when no cached snapshot exists on disk.
    }
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = (await context.newPage()) as PageWithAccessibility;

  try {
    // I am blocking non-essential static sub-resources so third-party trackers and heavy media never stall extraction.
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet', 'script'].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });

    const waitUntil = options?.waitUntil ?? 'domcontentloaded';
    const timeoutMs = options?.timeoutMs ?? 20000;

    // I am navigating to the single target URL without crawling child links to keep extraction fast.
    await page.goto(targetUrl, { waitUntil, timeout: timeoutMs });

    const title = await page.title();
    const scopeSelector = options?.scopeSelector?.trim() || undefined;

    // I am ensuring page.accessibility.snapshot() is available and extracting interactive accessibility tree nodes within the requested scope.
    ensureAccessibilitySnapshotSupport(page, scopeSelector);
    const accessibilitySnapshot = await page.accessibility!.snapshot();

    const scopedRoot = scopeSelector ? page.locator(scopeSelector).first() : page.locator('body');
    const scopedCount = await scopedRoot.count();
    const ariaSnapshotYaml = await (scopedCount > 0 ? scopedRoot : page.locator('body')).ariaSnapshot();

    // I am querying all user-interactive and semantic feedback elements inside the scope to map their exact labels, roles, placeholders, and data-qa attributes.
    const rawElements = await page.evaluate(
      ({ scopeSel }): Omit<InteractiveElementInfo, 'recommendedLocator' | 'locatorStrategy'>[] => {
        const root = (scopeSel ? document.querySelector(scopeSel) : document.body) || document.body;
        const selector = [
          'a[href]',
          'button',
          'input:not([type="hidden"])',
          'select',
          'textarea',
          '[role="button"]',
          '[role="link"]',
          '[role="checkbox"]',
          '[role="radio"]',
          '[role="textbox"]',
          '[role="combobox"]',
          '[role="alert"]',
          '[role="status"]',
          '[data-qa]',
          'h1',
          'h2',
          'h3',
          '#flash',
          '.flash',
        ].join(', ');

        const elements = Array.from(root.querySelectorAll(selector));

        return elements.map((el) => {
          const explicit = el.getAttribute('role');
          const tag = el.tagName.toLowerCase();
          let role = explicit || '';
          if (!role) {
            if (tag === 'a' && el.hasAttribute('href')) role = 'link';
            else if (tag === 'button') role = 'button';
            else if (tag === 'input') {
              const type = (el.getAttribute('type') || 'text').toLowerCase();
              if (['button', 'submit', 'reset'].includes(type)) role = 'button';
              else if (type === 'checkbox') role = 'checkbox';
              else if (type === 'radio') role = 'radio';
              else role = 'textbox';
            } else if (tag === 'textarea') role = 'textbox';
            else if (tag === 'select') role = 'combobox';
            else if (/^h[1-6]$/.test(tag)) role = 'heading';
          }

          let labelText = '';
          const id = el.getAttribute('id') || '';
          if (id) {
            const associatedLabel = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (associatedLabel?.textContent) {
              labelText = associatedLabel.textContent.trim();
            }
          }
          if (!labelText) {
            const wrappingLabel = el.closest('label');
            if (wrappingLabel?.textContent) {
              labelText = wrappingLabel.textContent.trim();
            }
          }

          return {
            tagName: tag,
            role,
            type: el.getAttribute('type') || '',
            id,
            name: el.getAttribute('name') || '',
            labelText,
            placeholder: el.getAttribute('placeholder') || '',
            ariaLabel: el.getAttribute('aria-label') || '',
            dataQa: el.getAttribute('data-qa') || el.getAttribute('data-testid') || '',
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150),
            href: el.getAttribute('href') || '',
          };
        });
      },
      { scopeSel: scopeSelector || '' }
    );

    let filteredElements = rawElements.map((el, index) => {
      const locatorMeta = buildRecommendedLocator(el);
      return {
        ...el,
        index,
        ...locatorMeta,
      };
    });

    if (options?.rolesFilter && options.rolesFilter.length > 0) {
      const allowedRoles = new Set(options.rolesFilter.map((r) => r.toLowerCase().trim()));
      filteredElements = filteredElements.filter(
        (el) => allowedRoles.has(el.role.toLowerCase()) || allowedRoles.has(el.tagName.toLowerCase())
      );
    }

    if (options?.maxElements && options.maxElements > 0) {
      filteredElements = filteredElements.slice(0, options.maxElements);
    }

    const mobileDifferenceNotes: string[] = [];
    if (options?.checkMobileDifferences) {
      // I am resizing the viewport to a mobile width to detect mobile-specific controls such as hamburger menus or app banners.
      await page.setViewportSize({ width: 390, height: 844 });
      const mobileFindings = await page.evaluate(() => {
        const notes: string[] = [];
        const menuButtons = Array.from(document.querySelectorAll('button, [role="button"], [data-qa]')).filter(
          (el) => /menu|hamburger|navigation|drawer/i.test(el.getAttribute('aria-label') || el.textContent || '')
        );
        if (menuButtons.length > 0) {
          notes.push('Detected mobile menu / hamburger trigger in mobile viewport — handle in Page Object via platform helpers.');
        }
        const banners = Array.from(document.querySelectorAll('[role="banner"], [role="dialog"], [data-qa]')).filter(
          (el) => /app|install|banner/i.test(el.getAttribute('aria-label') || el.textContent || '')
        );
        if (banners.length > 0) {
          notes.push('Detected mobile banner / dialog — encapsulate dismissal in Page Object via platform helpers.');
        }
        return notes;
      });
      mobileDifferenceNotes.push(...mobileFindings);
    }

    const extractedData: ExtractedPageData = {
      url: targetUrl,
      title,
      scopeSelector,
      extractedAt: new Date().toISOString(),
      durationMs: Date.now() - startTime,
      fromCache: false,
      accessibilitySnapshot,
      ariaSnapshotYaml,
      interactiveElements: filteredElements,
      mobileDifferenceNotes: mobileDifferenceNotes.length > 0 ? mobileDifferenceNotes : undefined,
    };

    memorySnapshotCache.set(cacheKey, extractedData);
    if (options?.cacheDir) {
      try {
        await fs.mkdir(options.cacheDir, { recursive: true });
        await fs.writeFile(
          path.join(options.cacheDir, `${cacheKey}.json`),
          JSON.stringify(extractedData, null, 2),
          'utf-8'
        );
      } catch {
        // I am ignoring cache write errors on read-only paths so extraction still succeeds.
      }
    }

    return extractedData;
  } finally {
    // I am closing the browser context and instance in a finally block to prevent orphaned Chromium processes.
    await context.close();
    await browser.close();
  }
}
