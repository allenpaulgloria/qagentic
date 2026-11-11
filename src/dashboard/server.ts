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
    return `<!DOCTYPE html><html><body><h1>qagentic (${escapedRepo})</h1></body></html>`;
  }
}
