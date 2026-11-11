// I am defining the structured input contract and pre-flight validation rules for the Playwright Test Drafter.

export type TargetPlatform = 'web-local' | 'mobile-local' | 'both';
export type TargetEnvironment = 'dev' | 'staging' | 'prod';

export interface IstqbInputSpec {
  inputFields?: Array<{
    name: string;
    validPartition?: string;
    invalidPartition?: string;
    minBoundary?: string | number;
    maxBoundary?: string | number;
  }>;
  decisionTableOptions?: Array<{
    conditionName: string;
    combinations: string[];
    expectedResultNumber?: number;
  }>;
  stateTransitions?: Array<{
    action: string;
    fromState: string;
    toState: string;
    expectedResultNumber?: number;
  }>;
  errorGuessingCases?: string[];
}

export interface DrafterInputs {
  url: string;
  flow: string;
  platform: TargetPlatform;
  env?: TargetEnvironment | string;
  expectedResults: string[];
  accountNeeded: string;
  tag: string;
  ticket: string;
  repoPath?: string;
  scopeSelector?: string;
  rolesFilter?: string[];
  selectedElementIndices?: number[];
  confirmedCandidateAssertions?: string[];
  istqbInputs?: IstqbInputSpec;
  katalonScriptPath?: string;
  allowProdWrite?: boolean;
}

export interface StopAndAskIssue {
  code:
    | 'MISSING_ENV'
    | 'MISSING_EXPECTED_RESULTS'
    | 'MISSING_FLOW_OR_URL'
    | 'MISSING_ACCOUNT'
    | 'PROD_WRITE_BLOCKED'
    | 'UNCLEAR_TAG_OR_PLATFORM'
    | 'MISSING_TEST_DATA_VARIABLE'
    | 'FORBIDDEN_SECRET_OR_FLAG';
  question: string;
  field: string;
}

export interface ValidationResult {
  valid: boolean;
  stopAndAsk: StopAndAskIssue[];
  normalizedInputs?: DrafterInputs;
}

// I am converting a Ticket ID and title into the exact required Git branch name format:
// remove square brackets and parentheses, drop spaced hyphens (" - "), join remaining words with underscores, and keep ticket hyphen + original capitalisation.
export function formatBranchName(ticketAndTitle: string): string {
  const withoutBracketsAndParens = ticketAndTitle.replace(/[\[\]()]/g, '');
  const withoutSpacedHyphens = withoutBracketsAndParens.replace(/\s+-\s+/g, ' ');
  const words = withoutSpacedHyphens
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.join('_');
}

// I am parsing the "## Inputs" markdown block into structured DrafterInputs so users can paste or pass a brief directly.
export function parseMarkdownBrief(markdown: string): Partial<DrafterInputs> {
  const result: Partial<DrafterInputs> = {
    expectedResults: [],
  };

  const extractSingleLine = (labelPattern: RegExp): string => {
    const match = markdown.match(labelPattern);
    if (!match || !match[1]) return '';
    const raw = match[1].trim();
    if (/^\[.*\]$/.test(raw) && raw.toLowerCase().includes('e.g.')) {
      return '';
    }
    return raw.replace(/^\[(.*)\]$/, '$1').trim();
  };

  result.url = extractSingleLine(/-\s*URL\s*:\s*(.+)/i);
  result.flow = extractSingleLine(/-\s*Flow(?:\s*\([^)]*\))?\s*:\s*(.+)/i);

  const rawPlatform = extractSingleLine(/-\s*Platform\s*:\s*(.+)/i).toLowerCase();
  if (rawPlatform === 'web-local' || rawPlatform === 'mobile-local' || rawPlatform === 'both') {
    result.platform = rawPlatform;
  } else if (rawPlatform) {
    result.platform = rawPlatform as TargetPlatform;
  }

  const rawEnv = extractSingleLine(/-\s*ENV\s*:\s*(.+)/i).split('.')[0].trim().toLowerCase();
  if (rawEnv && !rawEnv.includes('|')) {
    result.env = rawEnv;
  }

  result.accountNeeded = extractSingleLine(/-\s*Account needed\s*:\s*(.+)/i);
  result.tag = extractSingleLine(/-\s*Tag\s*:\s*(.+)/i);

  // For ticket ID and title, keep brackets inside the ticket title if provided (e.g. PROJ-101 [Playwright Migration] PDP - Add To Cart)
  const ticketMatch = markdown.match(/-\s*Ticket ID and title\s*:\s*(.+)/i);
  if (ticketMatch && ticketMatch[1]) {
    const rawTicket = ticketMatch[1].trim();
    if (!/^\[e\.g\./i.test(rawTicket)) {
      result.ticket = rawTicket;
    }
  }

  // Extract numbered expected results either inline or across subsequent numbered lines
  const expectedMatch = markdown.match(
    /-\s*Expected results(?:\s*\([^)]*\))?\s*:\s*([\s\S]*?)(?=\n-\s*(?:Account needed|Tag|Ticket ID)|$)/i
  );
  if (expectedMatch && expectedMatch[1]) {
    const rawBlock = expectedMatch[1].trim();
    if (!rawBlock.includes('1. ...')) {
      const cleaned = rawBlock.replace(/^\[|\]$/g, '').trim();
      const splitItems = cleaned
        .split(/(?:^|\s+|\n)\d+\.\s+/)
        .map((item) => item.trim())
        .filter(Boolean);
      result.expectedResults = splitItems;
    }
  }

  return result;
}

