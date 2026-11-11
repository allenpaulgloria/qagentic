// I am re-exporting the core page extractor, LLM synthesizer, Playwright Test Drafter, Project Scaffolder, and Dashboard server so qagentic functions as both a library and a CLI.
export {
  extractPageStructure,
  buildRecommendedLocator,
  type ExtractedPageData,
  type ExtractPageOptions,
  type InteractiveElementInfo,
} from './crawler/page-extractor.js';

export {
  LlmService,
  type TestScenario,
  type SynthesizedTestSuite,
  type GeneratedFilesResult,
} from './services/llm.service.js';

export {
  DrafterService,
  deriveIstqbTestPlan,
  detectMissingTestDataVariables,
  validateDraftedCodeCompliance,
  buildCandidateAssertions,
  type IstqbTestCaseRow,
  type CandidateAssertion,
  type DraftedArtifactsResult,
} from './drafter/drafter.service.js';

export {
  validateDrafterInputs,
  parseMarkdownBrief,
  formatBranchName,
  type DrafterInputs,
  type StopAndAskIssue,
  type ValidationResult,
  type TargetPlatform,
  type TargetEnvironment,
} from './drafter/input-validator.js';

export {
  loadRepoContext,
  extractExportedIdentifiers,
  countKatalonAssertions,
  type RepoContext,
} from './drafter/repo-context.js';

export {
  runDrafterVerification,
  type CommandExecutionRecord,
} from './drafter/verifier.js';

export {
  formatDraftSummary,
  type FormattedDraftSummary,
} from './drafter/summary-formatter.js';

export {
  scaffoldPlaywrightProject,
  type ScaffoldOptions,
  type ScaffoldResult,
} from './scaffolder/project-scaffolder.js';

export {
  createDashboardServer,
  startDashboardServer,
} from './dashboard/server.js';

export { test, expect, type PageFixtures } from './fixtures/page.fixture.js';
