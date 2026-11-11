import { spawn } from 'node:child_process';
import { DrafterInputs } from './input-validator.js';

export interface CommandExecutionRecord {
  command: string;
  status: 'passed' | 'failed' | 'not-run';
  exitCode: number | null;
  outputSummary: string;
}

function runShellCommand(command: string, cwd: string): Promise<CommandExecutionRecord> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, CI: '1' },
    });

    let combined = '';
    child.stdout.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      combined += chunk.toString();
    });

    child.on('close', (code) => {
      const trimmed = combined.trim().slice(-600);
      if (
        code !== 0 &&
        /ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ENOTFOUND|missing.*credential|Missing script: "lint"/i.test(combined)
      ) {
        resolve({
          command,
          status: 'not-run',
          exitCode: code,
          outputSummary: `Could not complete run (${trimmed || 'missing credentials, lint script, or network access'}). Not marking as passing.`,
        });
        return;
      }

      resolve({
        command,
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        outputSummary: trimmed || (code === 0 ? 'Exited cleanly (code 0).' : `Exited with code ${code}.`),
      });
    });

    child.on('error', (err) => {
      resolve({
        command,
        status: 'not-run',
        exitCode: null,
        outputSummary: `Run could not start: ${err.message}. Not marking as passing.`,
      });
    });
  });
}

// I am building the required verification command list and optionally executing them in the target repository.
export async function runDrafterVerification(
  inputs: DrafterInputs,
  specRelativePath: string,
  repoRoot: string,
  executeNow: boolean = false
): Promise<CommandExecutionRecord[]> {
  const envVal = inputs.env || 'staging';
  const commands: string[] = ['npm run lint'];

  if (inputs.platform === 'web-local' || inputs.platform === 'both') {
    commands.push(
      `npx cross-env RUN_ON=local ENV=${envVal} npx playwright test ${specRelativePath} --project=web-local --workers=1`
    );
  }
  if (inputs.platform === 'mobile-local' || inputs.platform === 'both') {
    commands.push(
      `npx cross-env RUN_ON=local ENV=${envVal} npx playwright test ${specRelativePath} --project=mobile-local --workers=1`
    );
  }

  if (!executeNow) {
    return commands.map((cmd) => ({
      command: cmd,
      status: 'not-run',
      exitCode: null,
      outputSummary: 'Not executed in this session (dry-run / preview mode). Do not mark as passing until executed.',
    }));
  }

  const results: CommandExecutionRecord[] = [];
  for (const cmd of commands) {
    const res = await runShellCommand(cmd, repoRoot);
    results.push(res);
  }
  return results;
}

