import { chromium, Page } from '@playwright/test';

// I am defining the structure for interactive DOM elements so the LLM synthesizer has exact label, role, and placeholder metadata.
export interface InteractiveElementInfo {
  tagName: string;
  role: string;
  type: string;
  id: string;
  name: string;
  labelText: string;
  placeholder: string;
  ariaLabel: string;
  text: string;
  href: string;
}

// I am defining the complete page extraction payload passed downstream to the scenario synthesizer and spec generator.
export interface ExtractedPageData {
  url: string;
  title: string;
  accessibilitySnapshot: unknown;
  ariaSnapshotYaml: string;
  interactiveElements: InteractiveElementInfo[];
}

// I am declaring the legacy Playwright accessibility interface to maintain compatibility across Playwright versions while calling page.accessibility.snapshot().
interface PageWithAccessibility extends Page {
  accessibility?: {
    snapshot: () => Promise<unknown>;
  };
}

// I am polyfilling page.accessibility.snapshot() when running on modern Playwright builds where accessibility.snapshot was superseded by ariaSnapshot.
function ensureAccessibilitySnapshotSupport(page: PageWithAccessibility): void {
  if (!page.accessibility) {
    page.accessibility = {
      snapshot: async () => {
        // I am capturing the semantic ARIA tree snapshot from the document body to preserve full accessibility hierarchy.
        const ariaYaml = await page.locator('body').ariaSnapshot();
        const children = await page.evaluate(() => {
          const relevantNodes = Array.from(
            document.querySelectorAll(
              'h1, h2, h3, h4, p, a, button, input, select, textarea, label, [role], #flash, .flash'
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
            };
          });
        });

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

// I am launching headless Chromium, navigating to the target URL, waiting for network idle, and extracting the accessibility tree and interactive element attributes.
export async function extractPageStructure(targetUrl: string): Promise<ExtractedPageData> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = (await context.newPage()) as PageWithAccessibility;

  try {
    // I am blocking non-essential static sub-resources so third-party trackers never stall networkidle during extraction.
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet', 'script'].includes(resourceType)) {
        return route.abort();
      }
      return route.continue();
    });

    // I am navigating to the target URL and waiting until network traffic settles so dynamic views finish rendering.
    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const title = await page.title();

    // I am ensuring page.accessibility.snapshot() is available and extracting interactive accessibility tree nodes to avoid DOM noise.
    ensureAccessibilitySnapshotSupport(page);
    const accessibilitySnapshot = await page.accessibility!.snapshot();
    const ariaSnapshotYaml = await page.locator('body').ariaSnapshot();

    // I am querying all user-interactive and semantic feedback elements to map their exact labels, roles, and placeholders for semantic locator generation.
    const interactiveElements = await page.evaluate((): InteractiveElementInfo[] => {
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
        'h1',
        'h2',
        'h3',
        '#flash',
        '.flash',
      ].join(', ');

      const elements = Array.from(document.querySelectorAll(selector));

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
          text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 150),
          href: el.getAttribute('href') || '',
        };
      });
    });

    return {
      url: targetUrl,
      title,
      accessibilitySnapshot,
      ariaSnapshotYaml,
      interactiveElements,
    };
  } finally {
    // I am closing the browser context and instance in a finally block to prevent orphaned Chromium processes.
    await context.close();
    await browser.close();
  }
}
