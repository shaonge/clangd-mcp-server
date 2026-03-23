// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from 'node:child_process';
import { logger as defaultLogger } from './utils/logger.js';

interface ProcessEntry {
  pid: number;
  ppid: number;
  command: string;
}

type SignalProcess = (pid: number, signal: NodeJS.Signals | 0) => void;

type LoggerLike = Pick<typeof defaultLogger, 'error' | 'info' | 'warn'>;

interface CleanupOptions {
  currentPid?: number;
  parentPid?: number;
  listProcesses?: () => ProcessEntry[];
  signalProcess?: SignalProcess;
  sleep?: (ms: number) => Promise<void>;
  logger?: LoggerLike;
  termGraceMs?: number;
}

export interface CleanupResult {
  duplicateWrapperPids: number[];
  terminatedPids: number[];
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSignalProcess(pid: number, signal: NodeJS.Signals | 0): void {
  process.kill(pid, signal);
}

export function parseProcessTable(output: string): ProcessEntry[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) {
        return null;
      }

      return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        command: match[3]
      };
    })
    .filter((entry): entry is ProcessEntry => entry !== null);
}

export function isTargetNpmExecWrapper(command: string): boolean {
  return /\bnpm\s+exec\b/.test(command) && command.includes('clangd-mcp-server');
}

function listProcessesFromPs(): ProcessEntry[] {
  const output = execFileSync(
    'ps',
    ['-Ao', 'pid=,ppid=,command='],
    { encoding: 'utf8' }
  );
  return parseProcessTable(output);
}

function collectSubtreePids(rootPid: number, childrenByParent: Map<number, number[]>): number[] {
  const result: number[] = [];
  const queue: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }];
  const visited = new Set<number>();
  const withDepth: Array<{ pid: number; depth: number }> = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current.pid)) {
      continue;
    }

    visited.add(current.pid);
    withDepth.push(current);

    for (const childPid of childrenByParent.get(current.pid) ?? []) {
      queue.push({ pid: childPid, depth: current.depth + 1 });
    }
  }

  withDepth.sort((a, b) => b.depth - a.depth || b.pid - a.pid);

  for (const entry of withDepth) {
    result.push(entry.pid);
  }

  return result;
}

export function findDuplicateWrapperSubtrees(
  processes: ProcessEntry[],
  currentParentPid: number
): number[] {
  const currentParent = processes.find((entry) => entry.pid === currentParentPid);
  if (!currentParent || !isTargetNpmExecWrapper(currentParent.command)) {
    return [];
  }

  const grandparentPid = currentParent.ppid;
  if (grandparentPid <= 1) {
    return [];
  }

  return processes
    .filter((entry) =>
      entry.ppid === grandparentPid &&
      entry.pid !== currentParentPid &&
      isTargetNpmExecWrapper(entry.command)
    )
    .map((entry) => entry.pid)
    .sort((a, b) => b - a);
}

export async function terminateDuplicateNpmExecSiblings({
  currentPid = process.pid,
  parentPid = process.ppid,
  listProcesses = listProcessesFromPs,
  signalProcess = defaultSignalProcess,
  sleep = sleepMs,
  logger = defaultLogger,
  termGraceMs = 500
}: CleanupOptions = {}): Promise<CleanupResult> {
  let processes: ProcessEntry[];

  try {
    processes = listProcesses();
  } catch (error) {
    logger.warn('Failed to inspect process tree for duplicate npm exec wrappers:', error);
    return {
      duplicateWrapperPids: [],
      terminatedPids: []
    };
  }

  const duplicateWrapperPids = findDuplicateWrapperSubtrees(processes, parentPid);
  if (duplicateWrapperPids.length === 0) {
    return {
      duplicateWrapperPids: [],
      terminatedPids: []
    };
  }

  const childrenByParent = new Map<number, number[]>();
  for (const entry of processes) {
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(entry.pid);
    childrenByParent.set(entry.ppid, children);
  }

  const targetPids = new Set<number>();
  for (const wrapperPid of duplicateWrapperPids) {
    for (const pid of collectSubtreePids(wrapperPid, childrenByParent)) {
      if (pid !== currentPid && pid !== parentPid && pid > 1) {
        targetPids.add(pid);
      }
    }
  }

  if (targetPids.size === 0) {
    return {
      duplicateWrapperPids,
      terminatedPids: []
    };
  }

  const sortedTargets = Array.from(targetPids).sort((a, b) => b - a);
  logger.info('Killing duplicate clangd MCP wrapper subtrees:', sortedTargets);

  for (const pid of sortedTargets) {
    try {
      signalProcess(pid, 'SIGTERM');
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        logger.warn(`Failed to SIGTERM pid ${pid}:`, error);
      }
    }
  }

  await sleep(termGraceMs);

  for (const pid of sortedTargets) {
    try {
      signalProcess(pid, 0);
    } catch (error: any) {
      if (error?.code === 'ESRCH') {
        continue;
      }
      logger.warn(`Failed to probe pid ${pid}:`, error);
      continue;
    }

    try {
      signalProcess(pid, 'SIGKILL');
    } catch (error: any) {
      if (error?.code !== 'ESRCH') {
        logger.warn(`Failed to SIGKILL pid ${pid}:`, error);
      }
    }
  }

  return {
    duplicateWrapperPids,
    terminatedPids: sortedTargets
  };
}
