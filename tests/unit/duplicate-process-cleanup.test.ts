// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import {
  findDuplicateWrapperSubtrees,
  parseProcessTable,
  terminateDuplicateNpmExecSiblings
} from '../../src/duplicate-process-cleanup.js';

describe('duplicate process cleanup', () => {
  it('parses ps output into process entries', () => {
    expect(parseProcessTable(' 100 10 npm exec @byted/clangd-mcp-server --stdio\n')).toEqual([
      {
        pid: 100,
        ppid: 10,
        command: 'npm exec @byted/clangd-mcp-server --stdio'
      }
    ]);
  });

  it('finds sibling npm exec wrappers under the current wrapper parent', () => {
    const processes = [
      { pid: 10, ppid: 1, command: 'Trae CN Helper (Plugin)' },
      { pid: 20, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 21, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 22, ppid: 10, command: 'npm exec other-tool' },
      { pid: 30, ppid: 20, command: 'node /opt/homebrew/bin/clangd-mcp-server --stdio' }
    ];

    expect(findDuplicateWrapperSubtrees(processes, 20)).toEqual([21]);
    expect(findDuplicateWrapperSubtrees(processes, 21)).toEqual([20]);
  });

  it('does nothing when the current parent is not the target npm exec wrapper', async () => {
    const signalProcess = jest.fn();
    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    };

    await terminateDuplicateNpmExecSiblings({
      currentPid: 30,
      parentPid: 20,
      listProcesses: () => [
        { pid: 10, ppid: 1, command: 'Trae CN Helper (Plugin)' },
        { pid: 20, ppid: 10, command: 'zsh -lc node dist/index.js' },
        { pid: 21, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
        { pid: 30, ppid: 20, command: 'node dist/index.js' }
      ],
      signalProcess,
      sleep: async () => undefined,
      logger
    });

    expect(signalProcess).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalledWith(
      'Killing duplicate clangd MCP wrapper subtrees:',
      expect.anything()
    );
  });

  it('kills duplicate wrapper subtrees, keeps the current branch alive, and reports what it terminated', async () => {
    const processes = [
      { pid: 10, ppid: 1, command: 'Trae CN Helper (Plugin)' },
      { pid: 20, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 21, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 22, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 23, ppid: 10, command: 'npm exec @byted/clangd-mcp-server --stdio' },
      { pid: 30, ppid: 20, command: 'node /opt/homebrew/bin/clangd-mcp-server --stdio' },
      { pid: 31, ppid: 30, command: '/path/to/clangd' },
      { pid: 40, ppid: 21, command: 'node /opt/homebrew/bin/clangd-mcp-server --stdio' },
      { pid: 41, ppid: 40, command: '/path/to/clangd' },
      { pid: 50, ppid: 22, command: 'node /opt/homebrew/bin/clangd-mcp-server --stdio' },
      { pid: 51, ppid: 50, command: '/path/to/current/clangd' },
      { pid: 60, ppid: 23, command: 'node /opt/homebrew/bin/clangd-mcp-server --stdio' },
      { pid: 61, ppid: 60, command: '/path/to/newer/clangd' }
    ];

    const alive = new Set(processes.map((entry) => entry.pid));
    const signalCalls: Array<[number, NodeJS.Signals | 0]> = [];
    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    };

    const signalProcess = (pid: number, signal: NodeJS.Signals | 0) => {
      signalCalls.push([pid, signal]);

      if (signal === 0) {
        if (!alive.has(pid)) {
          const error = Object.assign(new Error('missing pid'), { code: 'ESRCH' });
          throw error;
        }
        return;
      }

      if (signal === 'SIGTERM') {
        if (pid === 20 || pid === 41 || pid === 61) {
          alive.delete(pid);
        }
        return;
      }

      alive.delete(pid);
    };

    const result = await terminateDuplicateNpmExecSiblings({
      currentPid: 50,
      parentPid: 22,
      listProcesses: () => processes,
      signalProcess,
      sleep: async () => undefined,
      logger
    });

    const termPids = signalCalls
      .filter(([, signal]) => signal === 'SIGTERM')
      .map(([pid]) => pid)
      .sort((a, b) => a - b);
    const killPids = signalCalls
      .filter(([, signal]) => signal === 'SIGKILL')
      .map(([pid]) => pid)
      .sort((a, b) => a - b);

    expect(termPids).toEqual([20, 21, 23, 30, 31, 40, 41, 60, 61]);
    expect(killPids).toEqual([21, 23, 30, 31, 40, 60]);
    expect(termPids).not.toContain(22);
    expect(termPids).not.toContain(50);
    expect(termPids).not.toContain(51);
    expect(logger.info).toHaveBeenCalledWith(
      'Killing duplicate clangd MCP wrapper subtrees:',
      [61, 60, 41, 40, 31, 30, 23, 21, 20]
    );
    expect(result).toEqual({
      duplicateWrapperPids: [23, 21, 20],
      terminatedPids: [61, 60, 41, 40, 31, 30, 23, 21, 20]
    });
  });
});
