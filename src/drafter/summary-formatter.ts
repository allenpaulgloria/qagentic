import { DraftedArtifactsResult } from './drafter.service.js';
import { DrafterInputs, formatBranchName } from './input-validator.js';
import { CommandExecutionRecord } from './verifier.js';

export interface FormattedDraftSummary {
  branchName: string;
  commitMessage: string;
  mrDescriptionMarkdown: string;
  outputSummaryMarkdown: string;
}

// I am generating the branch name, conventional commit message, MR description, and Output Summary markdown matching the exact drafter specification.
export function formatDraftSummary(
  inputs: DrafterInputs,
  draftResult: DraftedArtifactsResult,
  commandRecords: CommandExecutionRecord[],
  mrLink: string = 'Pending branch push (do not push to main; do not merge)'
): FormattedDraftSummary {
  const branchName = formatBranchName(inputs.ticket);
  const ticketIdMatch = inputs.ticket.match(/^([A-Z]+-\d+)/);
  const ticketId = ticketIdMatch ? ticketIdMatch[1] : inputs.ticket.split(/\s+/)[0];
  const commitMessage = `test(${ticketId}): draft Playwright spec for ${inputs.flow}`;

  const testTableMarkdown = [
    '| Name | ISTQB technique | Expected result number | Platform |',
    '| :--- | :--- | :--- | :--- |',
    ...draftResult.testTable.map(
      (row) =>
        `| ${row.name} | ${row.technique} | ${row.expectedResultNumbers.join(', ')} | ${row.platform} |`
    ),
  ].join('\n');

  const filesChangedLines =
    draftResult.filesChanged.length > 0
      ? draftResult.filesChanged.map((f) => `- \`${f}\``).join('\n')
      : `- \`${draftResult.pageObjectRelativePath}\` (preview)\n- \`${draftResult.specRelativePath}\` (preview)`;

  const expectedCoveredLines = inputs.expectedResults
    .map((er, idx) => `${idx + 1}. ${er}`)
    .join('\n');

  const candidateLines =
    draftResult.candidateAssertions.length > 0
      ? draftResult.candidateAssertions
          .map(
            (c) =>
              `- **${c.id}**: ${c.description}\n  Suggested: \`${c.suggestedAssertionCode}\``
          )
          .join('\n')
      : '- None';

  const commandLines = commandRecords
    .map((rec) => `- \`${rec.command}\` -> **${rec.status.toUpperCase()}**: ${rec.outputSummary}`)
    .join('\n');

  const assumptionsLines = draftResult.assumptionsAndUnverified
    .map((a) => `- ${a}`)
    .join('\n');

  const katalonSection = draftResult.katalonAssertionReport
    ? `\n### Katalon Assertion Parity\n- Source Script: \`${draftResult.katalonAssertionReport.katalonScript}\`\n- Katalon Assertions: **${draftResult.katalonAssertionReport.katalonAssertionCount}**\n- Playwright Assertions: **${draftResult.katalonAssertionReport.playwrightAssertionCount}**\n- Parity Met: **${draftResult.katalonAssertionReport.parityMet ? 'Yes' : 'No'}**\n`
    : '';

  const mrDescriptionMarkdown = `## Flow
- **Ticket**: ${inputs.ticket}
- **Flow**: ${inputs.flow}
- **URL**: ${inputs.url}
- **Platform**: ${inputs.platform}
- **ENV**: ${inputs.env}
- **Tag**: ${inputs.tag}

## Expected Results Covered
${expectedCoveredLines}

## ISTQB Cases
${testTableMarkdown}
${katalonSection}
## Commands Run and Results
${commandLines}

## Open Questions & Candidate Assertions
${candidateLines}
`;

  const outputSummaryMarkdown = `## Output Summary

### Files changed
${filesChangedLines}

### Test table
${testTableMarkdown}
${katalonSection}
### Assumptions, and anything you could not verify
${assumptionsLines}

### Candidate assertions for you to confirm
${candidateLines}

### Commands run and their results
${commandLines}

### Git & MR details
- **Branch name**: \`${branchName}\`
- **Conventional commit**: \`${commitMessage}\`
- **MR link**: ${mrLink}
`;

  return {
    branchName,
    commitMessage,
    mrDescriptionMarkdown,
    outputSummaryMarkdown,
  };
}

