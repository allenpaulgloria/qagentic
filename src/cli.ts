#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { extractPageStructure } from './crawler/page-extractor.js';
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

    // I am spawning the Playwright test runner directly via the Node runtime to validate runtime behavior without shell escaping warnings.
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

// I am configuring the Commander CLI interface to accept --url and --output arguments.
const program = new Command();

program
  .name('qagentic')
  .description(
    'Standalone CLI and library tool that extracts accessibility trees, synthesizes test cases, and generates validated Playwright POM tests.'
  )
  .version('1.0.0')
  .requiredOption('-u, --url <target_url>', 'Target website URL to analyze and generate tests for')
  .option('-o, --output <output_dir>', 'Output directory for generated Playwright specs', 'tests')
  .option('-r, --retries <count>', 'Maximum closed-loop self-healing retries', '3')
  .option('--no-verify', 'Skip automatic closed-loop Playwright test execution')
  .action(async (options: CliOptions) => {
    try {
      await runGeneratorPipeline(options);
    } catch (error) {
      console.error(`\n[Error] ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
