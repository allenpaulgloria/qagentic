// I am re-exporting the core page extractor, LLM synthesizer/generator service, and test fixture harness so this package functions as both a library and a standalone CLI.
export {
  extractPageStructure,
  type ExtractedPageData,
  type InteractiveElementInfo,
} from './crawler/page-extractor.js';

export {
  LlmService,
  type TestScenario,
  type SynthesizedTestSuite,
  type GeneratedFilesResult,
} from './services/llm.service.js';

export { test, expect, type PageFixtures } from './fixtures/page.fixture.js';
