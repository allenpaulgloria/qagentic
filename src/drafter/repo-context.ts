import fs from 'node:fs/promises';
import path from 'node:path';

// I am representing the discovered conventions, exemplars, and test-data loader exports from the target Playwright repository.
export interface RepoContext {
  repoRoot: string;
  hasTargetStorefrontStructure: boolean;
  rulesAndDocs: {
    agentsMd?: string;
    playwrightBestPracticesMdc?: string;
    katalonConversionMdc?: string;
    howToRunMd?: string;
    katalonAssertionParitySkillMd?: string;
  };
  fixturesFile: {
    relativePath: string;
    content?: string;
    exportedFixtures: string[];
    hasSkipIfMobile: boolean;
  };
  exemplarSpec?: {
    relativePath: string;
    content: string;
  };
  exemplarPageObject?: {
    relativePath: string;
    content: string;
    className?: string;
  };
  allPageObjects: string[];
  allSpecs: string[];
  testDataExports: string[];
  skuExports: string[];
  katalonParity?: {
    scriptPath: string;
    katalonAssertionCount: number;
    katalonAssertionLines: string[];
  };
}

async function readTextIfExists(filePath: string): Promise<string | undefined> {
  // I am explicitly refusing to read any forbidden secret files (.env.keys, .env.creds).
  const base = path.basename(filePath);
  if (base === '.env.keys' || base === '.env.creds') {
    return undefined;
  }
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

async function listFilesRecursive(dirPath: string, extFilter: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        const nested = await listFilesRecursive(fullPath, extFilter);
        results.push(...nested);
      } else if (entry.isFile() && entry.name.endsWith(extFilter)) {
        results.push(fullPath);
      }
    }
  } catch {
    // Directory does not exist
  }
  return results;
}

// I am extracting exported identifiers and object keys from utils/test-data.ts and utils/sku.ts without evaluating secret runtime values.
export function extractExportedIdentifiers(sourceCode?: string): string[] {
  if (!sourceCode) return [];
  const identifiers = new Set<string>();

  const exportRegex = /export\s+(?:const|let|var|function|class|enum|type|interface)\s+([A-Za-z0-9_]+)/g;
  let match: RegExpExecArray | null;
  while ((match = exportRegex.exec(sourceCode)) !== null) {
    identifiers.add(match[1]);
  }

  const keyRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm;
  while ((match = keyRegex.exec(sourceCode)) !== null) {
    identifiers.add(match[1]);
  }

  return Array.from(identifiers);
}

// I am counting Katalon verification and assertion calls per .cursor/skills/katalon-assertion-parity/SKILL.md.
export function countKatalonAssertions(katalonSource: string): {
  count: number;
  lines: string[];
} {
  const lines = katalonSource
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        !line.startsWith('//') &&
        !line.startsWith('*') &&
        /\b(?:WebUI\.verify[A-Za-z0-9_]+|WS\.verify[A-Za-z0-9_]+|assert\s+|Assert\.assert[A-Za-z0-9_]+)\b/.test(line)
    );

  return {
    count: lines.length,
    lines,
  };
}

// I am scoring file similarity against the requested flow description so the drafter selects the most relevant existing spec and Page Object.
function scoreSimilarity(filePath: string, flowText: string): number {
  const normalizedPath = filePath.toLowerCase();
  const tokens = flowText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  let score = 0;
  for (const token of tokens) {
    if (normalizedPath.includes(token)) {
      score += 2;
    }
  }
  return score;
}

