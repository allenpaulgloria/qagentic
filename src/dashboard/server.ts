import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPageStructure, ExtractedPageData } from '../crawler/page-extractor.js';
import { DrafterService } from '../drafter/drafter.service.js';
import {
  DrafterInputs,
  formatBranchName,
  parseMarkdownBrief,
  validateDrafterInputs,
} from '../drafter/input-validator.js';
import { loadRepoContext } from '../drafter/repo-context.js';
import { formatDraftSummary } from '../drafter/summary-formatter.js';
import { runDrafterVerification } from '../drafter/verifier.js';
import { scaffoldPlaywrightProject } from '../scaffolder/project-scaffolder.js';

interface DashboardSessionCache {
  lastPageData?: ExtractedPageData;
}

const sessionCache: DashboardSessionCache = {};

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(raw ? (JSON.parse(raw) as T) : ({} as T));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

// I am starting the lightweight local HTTP dashboard server for fast URL/subset scraping, project scaffolding, and ISTQB test drafting.
export function createDashboardServer(defaultRepoPath: string = process.cwd()): http.Server {
  const drafterService = new DrafterService();

  return http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const parsedUrl = new URL(req.url || '/', 'http://localhost');

    try {
      if (method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        const html = await loadHomePageHtml(defaultRepoPath);
        res.end(html);
        return;
      }

      if (method === 'GET' && parsedUrl.pathname === '/api/context') {
        const repoParam = parsedUrl.searchParams.get('repo') || defaultRepoPath;
        const flowParam = parsedUrl.searchParams.get('flow') || '';
        const ctx = await loadRepoContext(repoParam, flowParam);
        sendJson(res, 200, { ok: true, context: ctx });
        return;
      }

      if (method === 'POST' && parsedUrl.pathname === '/api/scaffold') {
        const body = await readJsonBody<{
          repoPath?: string;
          overwrite?: boolean;
          includePlaywrightConfig?: boolean;
        }>(req);
        const targetRepo = body.repoPath || defaultRepoPath;
        const result = await scaffoldPlaywrightProject(targetRepo, {
          overwrite: Boolean(body.overwrite),
          includePlaywrightConfig: Boolean(body.includePlaywrightConfig),
        });
        const ctx = await loadRepoContext(targetRepo);
        sendJson(res, 200, { ok: true, scaffold: result, context: ctx });
        return;
      }

      if (method === 'POST' && parsedUrl.pathname === '/api/parse-brief') {
        const body = await readJsonBody<{ markdown: string }>(req);
        const parsed = parseMarkdownBrief(body.markdown || '');
        const branchPreview = parsed.ticket ? formatBranchName(parsed.ticket) : '';
        sendJson(res, 200, { ok: true, parsed, branchPreview });
        return;
      }

      if (method === 'POST' && parsedUrl.pathname === '/api/scrape') {
        const body = await readJsonBody<{
          url: string;
          scopeSelector?: string;
          rolesFilter?: string[];
          maxElements?: number;
          useCache?: boolean;
          checkMobileDifferences?: boolean;
          repoPath?: string;
        }>(req);

        if (!body.url || !body.url.trim()) {
          sendJson(res, 400, { ok: false, error: 'Please provide a valid URL to scrape.' });
          return;
        }

        const cacheDir = path.join(body.repoPath || defaultRepoPath, '.qagentic-cache');
        const extracted = await extractPageStructure(body.url.trim(), {
          scopeSelector: body.scopeSelector?.trim() || undefined,
          rolesFilter: body.rolesFilter,
          maxElements: body.maxElements || 80,
          useCache: body.useCache ?? true,
          cacheDir,
          checkMobileDifferences: Boolean(body.checkMobileDifferences),
        });

        sessionCache.lastPageData = extracted;
        sendJson(res, 200, { ok: true, pageData: extracted });
        return;
      }

      if (method === 'POST' && parsedUrl.pathname === '/api/draft') {
        const body = await readJsonBody<{
          inputs: Partial<DrafterInputs>;
          writeFiles?: boolean;
          useCachedScrape?: boolean;
          runVerify?: boolean;
        }>(req);

        const validation = validateDrafterInputs(body.inputs || {});
        if (!validation.valid || !validation.normalizedInputs) {
          sendJson(res, 200, {
            ok: false,
            stopped: true,
            stopAndAsk: validation.stopAndAsk,
          });
          return;
        }

        const normalized = validation.normalizedInputs;
        const targetRepo = normalized.repoPath || defaultRepoPath;
        const repoContext = await loadRepoContext(
          targetRepo,
          normalized.flow,
          normalized.katalonScriptPath
        );

        let pageData: ExtractedPageData | undefined =
          body.useCachedScrape &&
          sessionCache.lastPageData &&
          sessionCache.lastPageData.url === normalized.url
            ? sessionCache.lastPageData
            : undefined;

        if (!pageData && body.useCachedScrape !== false) {
          try {
            pageData = await extractPageStructure(normalized.url, {
              scopeSelector: normalized.scopeSelector,
              rolesFilter: normalized.rolesFilter,
              maxElements: 80,
              useCache: true,
              cacheDir: path.join(targetRepo, '.qagentic-cache'),
              checkMobileDifferences:
                normalized.platform === 'mobile-local' || normalized.platform === 'both',
            });
            sessionCache.lastPageData = pageData;
          } catch {
            // Proceed with deterministic drafting if offline or URL is unreachable in local preview
          }
        }

        const draftResult = await drafterService.draftTests(
          normalized,
          repoContext,
          pageData,
          Boolean(body.writeFiles)
        );

        if (draftResult.stopped) {
          sendJson(res, 200, {
            ok: false,
            stopped: true,
            stopAndAsk: draftResult.stopAndAsk,
          });
          return;
        }

        const commandRecords = await runDrafterVerification(
          normalized,
          draftResult.specRelativePath,
          targetRepo,
          Boolean(body.runVerify)
        );

        const summary = formatDraftSummary(normalized, draftResult, commandRecords);

        sendJson(res, 200, {
          ok: true,
          stopped: false,
          draftResult,
          commandRecords,
          summary,
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'Route not found' });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: (error as Error).message });
    }
  });
}

