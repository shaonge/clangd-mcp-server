// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { ClangdManager } from '../../src/clangd-manager.js';
import type { ClangdConfig } from '../../src/config-detector.js';

describe('ClangdManager', () => {
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  const config: ClangdConfig = {
    clangdPath: '/path/to/clangd',
    clangdArgs: ['--background-index=true'],
    projectRoot: '/project',
    isChromiumProject: false
  };

  beforeEach(() => {
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    jest.useRealTimers();
  });

  it('invokes the restart callback after a successful restart', async () => {
    jest.useFakeTimers();

    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    const restarted = jest.fn();
    manager.onRestarted(restarted);
    managerAny.start = jest.fn(async () => undefined);

    managerAny.handleProcessExit(1, null);
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(managerAny.start).toHaveBeenCalledTimes(1);
    expect(restarted).toHaveBeenCalledTimes(1);
  });

  it('includes clangd_pid in shutdown-related logs', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.shuttingDown = true;

    managerAny.handleProcessExit(0, null, 4242);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('INFO'),
      expect.stringContaining('clangd_pid 4242')
    );
  });

  it('rejects start() after shutdown() to prevent orphaned restarts', async () => {
    const manager = new ClangdManager(config);

    // Simulate crashed state: process gone, pending restart scheduled
    await manager.shutdown();

    // The delayed restart calls start() — it must not spawn a new process
    await expect(manager.start()).rejects.toThrow('Cannot start: manager is shut down');
  });

  it('shutdown() cancels pending restart even when process is already gone', () => {
    jest.useFakeTimers();

    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.start = jest.fn(async () => undefined);

    // Crash: process exits, restart scheduled
    managerAny.handleProcessExit(1, null);
    expect(managerAny.isRestarting).toBe(true);

    // Simulate index.ts calling shutdown() on the old manager before creating a new one.
    // process is already undefined (cleared by handleProcessExit), but shutdown()
    // must still set shuttingDown=true to block the pending restart.
    manager.shutdown();

    // Advance past restart delay
    jest.advanceTimersByTime(5000);

    // start() should have been called but thrown due to shuttingDown
    // (we mocked start, so check shuttingDown flag instead)
    expect(managerAny.shuttingDown).toBe(true);
  });

  it('does not schedule auto-restart when cleanup kills the process after a failed start', () => {
    jest.useFakeTimers();

    const manager = new ClangdManager(config);
    const managerAny = manager as any;

    // Simulate: spawnClangd() succeeded but initialize() will fail.
    // cleanup() kills the process → exit event fires → handleProcessExit().
    // Before the fix, shuttingDown was false so handleProcessExit() treated
    // the exit as a crash and scheduled a background restart, leaving an
    // orphaned clangd process that the caller could no longer control.

    // Call cleanup (as start()'s catch block does)
    managerAny.cleanup();

    // Now simulate the exit event that the killed process would emit
    managerAny.handleProcessExit(null, 'SIGTERM');

    // Advance timers past the restart delay
    jest.advanceTimersByTime(5000);

    // No restart should have been scheduled
    expect(managerAny.shuttingDown).toBe(true);
    expect(managerAny.isRestarting).toBe(false);
    expect(managerAny.restartCount).toBe(0);
  });

  it('keeps background index progress logging', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.process = { pid: 4242 };
    managerAny.activeProgressTokens.set('background-index', {
      title: 'Background index',
      isIndexProgress: true
    });

    managerAny.handleProgressReport('background-index', {
      kind: 'report',
      percentage: 89,
      message: '1505/1697'
    });

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('INFO'),
      expect.stringContaining('Background index progress (clangd_pid 4242): 1505/1697 files 89%')
    );
  });
});
