# qagentic

Playwright Test Drafter, Project Scaffolder, Fast URL / DOM-Subset Scraper, and Interactive Local Dashboard.

## Core Capabilities

1. **Interactive Local Dashboard (`npm run dashboard`)**:
   - Scaffold a new Playwright storefront project or inspect an existing repo (`utils/fixtures.ts`, `utils/test-data.ts`, `utils/sku.ts`, `page-objects/storefront/`).
   - Run **fast single-URL or DOM-subset scrapes** (`<main>`, forms/dialogs, or custom selectors) in ~1–3 seconds and select the exact subset of elements for your Page Object.
   - Fill or paste your `## Inputs` brief, enforce **Stop-and-Ask** guardrails, preview ISTQB test tables (`EP`, `BVA`, `Decision Table`, `State Transition`, `Error Guessing`), confirm **Candidate Assertions**, and copy the formatted Git branch & MR summary.
2. **Project Scaffolder (`npm run scaffold`)**:
   - Hit the ground running on new Playwright automation projects by generating `AGENTS.md`, `.cursor/rules/*`, `docs/HOW-TO-RUN.md`, `utils/fixtures.ts` (`skipIfMobile`), `utils/test-data.ts`, `utils/sku.ts`, and `page-objects/storefront/`.
3. **Fast URL & Subset Scraper (`npm run scrape`)**:
   - Scrapes a single URL or a targeted DOM subset (`--scope "main"`, `--roles "button,textbox,combobox"`) with local snapshot caching so sessions never stall.
4. **Strict ISTQB Test Drafter (`npm run draft`)**:
   - Follows strict locator ordering (`getByRole` -> `getByLabel` -> `getByPlaceholder` -> `getByText` -> `data-qa` fallback), web-first assertions only, zero literal prices/SKUs/emails/passwords in specs, and Katalon assertion parity reporting.
5. **Reusable Agent Skill (`skills/playwright-test-drafter/SKILL.md`)**:
   - Drop-in skill instructions for AI coding agents.

## Quick Start

### 1. Launch the Dashboard

```bash
npm run dashboard
```

Opens at `http://localhost:4173`.

### 2. Scaffold a Playwright Project Structure

```bash
npm run scaffold -- --repo ./my-playwright-repo --with-config
```

### 3. Scrape a Single URL or DOM Subset Fast

```bash
npm run scrape -- --url https://the-internet.herokuapp.com/login --scope "#content" --roles "button,textbox,heading"
```

### 4. Draft Tests from a Brief File

```bash
npm run draft -- --brief examples/sample-pdp-brief.md --skip-scrape --dry-run
```

### 5. Run Linting & Tests

```bash
npm run lint
npm test
```
