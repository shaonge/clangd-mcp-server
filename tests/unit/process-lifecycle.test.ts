// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import {
  createShutdownHandler,
  registerProcessLifecycleHandlers
} from '../../src/process-lifecycle.js';

describe('process lifecycle helpers', () => {
  it('does not force exit on repeated non-signal shutdown triggers', async () => {
    const shutdown = jest.fn(async () => undefined);
    const exit = jest.fn();
    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    };

    const requestShutdown = createShutdownHandler({
      shutdown,
      exit,
      logger
    });

    await Promise.all([
      requestShutdown('stdin end'),
      requestShutdown('stdin close')
    ]);

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledWith('stdin end');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('forces exit when a signal arrives again during shutdown', async () => {
    let resolveShutdown: (() => void) | undefined;
    const shutdown = jest.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));
    const exit = jest.fn();
    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    };

    const requestShutdown = createShutdownHandler({
      shutdown,
      exit,
      logger
    });

    const firstShutdown = requestShutdown('SIGTERM', { forceOnRepeat: true });
    await Promise.resolve();

    requestShutdown('SIGTERM', { forceOnRepeat: true });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Received SIGTERM again, forcing exit');
    expect(exit).toHaveBeenCalledWith(1);

    resolveShutdown?.();
    await firstShutdown;
    expect(exit).toHaveBeenLastCalledWith(0);
  });

  it('registers stdin and stdout handlers that request shutdown on disconnect signals', () => {
    const proc = new EventEmitter();
    const stdin = new EventEmitter();
    const stdout = new EventEmitter();
    const requestShutdown = jest.fn(async () => undefined);
    const logger = {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn()
    };

    const unregister = registerProcessLifecycleHandlers({
      requestShutdown,
      proc,
      stdin,
      stdout,
      logger
    });

    stdin.emit('end');
    stdin.emit('close');
    stdout.emit('error', { code: 'EPIPE' });
    proc.emit('SIGTERM');

    expect(requestShutdown).toHaveBeenNthCalledWith(1, 'stdin end');
    expect(requestShutdown).toHaveBeenNthCalledWith(2, 'stdin close');
    expect(requestShutdown).toHaveBeenNthCalledWith(3, 'stdout EPIPE');
    expect(requestShutdown).toHaveBeenNthCalledWith(4, 'SIGTERM', { forceOnRepeat: true });

    unregister();
    requestShutdown.mockClear();

    expect(stdout.listenerCount('error')).toBe(0);

    stdin.emit('end');
    proc.emit('SIGTERM');

    expect(requestShutdown).not.toHaveBeenCalled();
  });
});
