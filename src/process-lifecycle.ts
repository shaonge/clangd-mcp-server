// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { logger as defaultLogger } from './utils/logger.js';

type ShutdownRequestOptions = {
  forceOnRepeat?: boolean;
};

type ShutdownRequest = (
  reason: string,
  options?: ShutdownRequestOptions
) => Promise<void>;

type LoggerLike = Pick<typeof defaultLogger, 'error' | 'info' | 'warn'>;

type EventSource = {
  on(event: string, listener: (...args: any[]) => void): void;
  off?(event: string, listener: (...args: any[]) => void): void;
  removeListener?(event: string, listener: (...args: any[]) => void): void;
};

type DisconnectableProcess = EventSource;

interface CreateShutdownHandlerOptions {
  shutdown: (reason: string) => Promise<void> | void;
  exit?: (code: number) => void;
  logger?: LoggerLike;
}

interface RegisterProcessLifecycleHandlersOptions {
  requestShutdown: ShutdownRequest;
  proc?: DisconnectableProcess;
  stdin?: EventSource;
  stdout?: EventSource;
  logger?: LoggerLike;
}

function detachListener(
  source: EventSource,
  event: string,
  listener: (...args: any[]) => void
): void {
  if (typeof source.off === 'function') {
    source.off(event, listener);
    return;
  }

  if (typeof source.removeListener === 'function') {
    source.removeListener(event, listener);
  }
}

export function createShutdownHandler({
  shutdown,
  exit = (code: number) => process.exit(code),
  logger = defaultLogger
}: CreateShutdownHandlerOptions): ShutdownRequest {
  let shutdownPromise: Promise<void> | null = null;

  return (reason: string, options: ShutdownRequestOptions = {}) => {
    if (shutdownPromise) {
      if (options.forceOnRepeat) {
        logger.warn(`Received ${reason} again, forcing exit`);
        exit(1);
      }
      return shutdownPromise;
    }

    shutdownPromise = Promise.resolve()
      .then(() => shutdown(reason))
      .then(() => {
        exit(0);
      })
      .catch((error) => {
        logger.error('Error during shutdown:', error);
        exit(1);
      });

    return shutdownPromise;
  };
}

export function registerProcessLifecycleHandlers({
  requestShutdown,
  proc = process,
  stdin = process.stdin,
  stdout = process.stdout,
  logger = defaultLogger
}: RegisterProcessLifecycleHandlersOptions): () => void {
  const handleSigint = () => {
    void requestShutdown('SIGINT', { forceOnRepeat: true });
  };

  const handleSigterm = () => {
    void requestShutdown('SIGTERM', { forceOnRepeat: true });
  };

  const handleDisconnect = () => {
    logger.info('MCP parent IPC disconnected, shutting down...');
    void requestShutdown('disconnect');
  };

  const handleStdinEnd = () => {
    logger.info('MCP stdin ended, shutting down...');
    void requestShutdown('stdin end');
  };

  const handleStdinClose = () => {
    logger.info('MCP stdin closed, shutting down...');
    void requestShutdown('stdin close');
  };

  const handleStdoutError = (error: NodeJS.ErrnoException) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
      logger.warn(`MCP stdout ${error.code}, shutting down...`);
      void requestShutdown(`stdout ${error.code}`);
      return;
    }

    logger.error('MCP stdout error:', error);
  };

  proc.on('SIGINT', handleSigint);
  proc.on('SIGTERM', handleSigterm);
  proc.on('disconnect', handleDisconnect);
  stdin.on('end', handleStdinEnd);
  stdin.on('close', handleStdinClose);
  stdout.on('error', handleStdoutError);

  return () => {
    detachListener(proc, 'SIGINT', handleSigint);
    detachListener(proc, 'SIGTERM', handleSigterm);
    detachListener(proc, 'disconnect', handleDisconnect);
    detachListener(stdin, 'end', handleStdinEnd);
    detachListener(stdin, 'close', handleStdinClose);
    detachListener(stdout, 'error', handleStdoutError);
  };
}
