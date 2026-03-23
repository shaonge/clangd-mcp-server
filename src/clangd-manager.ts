// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { spawn, ChildProcess } from 'node:child_process';
import { logger } from './utils/logger.js';
import { ClangdError } from './utils/errors.js';
import { LSPClient } from './lsp-client.js';
import { ClangdConfig } from './config-detector.js';

interface InitializeResult {
  capabilities: any;
  serverInfo?: {
    name: string;
    version?: string;
  };
}

interface ProgressTokenInfo {
  title: string;
  isIndexProgress: boolean;
  progressPercentage?: number;
  indexedFiles?: number;
  totalFiles?: number;
  message?: string;
}

export class ClangdManager {
  private config: ClangdConfig;
  private clientVersion: string;
  private process?: ChildProcess;
  private lspClient?: LSPClient;
  private initialized: boolean = false;
  private shuttingDown: boolean = false;
  private restartCount: number = 0;
  private readonly maxRestarts: number = 3;
  private isRestarting: boolean = false;
  private lastSuccessfulStart: number = 0;
  private readonly stableOperationPeriodMs: number = 60000; // 1 minute
  private activeProgressTokens: Map<string | number, ProgressTokenInfo> = new Map();
  private onRestartedCallbacks: Array<() => void> = [];

  constructor(config: ClangdConfig, clientVersion: string = '0.1.0') {
    this.config = config;
    this.clientVersion = clientVersion;
  }

  private getProcessPid(process: ChildProcess | undefined = this.process): number | 'unknown' {
    return process?.pid ?? 'unknown';
  }

  /**
   * Start clangd and initialize the LSP connection
   */
  async start(): Promise<void> {
    if (this.shuttingDown) {
      throw new ClangdError('Cannot start: manager is shut down');
    }
    if (this.process) {
      logger.warn('Clangd already running');
      return;
    }

    try {
      this.clearProgressTokens();
      await this.spawnClangd();
      await this.initialize();
      this.initialized = true;

      // Reset restart count if we've had a stable operation period
      if (this.restartCount > 0) {
        const timeSinceLastStart = Date.now() - this.lastSuccessfulStart;
        if (timeSinceLastStart >= this.stableOperationPeriodMs) {
          logger.info('Stable operation detected, resetting restart counter');
          this.restartCount = 0;
        }
      }

      this.lastSuccessfulStart = Date.now();

      logger.info('Clangd started and initialized successfully');
    } catch (error) {
      logger.error('Failed to start clangd:', error);
      await this.cleanup();
      throw new ClangdError('Failed to start clangd: ' + error);
    }
  }

  /**
   * Spawn the clangd process
   */
  private async spawnClangd(): Promise<void> {
    logger.info('Spawning clangd:', this.config.clangdPath, this.config.clangdArgs);

    this.process = spawn(this.config.clangdPath, this.config.clangdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.config.projectRoot
    });

    logger.info(`Spawned clangd process (clangd_pid ${this.getProcessPid()})`);

    if (!this.process.stdin || !this.process.stdout || !this.process.stderr) {
      throw new ClangdError('Failed to create clangd stdio streams');
    }

    // Create LSP client
    this.lspClient = new LSPClient(this.process.stdin, this.process.stdout);

    // Handle process events
    this.process.on('error', (error) => {
      logger.error(`Clangd process error (clangd_pid ${this.getProcessPid()}):`, error);
    });

    this.process.on('exit', (code, signal) => {
      const pid = this.getProcessPid(this.process);
      logger.warn(`Clangd process exited (clangd_pid ${pid}) with code ${code}, signal ${signal}`);
      this.handleProcessExit(code, signal, pid);
    });

    // Log stderr output
    this.process.stderr.on('data', (data: Buffer) => {
      const message = data.toString().trim();
      if (message) {
        logger.debug(`Clangd stderr (clangd_pid ${this.getProcessPid()}):`, message);
      }
    });

    // Give the process a moment to start
    await new Promise(resolve => setTimeout(resolve, 100));

