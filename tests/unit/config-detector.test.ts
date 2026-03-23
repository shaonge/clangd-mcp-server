// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Config detector', () => {
  let testDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    testDir = join(tmpdir(), `clangd-mcp-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });

    originalEnv = { ...process.env };
    process.env = { ...process.env };
    delete process.env.PROJECT_ROOT;
    delete process.env.COMPILE_COMMANDS_DIR;
    delete process.env.CLANGD_ARGS;
    delete process.env.CLANGD_LOG_LEVEL;
    process.env.CLANGD_PATH = '/custom/path/to/clangd';
    process.env.LOG_LEVEL = 'ERROR';

    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    consoleErrorSpy.mockRestore();

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  async function loadConfigDetector() {
    jest.resetModules();
    return import('../../src/config-detector.js');
  }

  function createBundledClangd(root: string = testDir): string {
    const clangdDir = join(root, 'third_party', 'llvm-build', 'Release+Asserts', 'bin');
    mkdirSync(clangdDir, { recursive: true });
    const clangdPath = join(clangdDir, 'clangd');
    writeFileSync(clangdPath, '#!/bin/sh\nexit 0\n');
    return clangdPath;
  }

  it('uses PROJECT_ROOT from environment', async () => {
    process.env.PROJECT_ROOT = testDir;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.projectRoot).toBe(testDir);
  });

  it('falls back to cwd when PROJECT_ROOT is not set', async () => {
    const originalCwd = process.cwd();
    process.chdir(testDir);

    try {
      const { detectConfiguration } = await loadConfigDetector();
      const config = detectConfiguration();
      expect(config.projectRoot).toBe(process.cwd());
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('uses CLANGD_PATH when provided', async () => {
    process.env.PROJECT_ROOT = testDir;
    process.env.CLANGD_PATH = '/another/custom/clangd';
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.clangdPath).toBe('/another/custom/clangd');
  });

  it('requires bundled clangd when CLANGD_PATH is not set', async () => {
    process.env.PROJECT_ROOT = testDir;
    delete process.env.CLANGD_PATH;
    const { detectConfiguration } = await loadConfigDetector();

    expect(() => detectConfiguration()).toThrow(/PATH fallback is intentionally disabled/);
    expect(() => detectConfiguration()).toThrow(/Set CLANGD_PATH/);
  });

  it('detects Chromium project and uses bundled clangd', async () => {
    const bundledClangd = createBundledClangd();
    process.env.PROJECT_ROOT = testDir;
    delete process.env.CLANGD_PATH;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.isChromiumProject).toBe(true);
    expect(config.clangdPath).toBe(bundledClangd);
  });

  it('does not mark the project as Chromium without bundled clangd', async () => {
    process.env.PROJECT_ROOT = testDir;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.isChromiumProject).toBe(false);
    expect(config.clangdPath).toBe('/custom/path/to/clangd');
  });

  it('prefers CLANGD_PATH over bundled clangd', async () => {
    createBundledClangd();
    process.env.PROJECT_ROOT = testDir;
    process.env.CLANGD_PATH = '/preferred/clangd';
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.clangdPath).toBe('/preferred/clangd');
  });

  it('finds compile_commands.json in standard locations', async () => {
    const buildDir = join(testDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'compile_commands.json'), '[]');
    process.env.PROJECT_ROOT = testDir;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.compileCommandsPath).toBe(join(buildDir, 'compile_commands.json'));
  });

  it('respects COMPILE_COMMANDS_DIR when set', async () => {
    const customDir = join(testDir, 'custom');
    mkdirSync(customDir, { recursive: true });
    writeFileSync(join(customDir, 'compile_commands.json'), '[]');
    process.env.PROJECT_ROOT = testDir;
    process.env.COMPILE_COMMANDS_DIR = customDir;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.compileCommandsPath).toBe(join(customDir, 'compile_commands.json'));
  });

  it('adds compile command and indexing defaults', async () => {
    const buildDir = join(testDir, 'build');
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, 'compile_commands.json'), '[]');
    process.env.PROJECT_ROOT = testDir;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.clangdArgs).toContain(`--compile-commands-dir=${buildDir}`);
    expect(config.clangdArgs).toContain('--background-index=true');
    expect(config.clangdArgs).toContain('--limit-references=1000');
    expect(config.clangdArgs).toContain('--limit-results=1000');
    expect(config.clangdArgs).toContain('--pch-storage=memory');
    expect(config.clangdArgs).toContain('--clang-tidy=false');
    expect(config.clangdArgs).toContain('-j=2');
    expect(config.clangdArgs).toContain('--log=info');
  });

  it('does not override explicit indexing-related arguments', async () => {
    process.env.PROJECT_ROOT = testDir;
    process.env.CLANGD_ARGS = '--background-index=false -j=8 --log=verbose';
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.clangdArgs).toContain('--background-index=false');
    expect(config.clangdArgs).not.toContain('--background-index=true');
    expect(config.clangdArgs).toContain('-j=8');
    expect(config.clangdArgs).not.toContain('-j=2');
    expect(config.clangdArgs).toContain('--log=verbose');
  });

  it('uses CLANGD_LOG_LEVEL when no explicit --log argument is provided', async () => {
    process.env.PROJECT_ROOT = testDir;
    process.env.CLANGD_LOG_LEVEL = 'verbose';
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.clangdArgs).toContain('--log=verbose');
  });

  it('detects Chromium projects opened at the src directory', async () => {
    const srcDir = join(testDir, 'chromium', 'src');
    createBundledClangd(srcDir);
    process.env.PROJECT_ROOT = srcDir;
    delete process.env.CLANGD_PATH;
    const { detectConfiguration } = await loadConfigDetector();

    const config = detectConfiguration();
    expect(config.isChromiumProject).toBe(true);
    expect(config.clangdPath).toBe(join(srcDir, 'third_party', 'llvm-build', 'Release+Asserts', 'bin', 'clangd'));
  });

  describe('getFirstFileFromCompileCommands', () => {
    it('returns the first existing C-family source file', async () => {
      const buildDir = join(testDir, 'out', 'Default');
      const srcDir = join(testDir, 'src');
      mkdirSync(buildDir, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'keep.h'), '// header');
      writeFileSync(join(srcDir, 'main.cc'), 'int main() { return 0; }');
      writeFileSync(
        join(buildDir, 'compile_commands.json'),
        [
          '[',
          '  {',
          `    "directory": ${JSON.stringify(testDir)},`,
          `    "file": ${JSON.stringify('src/keep.h')}`,
          '  },',
          '  {',
          `    "directory": ${JSON.stringify(testDir)},`,
          `    "file": ${JSON.stringify('src/main.cc')}`,
          '  }',
          ']'
        ].join('\n')
      );

      const { getFirstFileFromCompileCommands } = await loadConfigDetector();
      const firstFile = await getFirstFileFromCompileCommands(join(buildDir, 'compile_commands.json'));

      expect(firstFile).toBe(join(testDir, 'src', 'main.cc'));
    });

    it('returns undefined when no usable source file is found', async () => {
      const buildDir = join(testDir, 'out', 'Default');
      mkdirSync(buildDir, { recursive: true });
      writeFileSync(
        join(buildDir, 'compile_commands.json'),
        [
          '[',
          '  {',
          `    "directory": ${JSON.stringify(testDir)},`,
          `    "file": ${JSON.stringify('src/only_header.h')}`,
          '  }',
          ']'
        ].join('\n')
      );

      const { getFirstFileFromCompileCommands } = await loadConfigDetector();
      const firstFile = await getFirstFileFromCompileCommands(join(buildDir, 'compile_commands.json'));

      expect(firstFile).toBeUndefined();
    });

    it('continues scanning when the first candidate source file is missing', async () => {
      const buildDir = join(testDir, 'out', 'Default');
      const srcDir = join(testDir, 'src');
      mkdirSync(buildDir, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'real.cxx'), 'int answer() { return 42; }');
      writeFileSync(
        join(buildDir, 'compile_commands.json'),
        [
          '[',
          '  {',
          `    "directory": ${JSON.stringify(testDir)},`,
          `    "file": ${JSON.stringify('src/missing.cc')}`,
          '  },',
          '  {',
          `    "directory": ${JSON.stringify(testDir)},`,
          `    "file": ${JSON.stringify('src/real.cxx')}`,
          '  }',
          ']'
        ].join('\n')
      );

      const { getFirstFileFromCompileCommands } = await loadConfigDetector();
      const firstFile = await getFirstFileFromCompileCommands(join(buildDir, 'compile_commands.json'));

      expect(firstFile).toBe(join(testDir, 'src', 'real.cxx'));
    });

    it('handles entries where file appears before directory', async () => {
      const buildDir = join(testDir, 'out', 'Default');
      const srcDir = join(testDir, 'src');
      mkdirSync(buildDir, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      writeFileSync(join(srcDir, 'main.C'), 'int main() { return 0; }');
      writeFileSync(
        join(buildDir, 'compile_commands.json'),
        [
          '[',
          '  {',
          `    "file": ${JSON.stringify('src/main.C')},`,
          `    "directory": ${JSON.stringify(testDir)}`,
          '  }',
          ']'
        ].join('\n')
      );

      const { getFirstFileFromCompileCommands } = await loadConfigDetector();
      const firstFile = await getFirstFileFromCompileCommands(join(buildDir, 'compile_commands.json'));

      expect(firstFile).toBe(join(testDir, 'src', 'main.C'));
    });
  });
});