// I am validating all drafter inputs against the strict "Stop and ask me if" rules before any code is drafted.
export function validateDrafterInputs(inputs: Partial<DrafterInputs>): ValidationResult {
  const stopAndAsk: StopAndAskIssue[] = [];

  // Guard against forbidden secret files or SELF_HEAL / BrowserStack flags in raw input strings
  const serialized = JSON.stringify(inputs);
  if (
    serialized.includes('.env.keys') ||
    serialized.includes('.env.creds') ||
    serialized.includes('DOTENV_PRIVATE_KEY') ||
    serialized.includes('SELF_HEAL') ||
    /-(bs)\b|:bssdk\b/i.test(serialized)
  ) {
    stopAndAsk.push({
      code: 'FORBIDDEN_SECRET_OR_FLAG',
      field: 'security',
      question:
        'Inputs reference a forbidden secret file (.env.keys, .env.creds, DOTENV_PRIVATE_KEY) or disallowed flag/project (SELF_HEAL, *-bs, *:bssdk). Please remove it.',
    });
  }

  const url = (inputs.url || '').trim();
  const flow = (inputs.flow || '').trim();
  if (!url || !flow || url === '[url]' || flow.startsWith('[e.g.')) {
    stopAndAsk.push({
      code: 'MISSING_FLOW_OR_URL',
      field: 'url/flow',
      question: 'URL or Flow is missing. Please provide the target URL and the single flow to draft.',
    });
  }

  const rawEnv = (inputs.env || '').toString().trim().toLowerCase();
  if (!rawEnv || !['dev', 'staging', 'prod'].includes(rawEnv)) {
    stopAndAsk.push({
      code: 'MISSING_ENV',
      field: 'env',
      question: 'ENV is missing or unclear. Please specify ENV (dev | staging | prod). I will not default to prod.',
    });
  }

  const rawPlatform = (inputs.platform || '').toString().trim().toLowerCase();
  if (!rawPlatform || !['web-local', 'mobile-local', 'both'].includes(rawPlatform)) {
    stopAndAsk.push({
      code: 'UNCLEAR_TAG_OR_PLATFORM',
      field: 'platform',
      question: 'Platform is missing or unclear. Please specify web-local, mobile-local, or both.',
    });
  }

  const rawTag = (inputs.tag || '').trim();
  if (!rawTag || rawTag.includes('|') || !rawTag.startsWith('@')) {
    stopAndAsk.push({
      code: 'UNCLEAR_TAG_OR_PLATFORM',
      field: 'tag',
      question: 'Tag is missing or unclear. Please specify an existing tag such as @smoke or @regression.',
    });
  }

  const expectedResults = (inputs.expectedResults || [])
    .map((item) => item.replace(/^\d+\.\s*/, '').trim())
    .filter((item) => Boolean(item) && item !== '...');

  if (expectedResults.length === 0) {
    stopAndAsk.push({
      code: 'MISSING_EXPECTED_RESULTS',
      field: 'expectedResults',
      question:
        'Expected results are missing or unclear. Please provide your numbered expected results (1. ... 2. ...) so each can be mapped to assertions.',
    });
  }

  const accountNeeded = (inputs.accountNeeded || '').trim();
  const flowAndExpectedText = `${flow} ${expectedResults.join(' ')}`.toLowerCase();
  const mentionsAuthFlow =
    /\b(sign\s*-?\s*in|log\s*-?\s*in|logged\s+in|my\s+account|order\s+history|saved\s+address|wishlist)\b/i.test(
      flowAndExpectedText
    );

  if (
    (!accountNeeded || accountNeeded.includes('|')) ||
    (mentionsAuthFlow && (!accountNeeded || accountNeeded.toLowerCase() === 'none'))
  ) {
    stopAndAsk.push({
      code: 'MISSING_ACCOUNT',
      field: 'accountNeeded',
      question: mentionsAuthFlow
        ? 'This flow appears to require an authenticated account, but no account env var was named. Which existing account env var (e.g. SMOKE_WEB_USER) should be used?'
        : 'Account needed is unclear. Please specify "none" or the name of the existing env var (e.g. SMOKE_WEB_USER).',
    });
  }

  const isProdWrite =
    rawEnv === 'prod' &&
    /\b(place\s+order|order\s+placement|submit\s+order|complete\s+purchase|sign\s*-?\s*up|register\s+account|create\s+account|password\s+reset|reset\s+password)\b/i.test(
      flowAndExpectedText
    );

  if (isProdWrite && !inputs.allowProdWrite) {
    stopAndAsk.push({
      code: 'PROD_WRITE_BLOCKED',
      field: 'env',
      question:
        'This flow includes a write action (order placement, sign-up, or password reset) on ENV=prod. Do you explicitly authorize running/drafting this write action against prod, or should we switch to dev/staging?',
    });
  }

  if (stopAndAsk.length > 0) {
    return {
      valid: false,
      stopAndAsk,
    };
  }

  return {
    valid: true,
    stopAndAsk: [],
    normalizedInputs: {
      url,
      flow,
      platform: rawPlatform as TargetPlatform,
      env: rawEnv as TargetEnvironment,
      expectedResults,
      accountNeeded: accountNeeded || 'none',
      tag: rawTag,
      ticket: (inputs.ticket || 'PROJ-101 Playwright Draft').trim(),
      repoPath: inputs.repoPath,
      scopeSelector: inputs.scopeSelector,
      rolesFilter: inputs.rolesFilter,
      selectedElementIndices: inputs.selectedElementIndices,
      confirmedCandidateAssertions: inputs.confirmedCandidateAssertions,
      istqbInputs: inputs.istqbInputs,
      katalonScriptPath: inputs.katalonScriptPath,
      allowProdWrite: inputs.allowProdWrite,
    },
  };
}

