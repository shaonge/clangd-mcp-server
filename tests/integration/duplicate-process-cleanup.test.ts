// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { beforeAll, afterAll, describe, expect, it } from '@jest/globals';
import { ChildProcess } from 'node:child_process';
import {
  createWorkspace,
  ensureBuild,
  findBranch,
  findExecutable,
  INTEGRATION_TEST_TIMEOUT_MS,
  pidExists,
  removeWorkspace,
  shutdownWrapper,
  spawnWrapper,
  waitForBranch,
  waitForChildExit,
  waitForPidExit
} from '../helpers/integration-process.js';

describe('duplicate npm exec cleanup integration', () => {
  const npmPath = findExecutable('npm');
  const clangdPath = findExecutable('clangd');
  const shouldRun = Boolean(npmPath && clangdPath);
  let workspace = '';
  const children = new Set<ChildProcess>();

  beforeAll(() => {
    ensureBuild();
    workspace = createWorkspace('clangd-mcp-dup-it-');
  });

  afterAll(async () => {
    for (const child of children) {
      await shutdownWrapper(child);
    }

    removeWorkspace(workspace);
  });

  const integrationIt = shouldRun ? it : it.skip;

  integrationIt(
    'kills an older sibling npm exec subtree, exits, and allows the next launch to start cleanly',
    async () => {
      const first = spawnWrapper(workspace, clangdPath!);
      children.add(first);
      const firstBranch = await waitForBranch(first.pid!, 15_000);

      const second = spawnWrapper(workspace, clangdPath!, { captureStderr: true });
      children.add(second);
      let secondStderr = '';
      second.stderr?.setEncoding('utf8');
      second.stderr?.on('data', (chunk) => {
        secondStderr += chunk;
      });

      const secondExit = await waitForChildExit(second, 15_000);

      await waitForPidExit(firstBranch.wrapperPid, 15_000);
      await waitForPidExit(firstBranch.nodePid, 15_000);
      await waitForPidExit(firstBranch.clangdPid, 15_000);

      expect(secondExit.code).not.toBe(0);
      expect(secondExit.signal).toBeNull();
      expect(secondStderr).toContain('Retry startup now that the previous instance has been terminated.');

      expect(pidExists(firstBranch.wrapperPid)).toBe(false);
      expect(pidExists(firstBranch.nodePid)).toBe(false);
      expect(pidExists(firstBranch.clangdPid)).toBe(false);

      const third = spawnWrapper(workspace, clangdPath!);
      children.add(third);
      const thirdBranch = await waitForBranch(third.pid!, 15_000);
      const currentThirdBranch = findBranch(third.pid!);

      expect(pidExists(thirdBranch.wrapperPid)).toBe(true);
      expect(pidExists(thirdBranch.nodePid)).toBe(true);
      expect(pidExists(thirdBranch.clangdPid)).toBe(true);
      expect(pidExists(currentThirdBranch.wrapperPid)).toBe(true);
      expect(pidExists(currentThirdBranch.nodePid)).toBe(true);
      expect(pidExists(currentThirdBranch.clangdPid)).toBe(true);
    },
    INTEGRATION_TEST_TIMEOUT_MS
  );
});
