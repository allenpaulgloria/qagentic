#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { extractPageStructure } from './crawler/page-extractor.js';
import { startDashboardServer } from './dashboard/server.js';
import { DrafterService } from './drafter/drafter.service.js';
import {
  DrafterInputs,
  parseMarkdownBrief,
  TargetPlatform,
  validateDrafterInputs,
} from './drafter/input-validator.js';
import { loadRepoContext } from './drafter/repo-context.js';
import { formatDraftSummary } from './drafter/summary-formatter.js';
import { runDrafterVerification } from './drafter/verifier.js';
import { scaffoldPlaywrightProject } from './scaffolder/project-scaffolder.js';
import { LlmService } from './services/llm.service.js';

// I am loading environment variables from .env so GEMINI_API_KEY is available during CLI invocation.
dotenv.config();

interface CliOptions {
  url: string;
  output: string;
  retries: string;
  verify: boolean;
}

// I am executing Playwright in a child process and capturing stdout and stderr for closed-loop failure diagnostics.
async function runPlaywrightTest(specFilePath: string): Promise<{ passed: boolean; output: string }> {
  return new Promise((resolve) => {
    const normalizedSpecPath = path.relative(process.cwd(), specFilePath).replace(/\\/g, '/');
    const playwrightCli = path.join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
    const args = [playwrightCli, 'test', normalizedSpecPath];

    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
    });

    let combinedOutput = '';

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text);
      combinedOutput += text;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      process.stderr.write(text);
      combinedOutput += text;
    });

    child.on('close', (code) => {
      resolve({
        passed: code === 0,
        output: combinedOutput,
      });
    });

    child.on('error', (err) => {
      resolve({
        passed: false,
        output: `${combinedOutput}\n${err.message}`,
      });
    });
  });
}