export async function startDashboardServer(
  port: number = 4173,
  defaultRepoPath: string = process.cwd()
): Promise<{ server: http.Server; url: string }> {
  const server = createDashboardServer(defaultRepoPath);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const url = `http://localhost:${actualPort}`;
      resolve({ server, url });
    });
  });
}

async function loadHomePageHtml(defaultRepoPath: string): Promise<string> {
  const escapedRepo = defaultRepoPath.replace(/\\/g, '/');
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const docsHtmlPath = path.resolve(moduleDir, '..', '..', 'docs', 'index.html');
    const rawHtml = await fs.readFile(docsHtmlPath, 'utf-8');
    return rawHtml.replace(/__DEFAULT_REPO_PATH__/g, escapedRepo);
  } catch {
    return buildDashboardHtml(defaultRepoPath);
  }
}

function buildDashboardHtml(defaultRepoPath: string): string {
  const escapedRepo = defaultRepoPath.replace(/\\/g, '/');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>qagentic — Playwright Test Drafter & Scaffolder Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --panel-alt: #0b1120;
      --border: #334155;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --success: #22c55e;
      --warn: #f59e0b;
      --danger: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: #0b1120;
    }
    header h1 {
      margin: 0;
      font-size: 1.15rem;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .badge {
      background: rgba(56, 189, 248, 0.15);
      color: var(--accent);
      border: 1px solid rgba(56, 189, 248, 0.4);
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 20px;
      display: grid;
      grid-template-columns: 460px 1fr;
      gap: 20px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .card h2 {
      margin: 0 0 12px 0;
      font-size: 0.95rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--accent);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    label {
      display: block;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--muted);
      margin-bottom: 4px;
      margin-top: 10px;
    }
    input[type="text"], select, textarea {
      width: 100%;
      padding: 8px 10px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 0.85rem;
      font-family: inherit;
    }
    textarea {
      font-family: "JetBrains Mono", Consolas, monospace;
      resize: vertical;
    }
    .row {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .btn-row {
      display: flex;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }
    button {
      padding: 8px 14px;
      border-radius: 6px;
      border: 1px solid transparent;
      font-size: 0.84rem;
      font-weight: 600;
      cursor: pointer;
      background: var(--accent);
      color: #0f172a;
      transition: 0.15s;
    }
    button:hover {
      background: var(--accent-hover);
      color: #fff;
    }
    button.secondary {
      background: transparent;
      border-color: var(--border);
      color: var(--text);
    }
    button.secondary:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    button.success {
      background: var(--success);
      color: #052e16;
    }
    .alert {
      padding: 12px;
      border-radius: 8px;
      margin-bottom: 14px;
      font-size: 0.85rem;
    }
    .alert.stop {
      background: rgba(239, 68, 68, 0.14);
      border: 1px solid var(--danger);
      color: #fecaca;
    }
    .alert.ok {
      background: rgba(34, 197, 94, 0.14);
      border: 1px solid var(--success);
      color: #bbf7d0;
    }
    .element-list {
      max-height: 220px;
      overflow-y: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--panel-alt);
      padding: 8px;
      margin-top: 8px;
    }
    .element-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 5px 4px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.5);
      font-size: 0.78rem;
    }
    .element-item code {
      color: #38bdf8;
      word-break: break-all;
    }
    pre {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
      font-size: 0.8rem;
      margin: 8px 0 0 0;
      max-height: 360px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
      margin-top: 8px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px 10px;
      text-align: left;
    }
    th {
      background: var(--panel-alt);
      color: var(--muted);
    }
    .pill-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 6px;
    }
    .pill {
      font-size: 0.75rem;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <header>
    <h1>
      <span>qagentic</span>
      <span class="badge">Playwright Test Drafter & Scaffolder</span>
    </h1>
    <div style="font-size: 0.82rem; color: var(--muted);">
      Fast URL / Subset Scraper &bull; ISTQB Test Design &bull; Stop-and-Ask Guardrails
    </div>
  </header>

  <div class="container">
    <!-- Left Column: Repo Scaffolder, Fast Subset Scraper, and Drafter Inputs -->
    <div>
      <div class="card">
        <h2>1. Target Project & Scaffolder</h2>
        <label for="repoPath">Target Playwright Repository Path</label>
        <input type="text" id="repoPath" value="${escapedRepo}" />
        <div class="btn-row">
          <button type="button" class="secondary" onclick="inspectRepo()">Inspect Repo</button>
          <button type="button" onclick="scaffoldRepo()">Scaffold Project Structure</button>
        </div>
        <div id="repoStatus" style="margin-top: 10px; font-size: 0.8rem; color: var(--muted);"></div>
      </div>

      <div class="card">
        <h2>2. Fast URL / DOM-Subset Scraper</h2>
        <label for="urlInput">Target URL (Single URL — No Slow Crawling)</label>
        <input type="text" id="urlInput" placeholder="https://example.com/products/shirt" value="https://the-internet.herokuapp.com/login" />

        <div class="row">
          <div>
            <label for="scopePreset">Scrape Scope Subset</label>
            <select id="scopePreset" onchange="onScopePresetChange()">
              <option value="">Full Page (body)</option>
              <option value="main, [role='main']" selected>Main Content Only (&lt;main&gt;)</option>
              <option value="form, [role='form'], [role='dialog']">Forms &amp; Dialogs Only</option>
              <option value="custom">Custom CSS / ARIA Container...</option>
            </select>
          </div>
          <div>
            <label for="customScope">Scope Selector</label>
            <input type="text" id="customScope" value="main, [role='main'], #content" placeholder="e.g. #pdp-main" />
          </div>
        </div>

        <div class="btn-row">
          <button type="button" onclick="runFastScrape()">Quick Scrape URL / Subset</button>
          <button type="button" class="secondary" onclick="toggleAllElements(true)">Select All</button>
          <button type="button" class="secondary" onclick="toggleAllElements(false)">Clear</button>
        </div>
        <div id="scrapeMeta" style="margin-top: 8px; font-size: 0.78rem; color: var(--muted);"></div>
        <div id="elementsContainer" class="element-list" style="display:none;"></div>
      </div>

      <div class="card">
        <h2>3. Drafter Inputs (ISTQB & Guardrails)</h2>
        <label for="briefPaste">Optional: Paste Markdown "## Inputs" Block</label>
        <textarea id="briefPaste" rows="4" placeholder="- URL: https://...\n- Flow (one flow only): Add a 2-option product to cart from PDP\n- Platform: both\n- ENV: staging\n- Expected results: 1. Mini-cart opens 2. Badge count updates\n- Account needed: none\n- Tag: @smoke\n- Ticket ID and title: QAX-1155 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)"></textarea>
        <div class="btn-row">
          <button type="button" class="secondary" onclick="parsePastedBrief()">Parse Markdown Brief</button>
          <button type="button" class="secondary" onclick="loadSamplePdpBrief()">Load Sample QAX-1155 Brief</button>
        </div>

        <label for="flowInput">Flow (one flow only)</label>
        <input type="text" id="flowInput" value="Add a 2-option product to cart from PDP" />

        <div class="row">
          <div>
            <label for="platformInput">Platform</label>
            <select id="platformInput">
              <option value="both" selected>both (web-local &amp; mobile-local)</option>
              <option value="web-local">web-local</option>
              <option value="mobile-local">mobile-local</option>
            </select>
          </div>
          <div>
            <label for="envInput">ENV (Required — No Prod Default)</label>
            <select id="envInput">
              <option value="">-- Select ENV (Stop &amp; Ask if blank) --</option>
              <option value="dev">dev</option>
              <option value="staging" selected>staging</option>
              <option value="prod">prod</option>
            </select>
          </div>
        </div>

        <div class="row">
          <div>
            <label for="accountInput">Account Needed</label>
            <input type="text" id="accountInput" value="none" placeholder="none or SMOKE_WEB_USER" />
          </div>
          <div>
            <label for="tagInput">Tag</label>
            <input type="text" id="tagInput" value="@smoke" placeholder="@smoke | @regression" />
          </div>
        </div>

        <label for="ticketInput">Ticket ID and Title</label>
        <input type="text" id="ticketInput" value="QAX-1155 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)" />

        <label for="expectedInput">Expected Results (One per line, numbered)</label>
        <textarea id="expectedInput" rows="3">1. Confirmation dialog or status banner is visible after clicking Add to Cart
2. Cart badge count updates to match minimum quantity</textarea>

        <div class="btn-row">
          <button type="button" onclick="runDraft(false, false)">Preview Draft</button>
          <button type="button" class="success" onclick="runDraft(true, false)">Write Draft to Repo</button>
          <button type="button" class="secondary" onclick="runDraft(true, true)">Write &amp; Run Verify</button>
        </div>
      </div>
    </div>

    <!-- Right Column: Guardrails, ISTQB Table, Candidate Assertions, Code & MR Summary -->
    <div>
      <div id="alertBox"></div>

      <div class="card">
        <h2>
          <span>ISTQB Test Table &amp; Git Branch</span>
          <span id="branchBadge" class="badge"></span>
        </h2>
        <div id="testTableContainer" style="color: var(--muted); font-size: 0.84rem;">
          Click <strong>Preview Draft</strong> to generate the ISTQB test design table, Page Object diff, Spec file, and Candidate Assertions.
        </div>
      </div>

      <div class="card">
        <h2>Candidate Assertions (Confirm to Promote into Spec)</h2>
        <div style="font-size: 0.8rem; color: var(--muted);">
          Observations from the scraped page that were <em>not</em> in your numbered expected results are held here as candidates. Check any candidate below and re-draft to promote it into the spec.
        </div>
        <div id="candidatesContainer" class="element-list" style="margin-top: 8px;">
          <div style="color: var(--muted); font-size: 0.8rem;">No candidates yet.</div>
        </div>
      </div>

      <div class="card">
        <h2>
          <span>Drafted Spec (<code id="specPathLabel">tests/...</code>)</span>
          <button type="button" class="secondary" onclick="copyText('specCodeBox')">Copy Spec</button>
        </h2>
        <pre id="specCodeBox">// Drafted Playwright spec will appear here...</pre>
      </div>

      <div class="card">
        <h2>
          <span>Page Object (<code id="poPathLabel">page-objects/storefront/...</code>)</span>
          <button type="button" class="secondary" onclick="copyText('poCodeBox')">Copy Page Object</button>
        </h2>
        <pre id="poCodeBox">// Drafted Page Object Model will appear here...</pre>
      </div>

      <div class="card">
        <h2>
          <span>Output Summary &amp; MR Description</span>
          <button type="button" class="secondary" onclick="copyText('summaryBox')">Copy Summary</button>
        </h2>
        <pre id="summaryBox">// Output summary and MR description will appear here...</pre>
      </div>
    </div>
  </div>

  <script>
    let scrapedElements = [];
    let selectedElementIndices = [];
    let confirmedCandidateCodes = new Set();

    function onScopePresetChange() {
      const preset = document.getElementById('scopePreset').value;
      const customInput = document.getElementById('customScope');
      if (preset !== 'custom') {
        customInput.value = preset;
      }
    }

    async function inspectRepo() {
      const repo = document.getElementById('repoPath').value;
      const flow = document.getElementById('flowInput').value;
      const res = await fetch('/api/context?repo=' + encodeURIComponent(repo) + '&flow=' + encodeURIComponent(flow));
      const data = await res.json();
      if (!data.ok) return;
      const ctx = data.context;
      document.getElementById('repoStatus').innerHTML =
        '<div><strong>Storefront Structure:</strong> ' + (ctx.hasTargetStorefrontStructure ? 'Ready' : 'Not initialized yet (click Scaffold Project Structure)') + '</div>' +
        '<div><strong>Page Objects (' + ctx.allPageObjects.length + '):</strong> ' + (ctx.allPageObjects.join(', ') || 'None') + '</div>' +
        '<div><strong>Test Data Exports:</strong> ' + (ctx.testDataExports.join(', ') || 'None') + ' | <strong>SKU Exports:</strong> ' + (ctx.skuExports.join(', ') || 'None') + '</div>';
    }

    async function scaffoldRepo() {
      const repoPath = document.getElementById('repoPath').value;
      const res = await fetch('/api/scaffold', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, overwrite: false })
      });
      const data = await res.json();
      if (data.ok) {
        const created = data.scaffold.createdFiles.length;
        const skipped = data.scaffold.skippedFiles.length;
        document.getElementById('alertBox').innerHTML =
          '<div class="alert ok">Scaffolded Playwright project in <code>' + data.scaffold.targetDir + '</code> (' + created + ' files created, ' + skipped + ' existing files preserved).</div>';
        inspectRepo();
      }
    }

    async function runFastScrape() {
      const url = document.getElementById('urlInput').value;
      const scopeSelector = document.getElementById('customScope').value;
      const repoPath = document.getElementById('repoPath').value;
      document.getElementById('scrapeMeta').textContent = 'Scraping single URL / subset...';
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          scopeSelector,
          repoPath,
          useCache: true,
          checkMobileDifferences: document.getElementById('platformInput').value !== 'web-local'
        })
      });
      const data = await res.json();
      if (!data.ok) {
        document.getElementById('scrapeMeta').textContent = 'Scrape error: ' + data.error;
        return;
      }
      const pd = data.pageData;
      scrapedElements = pd.interactiveElements || [];
      selectedElementIndices = scrapedElements.map(e => e.index);
      document.getElementById('scrapeMeta').innerHTML =
        'Extracted <strong>' + scrapedElements.length + '</strong> elements in <strong>' + pd.durationMs + 'ms</strong> ' +
        (pd.fromCache ? '(from cache)' : '(live)') +
        (pd.scopeSelector ? ' | Scope: <code>' + pd.scopeSelector + '</code>' : '');
      renderElementsList();
    }

    function renderElementsList() {
      const container = document.getElementById('elementsContainer');
      if (scrapedElements.length === 0) {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';
      container.innerHTML = scrapedElements.map(el => {
        const checked = selectedElementIndices.includes(el.index) ? 'checked' : '';
        return '<label class="element-item">' +
          '<input type="checkbox" ' + checked + ' onchange="toggleElementIndex(' + el.index + ', this.checked)" />' +
          '<div><strong>[' + (el.locatorStrategy || el.role) + ']</strong> <code>' + escapeHtml(el.recommendedLocator || '') + '</code></div>' +
          '</label>';
      }).join('');
    }

    function toggleElementIndex(idx, checked) {
      if (checked && !selectedElementIndices.includes(idx)) {
        selectedElementIndices.push(idx);
      } else if (!checked) {
        selectedElementIndices = selectedElementIndices.filter(i => i !== idx);
      }
    }

    function toggleAllElements(selectAll) {
      selectedElementIndices = selectAll ? scrapedElements.map(e => e.index) : [];
      renderElementsList();
    }

    function loadSamplePdpBrief() {
      const sample = [
        '- URL: https://the-internet.herokuapp.com/login',
        '- Flow (one flow only): Add a 2-option product to cart from PDP',
        '- Platform: both',
        '- ENV: staging',
        '- Expected results (numbered, from me):',
        '  1. Confirmation dialog or status banner is visible after clicking Add to Cart',
        '  2. Cart badge count updates to match minimum quantity',
        '- Account needed: none',
        '- Tag: @smoke',
        '- Ticket ID and title: QAX-1155 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)'
      ].join('\\n');
      document.getElementById('briefPaste').value = sample;
      parsePastedBrief();
    }

    async function parsePastedBrief() {
      const markdown = document.getElementById('briefPaste').value;
      const res = await fetch('/api/parse-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markdown })
      });
      const data = await res.json();
      if (!data.ok) return;
      const p = data.parsed;
      if (p.url) document.getElementById('urlInput').value = p.url;
      if (p.flow) document.getElementById('flowInput').value = p.flow;
      if (p.platform) document.getElementById('platformInput').value = p.platform;
      if (p.env !== undefined) document.getElementById('envInput').value = p.env;
      if (p.accountNeeded) document.getElementById('accountInput').value = p.accountNeeded;
      if (p.tag) document.getElementById('tagInput').value = p.tag;
      if (p.ticket) document.getElementById('ticketInput').value = p.ticket;
      if (p.expectedResults && p.expectedResults.length > 0) {
        document.getElementById('expectedInput').value = p.expectedResults.map((r, i) => (i + 1) + '. ' + r).join('\\n');
      }
      if (data.branchPreview) {
        document.getElementById('branchBadge').textContent = data.branchPreview;
      }
    }

    async function runDraft(writeFiles, runVerify) {
      const expectedLines = document.getElementById('expectedInput').value
        .split(/\\r?\\n/)
        .map(l => l.replace(/^\\d+\\.\\s*/, '').trim())
        .filter(Boolean);

      const inputs = {
        url: document.getElementById('urlInput').value,
        flow: document.getElementById('flowInput').value,
        platform: document.getElementById('platformInput').value,
        env: document.getElementById('envInput').value,
        accountNeeded: document.getElementById('accountInput').value,
        tag: document.getElementById('tagInput').value,
        ticket: document.getElementById('ticketInput').value,
        expectedResults: expectedLines,
        repoPath: document.getElementById('repoPath').value,
        scopeSelector: document.getElementById('customScope').value,
        selectedElementIndices: selectedElementIndices.length > 0 ? selectedElementIndices : undefined,
        confirmedCandidateAssertions: Array.from(confirmedCandidateCodes)
      };

      const res = await fetch('/api/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs,
          writeFiles,
          useCachedScrape: true,
          runVerify
        })
      });
      const data = await res.json();

      if (data.stopped) {
        const items = (data.stopAndAsk || []).map(s => '<li><strong>[' + s.code + ']</strong> ' + escapeHtml(s.question) + '</li>').join('');
        document.getElementById('alertBox').innerHTML =
          '<div class="alert stop"><strong>STOP AND ASK — Drafting Halted:</strong><ul style="margin:6px 0 0 0;">' + items + '</ul></div>';
        return;
      }

      document.getElementById('alertBox').innerHTML =
        '<div class="alert ok">' +
        (writeFiles ? 'Draft written to repository: ' + data.draftResult.filesChanged.join(', ') : 'Preview generated (no files written yet — click "Write Draft to Repo" to save).') +
        '</div>';

      document.getElementById('branchBadge').textContent = data.summary.branchName;
      document.getElementById('specPathLabel').textContent = data.draftResult.specRelativePath;
      document.getElementById('poPathLabel').textContent = data.draftResult.pageObjectRelativePath;
      document.getElementById('specCodeBox').textContent = data.draftResult.specCode;
      document.getElementById('poCodeBox').textContent = data.draftResult.pageObjectCode;
      document.getElementById('summaryBox').textContent = data.summary.outputSummaryMarkdown + '\\n---\\n' + data.summary.mrDescriptionMarkdown;

      // Render ISTQB Table
      const rowsHtml = data.draftResult.testTable.map(r =>
        '<tr><td>' + escapeHtml(r.name) + '</td><td>' + escapeHtml(r.technique) + '</td><td>' + r.expectedResultNumbers.join(', ') + '</td><td>' + escapeHtml(r.platform) + '</td></tr>'
      ).join('');
      document.getElementById('testTableContainer').innerHTML =
        '<table><thead><tr><th>Name</th><th>ISTQB Technique</th><th>Expected Result #</th><th>Platform</th></tr></thead><tbody>' + rowsHtml + '</tbody></table>';

      // Render Candidate Assertions with promote checkboxes
      const cands = data.draftResult.candidateAssertions || [];
      if (cands.length === 0) {
        document.getElementById('candidatesContainer').innerHTML = '<div style="color:var(--muted);font-size:0.8rem;">No extra candidate assertions detected.</div>';
      } else {
        document.getElementById('candidatesContainer').innerHTML = cands.map(c => {
          const isChecked = confirmedCandidateCodes.has(c.suggestedAssertionCode) ? 'checked' : '';
          return '<label class="element-item">' +
            '<input type="checkbox" ' + isChecked + ' onchange="toggleCandidate(' + JSON.stringify(c.suggestedAssertionCode).replace(/"/g, '&quot;') + ', this.checked)" />' +
            '<div><strong>' + escapeHtml(c.id) + ':</strong> ' + escapeHtml(c.description) + '<br/><code>' + escapeHtml(c.suggestedAssertionCode) + '</code></div>' +
            '</label>';
        }).join('');
      }
      inspectRepo();
    }

    function toggleCandidate(code, checked) {
      if (checked) confirmedCandidateCodes.add(code);
      else confirmedCandidateCodes.delete(code);
    }

    function copyText(id) {
      const text = document.getElementById(id).textContent;
      navigator.clipboard.writeText(text);
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    inspectRepo();
  </script>
</body>
</html>`;
}

