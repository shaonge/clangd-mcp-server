// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { existsSync, createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from './utils/logger.js';

export interface ClangdConfig {
  clangdPath: string;
  clangdArgs: string[];
  projectRoot: string;
  compileCommandsPath?: string;
  isChromiumProject: boolean;
}

/**
 * Detect if project is a Chromium project by checking for bundled clangd
 * Only consider it a Chromium project if the bundled clangd exists,
 * since that's what we need for Chromium-specific behavior
 */
function detectChromiumProject(projectRoot: string): boolean {
  const chromiumClangdPaths = [
    'third_party/llvm-build/Release+Asserts/bin/clangd',
    'third_party/llvm-build/Release+Asserts/bin/clangd.exe',
    'third_party/llvm-build/Release/bin/clangd',
    'third_party/llvm-build/Release/bin/clangd.exe',
  ];

  return chromiumClangdPaths.some(path =>
    existsSync(join(projectRoot, path))
  );
}

/**
 * Get clangd version string
 */
function getClangdVersion(clangdPath: string): string | undefined {
  try {
    const result = spawnSync(clangdPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    });

    if (result.status === 0 && result.stdout) {
      // Extract version from output like "clangd version 18.1.3" or "clangd version 22.0.0git"
      const match = result.stdout.match(/clangd version ([\d.]+\w*)/);
      if (match) {
        return match[1];
      }
    }
  } catch (error) {
    logger.debug('Failed to get clangd version:', error);
  }
  return undefined;
}

/**
 * Find project's bundled clangd binary
 * Currently supports auto-detection for Chromium projects
 */