// I am loading the required target repository files (AGENTS.md, .cursor/rules/*, docs/HOW-TO-RUN.md, utils/fixtures.ts, page-objects/storefront/*, and tests/*).
export async function loadRepoContext(
  repoRoot: string = process.cwd(),
  flowHint: string = '',
  katalonScriptPath?: string
): Promise<RepoContext> {
  const resolvedRoot = path.resolve(repoRoot);

  const agentsMd = await readTextIfExists(path.join(resolvedRoot, 'AGENTS.md'));
  const playwrightBestPracticesMdc = await readTextIfExists(
    path.join(resolvedRoot, '.cursor', 'rules', 'playwright-best-practices.mdc')
  );
  const katalonConversionMdc = await readTextIfExists(
    path.join(resolvedRoot, '.cursor', 'rules', 'katalon-conversion.mdc')
  );
  const howToRunMd = await readTextIfExists(path.join(resolvedRoot, 'docs', 'HOW-TO-RUN.md'));
  const katalonAssertionParitySkillMd = await readTextIfExists(
    path.join(resolvedRoot, '.cursor', 'skills', 'katalon-assertion-parity', 'SKILL.md')
  );

  // Check utils/fixtures.ts first (target repo convention), fallback to src/fixtures/page.fixture.ts
  let fixturesRelativePath = 'utils/fixtures.ts';
  let fixturesContent = await readTextIfExists(path.join(resolvedRoot, 'utils', 'fixtures.ts'));
  if (!fixturesContent) {
    const fallbackContent = await readTextIfExists(
      path.join(resolvedRoot, 'src', 'fixtures', 'page.fixture.ts')
    );
    if (fallbackContent) {
      fixturesRelativePath = 'src/fixtures/page.fixture.ts';
      fixturesContent = fallbackContent;
    }
  }

  const exportedFixtures: string[] = [];
  if (fixturesContent) {
    const propRegex = /^\s*([a-zA-Z0-9_]+)\s*:\s*async\s*\(/gm;
    let m: RegExpExecArray | null;
    while ((m = propRegex.exec(fixturesContent)) !== null) {
      exportedFixtures.push(m[1]);
    }
  }
  const hasSkipIfMobile = Boolean(fixturesContent && fixturesContent.includes('skipIfMobile'));

  // Discover Page Objects under page-objects/storefront/ (or fallback to src/pages/)
  const storefrontPoDir = path.join(resolvedRoot, 'page-objects', 'storefront');
  let poFiles = await listFilesRecursive(storefrontPoDir, '.ts');
  const hasTargetStorefrontStructure =
    Boolean(await readTextIfExists(path.join(resolvedRoot, 'utils', 'fixtures.ts'))) || poFiles.length > 0;

  if (poFiles.length === 0) {
    poFiles = await listFilesRecursive(path.join(resolvedRoot, 'src', 'pages'), '.ts');
  }

  const allPageObjects = poFiles.map((f) => path.relative(resolvedRoot, f).replace(/\\/g, '/'));

  let exemplarPageObject: RepoContext['exemplarPageObject'];
  if (poFiles.length > 0) {
    const sortedPo = [...poFiles].sort(
      (a, b) => scoreSimilarity(b, flowHint) - scoreSimilarity(a, flowHint)
    );
    const chosenPo = sortedPo[0];
    const content = (await readTextIfExists(chosenPo)) || '';
    const classMatch = content.match(/export\s+class\s+([A-Za-z0-9_]+)/);
    exemplarPageObject = {
      relativePath: path.relative(resolvedRoot, chosenPo).replace(/\\/g, '/'),
      content,
      className: classMatch ? classMatch[1] : undefined,
    };
  }

  // Discover existing specs under tests/
  const testFiles = (await listFilesRecursive(path.join(resolvedRoot, 'tests'), '.spec.ts')).filter(
    (f) => !f.includes('mock-storefront')
  );
  const allSpecs = testFiles.map((f) => path.relative(resolvedRoot, f).replace(/\\/g, '/'));

  let exemplarSpec: RepoContext['exemplarSpec'];
  if (testFiles.length > 0) {
    const sortedSpecs = [...testFiles].sort(
      (a, b) => scoreSimilarity(b, flowHint) - scoreSimilarity(a, flowHint)
    );
    const chosenSpec = sortedSpecs[0];
    const content = (await readTextIfExists(chosenSpec)) || '';
    exemplarSpec = {
      relativePath: path.relative(resolvedRoot, chosenSpec).replace(/\\/g, '/'),
      content,
    };
  }

  // Read test data and SKU loader exports
  const testDataSource = await readTextIfExists(path.join(resolvedRoot, 'utils', 'test-data.ts'));
  const skuSource = await readTextIfExists(path.join(resolvedRoot, 'utils', 'sku.ts'));
  const testDataExports = extractExportedIdentifiers(testDataSource);
  const skuExports = extractExportedIdentifiers(skuSource);

  // Check optional Katalon script for assertion parity
  let katalonParity: RepoContext['katalonParity'];
  if (katalonScriptPath) {
    const resolvedKatalon = path.isAbsolute(katalonScriptPath)
      ? katalonScriptPath
      : path.join(resolvedRoot, katalonScriptPath);
    const katalonContent = await readTextIfExists(resolvedKatalon);
    if (katalonContent) {
      const counted = countKatalonAssertions(katalonContent);
      katalonParity = {
        scriptPath: path.relative(resolvedRoot, resolvedKatalon).replace(/\\/g, '/'),
        katalonAssertionCount: counted.count,
        katalonAssertionLines: counted.lines,
      };
    }
  }

  return {
    repoRoot: resolvedRoot,
    hasTargetStorefrontStructure,
    rulesAndDocs: {
      agentsMd,
      playwrightBestPracticesMdc,
      katalonConversionMdc,
      howToRunMd,
      katalonAssertionParitySkillMd,
    },
    fixturesFile: {
      relativePath: fixturesRelativePath,
      content: fixturesContent,
      exportedFixtures,
      hasSkipIfMobile,
    },
    exemplarSpec,
    exemplarPageObject,
    allPageObjects,
    allSpecs,
    testDataExports,
    skuExports,
    katalonParity,
  };
}

