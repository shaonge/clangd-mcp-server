// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { ChildProcess } from 'node:child_process';
import {
  createWorkspace,
  ensureBuild,
  findExecutable,
  INTEGRATION_TEST_TIMEOUT_MS,
  pidExists,
  removeWorkspace,
  sendJsonLine,
  shutdownWrapper,
  spawnWrapper,
  waitForBranch,
  waitForChildExit,
  waitForPidExit
} from '../helpers/integration-process.js';

describe('stdio shutdown integration', () => {
  const npmPath = findExecutable('npm');
  const clangdPath = findExecutable('clangd');
  const shouldRun = Boolean(npmPath && clangdPath);
  let workspace = '';
  const children = new Set<ChildProcess>();

  beforeAll(() => {
    ensureBuild();
    workspace = createWorkspace('clangd-mcp-stdio-it-');
  });

  afterAll(async () => {
    for (const child of children) {
      await shutdownWrapper(child);
    }

    removeWorkspace(workspace);
  });

  const integrationIt = shouldRun ? it : it.skip;

  integrationIt(
    'exits the wrapper, node server, and clangd when the parent closes stdin',
    async () => {
      const child = spawnWrapper(workspace, clangdPath!);
      children.add(child);

      const branch = await waitForBranch(child.pid!, 15_000);
      const exitPromise = waitForChildExit(child, 15_000);

      child.stdin?.end();

      const exitResult = await exitPromise;

      await waitForPidExit(branch.wrapperPid, 15_000);
      await waitForPidExit(branch.nodePid, 15_000);
      await waitForPidExit(branch.clangdPid, 15_000);

      expect(exitResult.code).toBe(0);
      expect(exitResult.signal).toBeNull();
      expect(pidExists(branch.wrapperPid)).toBe(false);
      expect(pidExists(branch.nodePid)).toBe(false);
      expect(pidExists(branch.clangdPid)).toBe(false);
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );

  integrationIt(
    'exits the wrapper, node server, and clangd when stdout hits EPIPE',
    async () => {
      const child = spawnWrapper(workspace, clangdPath!, { captureStdout: true });
      children.add(child);

      const branch = await waitForBranch(child.pid!, 15_000);
      const exitPromise = waitForChildExit(child, 15_000);

      child.stdout?.destroy();
      sendJsonLine(child, {
        jsonrpc: '2.0',
        id: 1,
        method: 'ping'
      });

      const exitResult = await exitPromise;

      await waitForPidExit(branch.wrapperPid, 15_000);
      await waitForPidExit(branch.nodePid, 15_000);
      await waitForPidExit(branch.clangdPid, 15_000);

      expect(exitResult.code).toBe(0);
      expect(exitResult.signal).toBeNull();
      expect(pidExists(branch.wrapperPid)).toBe(false);
      expect(pidExists(branch.nodePid)).toBe(false);
      expect(pidExists(branch.clangdPid)).toBe(false);
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );
});