function findProjectBundledClangd(projectRoot: string, isChromiumProject: boolean): string | undefined {
  // Auto-detect Chromium bundled clangd
  if (isChromiumProject) {
    const searchPaths = [
      'third_party/llvm-build/Release+Asserts/bin/clangd',
      'third_party/llvm-build/Release+Asserts/bin/clangd.exe',
      'third_party/llvm-build/Release/bin/clangd',
      'third_party/llvm-build/Release/bin/clangd.exe',
    ];

    for (const searchPath of searchPaths) {
      const fullPath = join(projectRoot, searchPath);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return undefined;
}

/**
 * Detect project configuration and generate appropriate clangd settings
 */
export function detectConfiguration(): ClangdConfig {
  // Get project root from environment or use cwd
  const projectRoot = resolve(process.env.PROJECT_ROOT || process.cwd());
  logger.info('Project root:', projectRoot);

  // Check if this is a Chromium project using multiple detection strategies
  const isChromiumProject = detectChromiumProject(projectRoot);
  if (isChromiumProject) {
    logger.info('Detected Chromium project');
  }

  // Find clangd binary
  // Priority: CLANGD_PATH env > project bundled clangd (required)
  let clangdPath: string;
  if (process.env.CLANGD_PATH) {
    clangdPath = process.env.CLANGD_PATH;
    logger.info('Using clangd from CLANGD_PATH:', clangdPath);
  } else {
    const projectClangd = findProjectBundledClangd(projectRoot, isChromiumProject);
    if (projectClangd) {
      clangdPath = projectClangd;
      logger.info('Using project bundled clangd:', clangdPath);
    } else {
      throw new Error(
        'clangd not found. Expected bundled clangd at third_party/llvm-build/Release+Asserts/bin/clangd ' +
        `under project root ${projectRoot}. Set CLANGD_PATH environment variable to specify a custom clangd path.`
      );
    }
  }

  if (process.platform === 'win32' && !clangdPath.endsWith('.exe')) {
    clangdPath += '.exe';
  }
  logger.info('Using clangd path:', clangdPath);

  // Detect and log clangd version
  const version = getClangdVersion(clangdPath);
  if (version) {
    logger.info(`Clangd version: ${version}`);
  } else {
    logger.warn('Could not detect clangd version');
  }

  // Find compile_commands.json
  const compileCommandsPath = findCompileCommands(projectRoot);
  if (compileCommandsPath) {
    logger.info('Found compile_commands.json at:', compileCommandsPath);
  } else {
    logger.warn('compile_commands.json not found - clangd may not work correctly');
  }

  // Generate clangd arguments
  const clangdArgs = generateClangdArgs(isChromiumProject, compileCommandsPath);
  logger.info('Clangd arguments:', clangdArgs.join(' '));

  return {
    clangdPath,
    clangdArgs,
    projectRoot,
    compileCommandsPath,
    isChromiumProject
  };
}

/**
 * Search for compile_commands.json in standard locations
 */
function findCompileCommands(projectRoot: string): string | undefined {
  // Check explicit environment variable first
  if (process.env.COMPILE_COMMANDS_DIR) {
    const explicitPath = resolve(process.env.COMPILE_COMMANDS_DIR, 'compile_commands.json');
    if (existsSync(explicitPath)) {
      return explicitPath;
    }
  }

  // Search standard locations
  const searchPaths = [
    'compile_commands.json',
    'build/compile_commands.json',
    'out/Default/compile_commands.json',
    'out/Release/compile_commands.json',
    'out/Debug/compile_commands.json',
    '.build/compile_commands.json'
  ];

  for (const searchPath of searchPaths) {
    const fullPath = join(projectRoot, searchPath);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return undefined;
}

/**
 * Parse shell arguments handling quotes and escapes
 */
function parseShellArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && (inDoubleQuote || !inSingleQuote)) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (char === ' ' && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Generate appropriate clangd arguments based on project type
 */
function generateClangdArgs(isChromiumProject: boolean, compileCommandsPath?: string): string[] {
  const args: string[] = [];

  // Parse additional args from environment
  if (process.env.CLANGD_ARGS) {
    args.push(...parseShellArgs(process.env.CLANGD_ARGS));
  }

  // Add compile commands path if found
  if (compileCommandsPath) {
    // Use dirname to properly extract directory on all platforms
    args.push(`--compile-commands-dir=${dirname(compileCommandsPath)}`);
  }

  // Enable background indexing by default so that workspace/symbol can work.
  // Without background indexing, workspace/symbol can only search the dynamic
  // index (opened files), making it nearly useless on cold start.
  // Users can override via CLANGD_ARGS (e.g. --background-index=false).
  if (!args.some(arg => arg.startsWith('--background-index'))) {
    args.push('--background-index=true');
  }

  // For Chromium projects, suggest remote index server
  if (isChromiumProject) {
    if (!args.some(arg => arg.startsWith('--remote-index-address'))) {
      logger.info('Consider setting up a remote index server for better performance on Chromium');
    }
  }

  // Limit results for all queries
  if (!args.some(arg => arg.startsWith('--limit-references'))) {
    args.push('--limit-references=1000');
  }

  if (!args.some(arg => arg.startsWith('--limit-results'))) {
    args.push('--limit-results=1000');
  }

  // // Always enable malloc trim for long-running instances
  // if (!args.some(arg => arg.includes('malloc-trim'))) {
  //   args.push('--malloc-trim');
  // }

  // Improve performance
  if (!args.some(arg => arg.startsWith('--pch-storage'))) {
    args.push('--pch-storage=memory');
  }

  if (!args.some(arg => arg.startsWith('--clang-tidy'))) {
    args.push('--clang-tidy=false'); // Disable for performance
  }

  // Limit background index threads to avoid hogging CPU
  if (!args.some(arg => arg.startsWith('-j') || arg.startsWith('--background-index-threads'))) {
    args.push('-j=2');
  }

  // Log level
  if (!args.some(arg => arg.startsWith('--log'))) {
    const logLevel = process.env.CLANGD_LOG_LEVEL || 'info';
    args.push(`--log=${logLevel}`);
  }

  return args;
}

/**
 * Extract the first source file path from compile_commands.json.
 * Uses streaming to avoid loading the entire (potentially 100s of MB) file.
 * This file is used as a "seed" to trigger clangd's lazy compilation database
 * loading, which in turn starts the background indexer.
 */
export async function getFirstFileFromCompileCommands(
  compileCommandsPath: string
): Promise<string | undefined> {
  try {
    const stream = createReadStream(compileCommandsPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    let currentEntryLines: string[] = [];
    let braceDepth = 0;

    for await (const line of rl) {
      const openBraces = (line.match(/{/g) || []).length;
      const closeBraces = (line.match(/}/g) || []).length;

      if (braceDepth > 0 || openBraces > 0) {
        currentEntryLines.push(line);
      }

      braceDepth += openBraces - closeBraces;
      if (currentEntryLines.length === 0 || braceDepth !== 0) {
        continue;
      }

      const entryText = currentEntryLines.join('\n');
      currentEntryLines = [];

      const directory = extractJsonStringField(entryText, 'directory');
      const file = extractJsonStringField(entryText, 'file');
      if (!file || !isSupportedCompileCommandSource(file)) {
        continue;
      }

      let filePath = file;
      if (!filePath.startsWith('/') && directory) {
        filePath = resolve(directory, filePath);
      }

      if (existsSync(filePath)) {
        rl.close();
        stream.destroy();
        return filePath;
      }

      logger.warn('Compile command source file does not exist, trying next entry:', filePath);
    }
  } catch (error) {
    logger.warn('Failed to read compile_commands.json for seed file:', error);
  }
  return undefined;
}

function extractJsonStringField(entryText: string, fieldName: string): string | undefined {
  const match = entryText.match(new RegExp(`"${fieldName}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's'));
  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return undefined;
  }
}

function isSupportedCompileCommandSource(filePath: string): boolean {
  return /\.(?:c|cc|cp|cpp|cxx|c\+\+|C|CC|CPP|CXX)$/.test(filePath);
}