    if (!this.process || this.process.exitCode !== null) {
      throw new ClangdError('Clangd process failed to start');
    }
  }

  /**
   * Initialize the LSP connection with clangd
   */
  private async initialize(): Promise<void> {
    if (!this.lspClient) {
      throw new ClangdError('LSP client not created');
    }

    logger.info('Initializing LSP connection');

    const initializeParams = {
      processId: process.pid,
      clientInfo: {
        name: 'clangd-mcp-server',
        version: this.clientVersion
      },
      rootUri: `file://${this.config.projectRoot}`,
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          implementation: { linkSupport: true },
          documentSymbol: {
            hierarchicalDocumentSymbolSupport: true
          }
        },
        workspace: {
          symbol: {}
        },
        window: {
          workDoneProgress: true
        }
      },
      initializationOptions: {}
    };

    try {
      const result: InitializeResult = await this.lspClient.request(
        'initialize',
        initializeParams,
        30000
      );

      logger.info('LSP initialized:', result.serverInfo);

      // Send initialized notification
      this.lspClient.notify('initialized', {});

      // Track background indexing progress via $/progress notifications
      this.lspClient.onNotification('$/progress', (params: any) => {
        const token = params?.token;
        const value = params?.value;
        if (token == null || !value) return;

        if (value.kind === 'begin') {
          this.handleProgressBegin(token, value);
        } else if (value.kind === 'report') {
          this.handleProgressReport(token, value);
        } else if (value.kind === 'end') {
          this.handleProgressEnd(token);
        }
      });

      logger.info('LSP initialization complete');
    } catch (error) {
      throw new ClangdError('LSP initialization failed: ' + error);
    }
  }

  /**
   * Handle clangd process exit
   */
  private handleProcessExit(code: number | null, signal: string | null, pid: number | 'unknown' = this.getProcessPid()): void {
    if (this.shuttingDown) {
      logger.info(`Clangd shut down gracefully (clangd_pid ${pid})`);
      return;
    }

    logger.error(`Clangd crashed unexpectedly (clangd_pid ${pid})`);

    // Clean up current state
    this.process = undefined;
    this.lspClient = undefined;
    this.initialized = false;
    this.clearProgressTokens();

    // Prevent concurrent restart attempts
    if (this.isRestarting) {
      logger.warn('Restart already in progress, ignoring duplicate crash');
      return;
    }

    // Reset restart count if we've had stable operation
    const timeSinceLastStart = Date.now() - this.lastSuccessfulStart;
    if (timeSinceLastStart >= this.stableOperationPeriodMs && this.restartCount > 0) {
      logger.info('Stable operation period elapsed, resetting restart counter');
      this.restartCount = 0;
    }

    // Attempt restart if under limit
    if (this.restartCount < this.maxRestarts) {
      this.restartCount++;
      this.isRestarting = true;
      logger.warn(`Attempting to restart clangd after clangd_pid ${pid} exited (attempt ${this.restartCount}/${this.maxRestarts})`);

      setTimeout(() => {
        this.start()
          .then(() => {
            this.isRestarting = false;
            logger.info('Clangd restarted successfully');
            for (const cb of this.onRestartedCallbacks) {
              try {
                cb();
              } catch (e) {
                logger.error('onRestarted callback error:', e);
              }
            }
          })
          .catch((error) => {
            this.isRestarting = false;
            logger.error('Failed to restart clangd:', error);
          });
      }, 1000 * this.restartCount); // Exponential backoff
    } else {
      logger.error('Max restart attempts reached, giving up');
    }
  }

  /**
   * Gracefully shutdown clangd
   */
  async shutdown(): Promise<void> {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;

    if (!this.process) {
      return;
    }
    logger.info(`Shutting down clangd (clangd_pid ${this.getProcessPid()})`);

    try {
      if (this.lspClient && this.initialized) {
        // Send shutdown request
        await this.lspClient.request('shutdown', undefined, 5000);
        // Send exit notification
        this.lspClient.notify('exit');
      }

      // Wait a bit for graceful exit
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      logger.warn('Error during graceful shutdown:', error);
    }

    await this.cleanup();
  }

  /**
   * Force cleanup of clangd resources
   */
  private async cleanup(): Promise<void> {
    // Mark as shutting down so the exit handler won't trigger auto-restart.
    // Without this, killing the process during a failed start() would be
    // misinterpreted as a crash, scheduling a background restart that the
    // caller can no longer control.
    this.shuttingDown = true;

    if (this.lspClient) {
      this.lspClient.close();
      this.lspClient = undefined;
    }

    if (this.process && this.process.exitCode === null) {
      logger.info(`Killing clangd process (clangd_pid ${this.getProcessPid()})`);
      this.process.kill('SIGTERM');

      // Force kill after timeout
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (this.process && this.process.exitCode === null) {
        logger.warn(`Force killing clangd process (clangd_pid ${this.getProcessPid()})`);
        this.process.kill('SIGKILL');
      }
    }

    this.process = undefined;
    this.initialized = false;
    this.clearProgressTokens();
    this.isRestarting = false;
  }

  /**
   * Get the LSP client
   */
  getClient(): LSPClient {
    if (!this.lspClient || !this.initialized) {
      throw new ClangdError('Clangd not initialized');
    }
    return this.lspClient;
  }

  /**
   * Register a callback that runs after clangd is restarted from a crash.
   */
  onRestarted(callback: () => void): void {
    this.onRestartedCallbacks.push(callback);
  }

  /**
   * Check if clangd is running and initialized
   */
  isReady(): boolean {
    return this.initialized && !!this.process && this.process.exitCode === null;
  }

  private clearProgressTokens(): void {
    this.activeProgressTokens.clear();
  }

  private handleProgressBegin(token: string | number, value: any): void {
    const title = typeof value.title === 'string' ? value.title : '';
    const isIndexProgress = this.isIndexProgressToken(token, title);

    this.activeProgressTokens.set(token, {
      title,
      isIndexProgress,
      progressPercentage: this.toOptionalNumber(value.percentage),
      message: title || undefined
    });

    if (isIndexProgress) {
      logger.info(
        `Background index started (clangd_pid ${this.getProcessPid()}): ${title || String(token)}`
      );
    } else {
      logger.info(`Progress started [${token}]: ${title}`);
    }
  }

  private handleProgressReport(token: string | number, value: any): void {
    const existing = this.activeProgressTokens.get(token);
    if (!existing) {
      // Ignore report for tokens that never had a begin event
      return;
    }
    const isIndexProgress = existing.isIndexProgress;

    const counts = this.parseProgressCounts(value.message);
    const progressPercentage = this.toOptionalNumber(value.percentage);
    const message = typeof value.message === 'string' ? value.message : undefined;

    this.activeProgressTokens.set(token, {
      title: existing?.title ?? '',
      isIndexProgress,
      progressPercentage,
      indexedFiles: counts?.current,
      totalFiles: counts?.total,
      message
    });

    if (isIndexProgress) {
      logger.info(
        `Background index progress (clangd_pid ${this.getProcessPid()}): ${this.formatBackgroundIndexProgress(
          counts?.current,
          counts?.total,
          progressPercentage,
          message
        )}`
      );
    }

    const pct = progressPercentage != null ? ` ${progressPercentage}%` : '';
    logger.debug(`Progress [${token}]:${pct} ${message || ''}`);
  }

  private handleProgressEnd(token: string | number): void {
    const info = this.activeProgressTokens.get(token);
    this.activeProgressTokens.delete(token);

    if (info?.isIndexProgress || this.isIndexProgressToken(token, info?.title)) {
      logger.info(
        `Background index ended (clangd_pid ${this.getProcessPid()}): ${this.formatBackgroundIndexProgress(
          info?.indexedFiles,
          info?.totalFiles,
          info?.progressPercentage,
          info?.message ?? info?.title
        )}`
      );
      return;
    }

    logger.info(`Progress ended [${token}]: ${info?.title || ''}`);
  }

  private formatBackgroundIndexProgress(
    indexedFiles: number | undefined,
    totalFiles: number | undefined,
    progressPercentage: number | undefined,
    message: string | undefined
  ): string {
    const parts: string[] = [];

    if (indexedFiles != null && totalFiles != null) {
      parts.push(`${indexedFiles}/${totalFiles} files`);
    }

    if (progressPercentage != null) {
      parts.push(`${progressPercentage}%`);
    }

    if (parts.length > 0) {
      return parts.join(' ');
    }

    return message || 'progress update';
  }

  private isIndexProgressToken(token: string | number, title?: string): boolean {
    const tokenText = String(token).toLowerCase();
    const titleText = title?.toLowerCase() || '';
    return tokenText.includes('index') || titleText.includes('index');
  }

  private parseProgressCounts(message: unknown): { current: number; total: number } | undefined {
    if (typeof message !== 'string') {
      return undefined;
    }

    const match = message.trim().match(/^(\d+)\s*\/\s*(\d+)$/);
    if (!match) {
      return undefined;
    }

    return {
      current: parseInt(match[1], 10),
      total: parseInt(match[2], 10)
    };
  }

  private toOptionalNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
}
