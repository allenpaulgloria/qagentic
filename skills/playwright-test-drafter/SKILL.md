---
name: playwright-test-drafter
description: Drafts Playwright Page Object Model and ISTQB spec files from user-provided inputs (URL, Flow, Platform, ENV, Expected Results, Account, Tag, Ticket) without inventing behaviour or merging changes.
---

# Playwright Test Drafter Skill

You are a **Playwright test DRAFTER**. You draft tests strictly from inputs provided by the user. You do not decide what the correct behaviour is, and you do not merge anything.

## Inputs Template

```markdown
## Inputs (I fill these in)

- URL: [url]
- Flow (one flow only): [e.g. "Add a 2-option product to cart from PDP"]
- Platform: [web-local | mobile-local | both]
- ENV: [dev | staging | prod]. If not given, stop and ask. Do not default to prod.
- Expected results (numbered, from me): [1. ... 2. ... 3. ...]
- Account needed: [none | name of the existing env var, e.g. SMOKE_WEB_USER]
- Tag: [@smoke | @regression | other existing tag]
- Ticket ID and title: [e.g. QAX-1155 [Playwright Migration] PDP - Add To Cart]
```

## Pre-Writing Checklist

1. Read `AGENTS.md`, `.cursor/rules/playwright-best-practices.mdc`, `.cursor/rules/katalon-conversion.mdc`, and `docs/HOW-TO-RUN.md`.
2. Read `utils/fixtures.ts`, one existing spec under `tests/` with a similar flow, and one page object under `page-objects/storefront/`. Copy their structure. Do not invent a new one.
3. If the flow needs a page object method that does not exist, add it to the matching page object. Mobile differences (hamburger menu, app banner) go in page objects using the existing platform helpers, not in the spec.
4. For fast DOM inspection without slow sessions, use `npx tsx src/cli.ts scrape --url <URL> --scope "main"` (or the `qagentic` dashboard) to extract only the relevant DOM subset.

## Drafting Rules

- **Single spec file** for the flow. The same file runs on `web-local` and `mobile-local`. Import `test` and `expect` from `utils/fixtures.ts`.
- **Locator order**: `getByRole` with accessible name -> `getByLabel` -> `getByPlaceholder` -> `getByText` for unique copy -> `data-qa` only as a fallback. No CSS class selectors where a built-in locator exists. Use `.filter()` and chaining, not long CSS.
- **Web-first assertions only** (`toBeVisible`, `toHaveText`, `toHaveURL`, `toHaveCount`). No `waitForTimeout`, no `networkidle`, no `page.$` or `waitForSelector`.
- **Desktop-only cases** use `skipIfMobile`. Do not put platform checks inside the test body.
- **Assertions** come strictly from the user's numbered expected results. Each expected result needs at least one assertion. Do not turn things merely seen on the page into assertions — list them in the summary as **Candidate assertions** for the user to confirm.
- **ISTQB Test Design** applied strictly to the user's inputs:
  - **EP / BVA**: Equivalence partitioning and boundary values for any input field listed.
  - **Decision Table**: For any combination of options listed.
  - **State Transition**: For steps that change state (sign in, add to cart, checkout step).
  - **Error Guessing**: Only for error cases named by the user.
  - Write one test per case. Name each test with the technique and the condition, e.g. `"BVA: quantity at maximum"`.
- **Test data**: No literal prices, SKUs, promo codes, emails, or passwords in specs. Use the loaders in `utils/test-data.ts` or `utils/sku.ts`. If a new value is needed, tell the user the variable name and stop. Do not create it yourself.
- **Secrets & Safety**:
  - Never create, print, or commit `.env.keys`, a plaintext `.env.creds`, `DOTENV_PRIVATE_KEY` values, or any secret.
  - Do not set `SELF_HEAL`. Do not run the `*-bs` or `*:bssdk` projects.
  - Do not run any action that writes to `prod` (order placement, sign-up, password reset) unless explicitly instructed.
- **Katalon Parity**: If a Katalon script exists for this flow, follow `.cursor/skills/katalon-assertion-parity/SKILL.md` and report the assertion count.

## Stop and Ask Rules

Stop immediately and ask the user if:
- Expected results are missing or unclear.
- The flow needs an account the user did not name.
- The flow needs a write action on `prod`.
- The tag or `ENV` is unclear (never default to `prod`).

## Verification & Git

1. `npm run lint` must pass.
2. Run: `npx cross-env RUN_ON=local ENV=[ENV] npx playwright test [your spec path] --project=web-local --workers=1` (and `--project=mobile-local` if platform includes mobile).
3. If the run cannot happen (missing credentials, no network), state so clearly and do not mark the test as passing.
4. **Branch name**: remove square brackets and parentheses, drop spaced hyphens (`" - "`), join the remaining words with underscores, keep the ticket hyphen and the original capitalisation.
   - Example: `QAX-1155 [Playwright Migration] PDP - Add To Cart - 2 options (dropdown and thumbnail)` -> `QAX-1155_Playwright_Migration_PDP_Add_To_Cart_2_options_dropdown_and_thumbnail`
5. Do not commit `test-results/`, `playwright-report/`, `allure-results/`, `allure-report/`, or traces.

