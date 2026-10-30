# qagentic

Standalone CLI and library tool in TypeScript and Playwright that extracts a target webpage's accessibility tree and interactive elements, synthesizes functional test cases (Happy Path, Negative, Edge Cases) via Gemini 2.5 Flash (`gemini-2.5-flash`), generates production-ready Playwright Page Object Model (POM) tests, and validates the generated tests in a closed-loop terminal execution.

## Architecture & Coding Standards

- **Semantic Locators Exclusively**: Uses `page.getByRole`, `page.getByLabel`, and `page.getByPlaceholder` exclusively—never brittle XPath or dynamic CSS selectors.
- **Page Object Model + Fixture Injection**: Page Objects are generated under `src/pages/<page-name>.page.ts` and injected into specs via `src/fixtures/page.fixture.ts` (`test.extend`).
- **Web-First Assertions**: Relies strictly on web-first assertions (`expect(locator).toBeVisible()`, `expect(locator).toContainText()`) and auto-waiting with zero hardcoded timeouts.
- **Closed-Loop Self-Healing**: Automatically executes `npx playwright test` against generated specs and patches locator or assertion mismatches if a failure occurs.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and configure your Gemini API key:
   ```bash
   GEMINI_API_KEY=your_api_key_here
   ```

## CLI Usage

Generate and validate Playwright POM tests for a target URL:

```bash
npm run generate -- --url https://the-internet.herokuapp.com/login --output tests/generated
```

Or run the generated tests directly:

```bash
npx playwright test tests/login.spec.ts
```
