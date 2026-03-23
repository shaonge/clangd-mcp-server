// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProcessTable } from '../../src/duplicate-process-cleanup.js';

export type ProcessBranch = {
  wrapperPid: number | null;
  nodePid: number | null;
  clangdPid: number | null;
};

export const INTEGRATION_TEST_TIMEOUT_MS = 45_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findExecutable(cmd: string): string | null {
  try {
    return execFileSync('which', [cmd], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export function listProcesses() {
  const output = execFileSync(
    'ps',
    ['-Ao', 'pid=,ppid=,command='],
    { encoding: 'utf8' }
  );
  return parseProcessTable(output);
}

export function findBranch(wrapperPid: number): ProcessBranch {
  const entries = listProcesses();
  const wrapper = entries.find((entry) => entry.pid === wrapperPid);
  const node = entries.find((entry) =>
    entry.ppid === wrapperPid && entry.command.includes('clangd-mcp-server')
  );
  const clangd = node
    ? entries.find((entry) =>
        entry.ppid === node.pid &&
        /\bclangd\b/.test(entry.command) &&
        !entry.command.includes('clangd-mcp-server')
      )
    : undefined;

  return {
    wrapperPid: wrapper?.pid ?? null,
    nodePid: node?.pid ?? null,
    clangdPid: clangd?.pid ?? null
  };
}

export function pidExists(pid: number | null): boolean {
  if (pid == null) {
    return false;
  }

  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'pid='], {
      encoding: 'utf8'
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

type SpawnWrapperOptions = {
  captureStdout?: boolean;
  captureStderr?: boolean;
};

export function spawnWrapper(
  workspace: string,
  clangdPath: string,
  options: SpawnWrapperOptions = {}
): ChildProcess {
  const child = spawn(
    'npm',
    ['exec', '--yes', '--package=.', '--', 'clangd-mcp-server', '--stdio'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PROJECT_ROOT: workspace,
        COMPILE_COMMANDS_DIR: workspace,
        CLANGD_PATH: clangdPath,
        LOG_LEVEL: 'INFO'
      },
      stdio: [
        'pipe',
        options.captureStdout ? 'pipe' : 'ignore',
        options.captureStderr ? 'pipe' : 'ignore'
      ]
    }
  );

  return child;
}

export function cleanupChildHandles(child: ChildProcess): void {
  child.removeAllListeners();
  child.stdin?.removeAllListeners();
  child.stdin?.destroy();
  child.stdout?.removeAllListeners();
  child.stdout?.destroy();
  child.stderr?.removeAllListeners();
  child.stderr?.destroy();
}

export async function waitForBranch(wrapperPid: number, timeoutMs: number): Promise<ProcessBranch> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const branch = findBranch(wrapperPid);
    if (branch.wrapperPid && branch.nodePid && branch.clangdPid) {
      return branch;
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for process branch under wrapper pid ${wrapperPid}`);
}

export async function waitForPidExit(pid: number | null, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (!pidExists(pid)) {
      return;
    }
    await sleep(200);
  }

  throw new Error(`Timed out waiting for pid ${pid} to exit`);
}

export async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const timedOut = await Promise.race([
    exitPromise.then((result) => ({ timedOut: false as const, result })),
    sleep(timeoutMs).then(() => ({ timedOut: true as const, result: null }))
  ]);

  if (timedOut.timedOut) {
    throw new Error(`Timed out waiting for child pid ${child.pid} to exit`);
  }

  return timedOut.result;
}

export async function shutdownWrapper(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    cleanupChildHandles(child);
    return;
  }

  const exitPromise = waitForChildExit(child, 5000);
  child.stdin?.end();

  try {
    await exitPromise;
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, 5000);
  }

  cleanupChildHandles(child);
}

export function ensureBuild(): void {
  execFileSync('npm', ['run', 'build'], {
    cwd: process.cwd(),
    stdio: 'ignore'
  });
}

export function createWorkspace(prefix: string): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(workspace, 't.cc'), 'int main() { return 0; }\n');
  writeFileSync(
    join(workspace, 'compile_commands.json'),
    JSON.stringify(
      [
        {
          directory: workspace,
          file: join(workspace, 't.cc'),
          command: 'clang++ -c t.cc'
        }
      ],
      null,
      2
    )
  );
  return workspace;
}

export function removeWorkspace(workspace: string): void {
  if (workspace && existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export function sendJsonLine(child: ChildProcess, message: unknown): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}
