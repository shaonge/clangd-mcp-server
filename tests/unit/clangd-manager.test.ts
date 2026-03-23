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

  it('reports background indexing as disabled when the flag is off', () => {
    const manager = new ClangdManager({
      ...config,
      clangdArgs: ['--background-index=false']
    });

    expect(manager.isBackgroundIndexEnabled()).toBe(false);
    expect(manager.getBackgroundIndexState()).toBe('disabled');
    expect(manager.getBackgroundIndexStatus()).toEqual({
      state: 'disabled',
      enabled: false,
      in_progress: false
    });
    expect(manager.getBackgroundIndexCompletionBasis()).toBe('none');
  });

  it('reports partial before the first background index completes', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.lastSuccessfulStart = Date.now();

    expect(manager.getBackgroundIndexState()).toBe('partial');
  });

  it('reports indexing while an index progress token is active', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.lastSuccessfulStart = Date.now();
    managerAny.activeProgressTokens.set('token-1', {
      title: 'Background index',
      isIndexProgress: true,
      startedAtMs: Date.now() - 1000,
      updatedAtMs: Date.now(),
      progressPercentage: 50,
      indexedFiles: 3,
      totalFiles: 6,
      message: '3/6',
      sawStrongCompletionSignal: false
    });
    managerAny.backgroundIndexStartedAtMs = Date.now() - 2000;
    managerAny.backgroundIndexLastUpdatedAtMs = Date.now();
    managerAny.backgroundIndexProgressPercentage = 50;
    managerAny.backgroundIndexIndexedFiles = 3;
    managerAny.backgroundIndexTotalFiles = 6;
    managerAny.backgroundIndexMessage = '3/6';

    expect(manager.isBackgroundIndexing()).toBe(true);
    expect(manager.getBackgroundIndexState()).toBe('indexing');
    expect(manager.getBackgroundIndexStatus()).toMatchObject({
      state: 'indexing',
      enabled: true,
      in_progress: true,
      progress_percentage: 50,
      indexed_files: 3,
      total_files: 6,
      message: '3/6'
    });
    expect(manager.getBackgroundIndexCompletionBasis()).toBe('none');
  });

  it('reports partial when indexing has settled without strong completion evidence', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.lastSuccessfulStart = Date.now() - 60_000;
    managerAny.backgroundIndexHasObservedActivity = true;
    managerAny.backgroundIndexCycleEnded = true;
    managerAny.backgroundIndexLastUpdatedAtMs = Date.now();

    expect(manager.getBackgroundIndexState()).toBe('partial');
    expect(manager.getBackgroundIndexStatus()).toMatchObject({
      state: 'partial',
      enabled: true,
      in_progress: false
    });
    expect(manager.getBackgroundIndexCompletionBasis()).toBe('none');
  });

  it('reports completed after a strong completion signal and cycle end', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.lastSuccessfulStart = Date.now() - 60_000;
    managerAny.backgroundIndexHasObservedActivity = true;
    managerAny.backgroundIndexCycleEnded = true;
    managerAny.backgroundIndexHasStrongCompletionSignal = true;
    managerAny.backgroundIndexProgressPercentage = 100;
    managerAny.backgroundIndexIndexedFiles = 6;
    managerAny.backgroundIndexTotalFiles = 6;
    managerAny.backgroundIndexMessage = '6/6';
    managerAny.backgroundIndexStartedAtMs = Date.now() - 5_000;
    managerAny.backgroundIndexLastUpdatedAtMs = Date.now() - 100;

    expect(manager.getBackgroundIndexState()).toBe('completed');
    expect(manager.getBackgroundIndexStatus()).toMatchObject({
      state: 'completed',
      enabled: true,
      in_progress: false,
      progress_percentage: 100,
      indexed_files: 6,
      total_files: 6,
      message: '6/6'
    });
    expect(manager.getBackgroundIndexCompletionBasis()).toBe('coverage');
  });

  it('reports progress basis when completed without file counts', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.lastSuccessfulStart = Date.now() - 60_000;
    managerAny.backgroundIndexHasObservedActivity = true;
    managerAny.backgroundIndexCycleEnded = true;
    managerAny.backgroundIndexHasStrongCompletionSignal = true;
    managerAny.backgroundIndexProgressPercentage = 100;
    // No indexed_files / total_files — only percentage was reported
    managerAny.backgroundIndexStartedAtMs = Date.now() - 5_000;
    managerAny.backgroundIndexLastUpdatedAtMs = Date.now() - 100;

    expect(manager.getBackgroundIndexState()).toBe('completed');
    expect(manager.getBackgroundIndexCompletionBasis()).toBe('progress');
  });

  it('clears stale progress tracking state', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.activeProgressTokens.set('token-1', {
      title: 'Background index',
      isIndexProgress: true,
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      sawStrongCompletionSignal: false
    });
    managerAny.backgroundIndexHasObservedActivity = true;
    managerAny.backgroundIndexCycleEnded = true;
    managerAny.backgroundIndexHasStrongCompletionSignal = true;
    managerAny.backgroundIndexStartedAtMs = Date.now();
    managerAny.backgroundIndexLastUpdatedAtMs = Date.now();
    managerAny.backgroundIndexProgressPercentage = 100;
    managerAny.backgroundIndexIndexedFiles = 6;
    managerAny.backgroundIndexTotalFiles = 6;
    managerAny.backgroundIndexMessage = '6/6';

    managerAny.clearProgressTracking();

    expect(managerAny.activeProgressTokens.size).toBe(0);
    expect(managerAny.backgroundIndexHasObservedActivity).toBe(false);
    expect(managerAny.backgroundIndexCycleEnded).toBe(false);
    expect(managerAny.backgroundIndexHasStrongCompletionSignal).toBe(false);
    expect(managerAny.backgroundIndexStartedAtMs).toBeUndefined();
    expect(managerAny.backgroundIndexIndexedFiles).toBeUndefined();
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

  it('logs background index progress summaries instead of raw file-level stderr', () => {
    const manager = new ClangdManager(config);
    const managerAny = manager as any;
    managerAny.process = { pid: 4242 };
    managerAny.activeProgressTokens.set('background-index', {
      title: 'Background index',
      isIndexProgress: true,
      startedAtMs: Date.now(),
      updatedAtMs: Date.now(),
      sawStrongCompletionSignal: false
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