// I am orchestrating the full extraction, synthesis, POM code generation, and closed-loop verification workflow.
export async function runGeneratorPipeline(options: CliOptions): Promise<void> {
  const maxRetries = Math.max(1, parseInt(options.retries, 10) || 3);

  console.log(`\n[1/4] Extracting page structure and accessibility tree from: ${options.url}`);
  const pageData = await extractPageStructure(options.url);
  console.log(
    `      Extracted title "${pageData.title}" and ${pageData.interactiveElements.length} interactive accessibility nodes.`
  );

  console.log(`\n[2/4] Synthesizing functional test cases (Happy Path, Negative, Edge Cases)...`);
  const llmService = new LlmService();
  const suite = await llmService.synthesizeScenarios(pageData);
  console.log(`      Synthesized ${suite.scenarios.length} scenarios for ${suite.className}:`);
  for (const scenario of suite.scenarios) {
    console.log(`      - [${scenario.category}] ${scenario.id}: ${scenario.title}`);
  }

  console.log(`\n[3/4] Generating Page Object Model, fixture registration, and Playwright spec...`);
  const artifacts = await llmService.generatePlaywrightArtifacts(pageData, suite, options.output);
  console.log(`      Page Object : ${path.relative(process.cwd(), artifacts.pageObjectPath)}`);
  console.log(`      Fixture     : ${path.relative(process.cwd(), artifacts.fixturePath)}`);
  console.log(`      Spec File   : ${path.relative(process.cwd(), artifacts.specPath)}`);
  if (path.resolve(artifacts.specPath) !== path.resolve(artifacts.rootSpecPath)) {
    console.log(`      Root Spec   : ${path.relative(process.cwd(), artifacts.rootSpecPath)}`);
  }

  if (!options.verify) {
    console.log(`\n[4/4] Verification skipped via --no-verify flag.`);
    return;
  }

  console.log(`\n[4/4] Starting closed-loop Playwright test execution and validation...`);
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n      Attempt ${attempt}/${maxRetries}: Running npx playwright test...`);
    const result = await runPlaywrightTest(artifacts.specPath);

    if (result.passed) {
      console.log(`\nClosed-loop validation succeeded on attempt ${attempt}. All generated tests passed!`);
      return;
    }

    if (attempt < maxRetries) {
      console.warn(
        `\n      Attempt ${attempt} failed. Inspecting failure log and patching Page Object / assertions...`
      );
      await llmService.healFailedTestArtifacts(result.output, pageData, artifacts);
    } else {
      throw new Error(
        `Closed-loop validation failed after ${maxRetries} attempts. Review output above for details.`
      );
    }
  }
}

const program = new Command();

program
  .name('qagentic')
  .description(
    'Playwright Test Drafter, Scaffolder, Fast URL/Subset Scraper, and Interactive Local Dashboard.'
  )
  .version('1.0.0')
  .option('-u, --url <target_url>', 'Target website URL to analyze and generate tests for')
  .option('-o, --output <output_dir>', 'Output directory for generated Playwright specs', 'tests')
  .option('-r, --retries <count>', 'Maximum closed-loop self-healing retries', '3')
  .option('--no-verify', 'Skip automatic closed-loop Playwright test execution')
  .action(async (options: Partial<CliOptions>) => {
    if (!options.url) {
      program.help();
      return;
    }
    try {
      await runGeneratorPipeline({
        url: options.url,
        output: options.output || 'tests',
        retries: options.retries || '3',
        verify: options.verify ?? true,
      });
    } catch (error) {
      console.error(`\n[Error] ${(error as Error).message}`);
      process.exit(1);
    }
  });

// Subcommand: qagentic init (Scaffold Playwright storefront project structure)
program
  .command('init')
  .description('Scaffold a Playwright project with utils/fixtures.ts, page-objects/storefront/, test-data, and rules')
  .option('--repo <path>', 'Target repository directory', process.cwd())
  .option('--overwrite', 'Overwrite existing files', false)
  .option('--with-config', 'Also generate playwright.config.ts with web-local and mobile-local projects', false)
  .action(async (opts: { repo: string; overwrite: boolean; withConfig: boolean }) => {
    const res = await scaffoldPlaywrightProject(opts.repo, {
      overwrite: opts.overwrite,
      includePlaywrightConfig: opts.withConfig,
    });
    console.log(`\nScaffolded Playwright project in: ${res.targetDir}`);
    if (res.createdFiles.length > 0) {
      console.log(`Created (${res.createdFiles.length}):\n  - ${res.createdFiles.join('\n  - ')}`);
    }
    if (res.skippedFiles.length > 0) {
      console.log(`Preserved existing (${res.skippedFiles.length}):\n  - ${res.skippedFiles.join('\n  - ')}`);
    }
  });

// Subcommand: qagentic scrape (Fast single-URL or DOM-subset scraper)
program
  .command('scrape')
  .description('Fast single-URL or DOM-subset scraper that outputs recommended Playwright locators')
  .requiredOption('-u, --url <url>', 'Target URL to scrape')
  .option('-s, --scope <selector>', 'Optional CSS/ARIA container selector to scrape a subset (e.g. "main" or "#pdp")')
  .option('--roles <roles>', 'Comma-separated roles filter (e.g. "button,textbox,combobox")')
  .option('--max <count>', 'Max elements to return', '60')
  .option('--no-cache', 'Bypass local snapshot cache')
  .action(
    async (opts: {
      url: string;
      scope?: string;
      roles?: string;
      max: string;
      cache: boolean;
    }) => {
      const rolesFilter = opts.roles
        ? opts.roles
            .split(',')
            .map((r) => r.trim())
            .filter(Boolean)
        : undefined;

      const data = await extractPageStructure(opts.url, {
        scopeSelector: opts.scope,
        rolesFilter,
        maxElements: parseInt(opts.max, 10) || 60,
        useCache: opts.cache,
        cacheDir: path.join(process.cwd(), '.qagentic-cache'),
      });

      console.log(
        `\nScraped "${data.title}" (${data.url}) in ${data.durationMs}ms ${data.fromCache ? '[CACHE]' : '[LIVE]'}`
      );
      if (data.scopeSelector) {
        console.log(`Subset Scope: ${data.scopeSelector}`);
      }
      console.log(`Interactive Elements (${data.interactiveElements.length}):`);
      for (const el of data.interactiveElements) {
        console.log(`  [${el.index}] (${el.locatorStrategy}) ${el.recommendedLocator}`);
      }
    }
  );

// Subcommand: qagentic draft (Strict ISTQB Playwright Test Drafter)
program
  .command('draft')
  .description('Draft Playwright Page Object and ISTQB Spec from a Markdown brief or CLI inputs')
  .option('-b, --brief <file>', 'Path to Markdown file containing the "## Inputs" section')
  .option('--repo <path>', 'Target Playwright repository path', process.cwd())
  .option('-u, --url <url>', 'Target URL')
  .option('-f, --flow <flow>', 'Single flow description')
  .option('-p, --platform <platform>', 'web-local | mobile-local | both')
  .option('-e, --env <env>', 'dev | staging | prod (Never defaults to prod)')
  .option('--expected <items...>', 'Numbered expected results')
  .option('--account <account>', 'none or existing account env var name')
  .option('--tag <tag>', 'Tag (e.g. @smoke or @regression)')
  .option('--ticket <ticket>', 'Ticket ID and title')
  .option('-s, --scope <selector>', 'DOM subset selector for fast scraping (e.g. "main")')
  .option('--katalon <path>', 'Optional Katalon script path for assertion parity check')
  .option('--skip-scrape', 'Draft without launching browser scrape', false)
  .option('--dry-run', 'Preview output summary without writing files to disk', false)
  .option('--verify', 'Run npm run lint and Playwright web-local / mobile-local verification', false)
  .action(
    async (opts: {
      brief?: string;
      repo: string;
      url?: string;
      flow?: string;
      platform?: string;
      env?: string;
      expected?: string[];
      account?: string;
      tag?: string;
      ticket?: string;
      scope?: string;
      katalon?: string;
      skipScrape: boolean;
      dryRun: boolean;
      verify: boolean;
    }) => {
      let combinedInputs: Partial<DrafterInputs> = {
        repoPath: opts.repo,
        scopeSelector: opts.scope,
        katalonScriptPath: opts.katalon,
      };

      if (opts.brief) {
        const md = await fs.readFile(path.resolve(opts.brief), 'utf-8');
        combinedInputs = {
          ...combinedInputs,
          ...parseMarkdownBrief(md),
        };
      }

      if (opts.url) combinedInputs.url = opts.url;
      if (opts.flow) combinedInputs.flow = opts.flow;
      if (opts.platform) combinedInputs.platform = opts.platform as TargetPlatform;
      if (opts.env) combinedInputs.env = opts.env;
      if (opts.expected && opts.expected.length > 0) combinedInputs.expectedResults = opts.expected;
      if (opts.account) combinedInputs.accountNeeded = opts.account;
      if (opts.tag) combinedInputs.tag = opts.tag;
      if (opts.ticket) combinedInputs.ticket = opts.ticket;

      const validation = validateDrafterInputs(combinedInputs);
      if (!validation.valid || !validation.normalizedInputs) {
        console.error('\n[STOP AND ASK] Cannot proceed with drafting until the following are clarified:\n');
        for (const issue of validation.stopAndAsk) {
          console.error(`  - [${issue.code}] ${issue.question}`);
        }
        process.exit(1);
      }

      const normalized = validation.normalizedInputs;
      const repoContext = await loadRepoContext(opts.repo, normalized.flow, normalized.katalonScriptPath);

      let pageData;
      if (!opts.skipScrape) {
        try {
          pageData = await extractPageStructure(normalized.url, {
            scopeSelector: normalized.scopeSelector,
            useCache: true,
            cacheDir: path.join(opts.repo, '.qagentic-cache'),
            checkMobileDifferences:
              normalized.platform === 'mobile-local' || normalized.platform === 'both',
          });
        } catch (err) {
          console.warn(
            `[Notice] Live URL scrape could not complete (${(err as Error).message}). Proceeding with repo conventions.`
          );
        }
      }

      const drafter = new DrafterService();
      const draftResult = await drafter.draftTests(
        normalized,
        repoContext,
        pageData,
        !opts.dryRun
      );

      if (draftResult.stopped) {
        console.error('\n[STOP AND ASK] Drafting halted:\n');
        for (const issue of draftResult.stopAndAsk) {
          console.error(`  - [${issue.code}] ${issue.question}`);
        }
        process.exit(1);
      }

      const commandRecords = await runDrafterVerification(
        normalized,
        draftResult.specRelativePath,
        opts.repo,
        opts.verify
      );

      const summary = formatDraftSummary(normalized, draftResult, commandRecords);
      console.log(`\n${summary.outputSummaryMarkdown}`);
    }
  );

// Subcommand: qagentic dashboard (Interactive Web UI)
program
  .command('dashboard')
  .description('Launch the local interactive Playwright Test Drafter & Scaffolder Dashboard')
  .option('-p, --port <port>', 'Port to bind the local dashboard server', '4173')
  .option('--repo <path>', 'Default target Playwright repository path', process.cwd())
  .action(async (opts: { port: string; repo: string }) => {
    const portNum = parseInt(opts.port, 10) || 4173;
    const { url } = await startDashboardServer(portNum, opts.repo);
    console.log(`\nqagentic Dashboard running at: ${url}`);
    console.log(`Target Repository: ${path.resolve(opts.repo)}`);
    console.log(`Press Ctrl+C to stop.`);
  });

program.parseAsync(process.argv);
