// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { getHover } from '../../../src/tools/get-hover.js';
import { LSPClient } from '../../../src/lsp-client.js';
import { FileTracker } from '../../../src/file-tracker.js';

describe('getHover', () => {
  const fileTracker = {
    ensureFileOpen: jest.fn(async () => 'file:///tmp/test.cpp')
  } as unknown as FileTracker;

  it('returns hover with markdown content and range', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: { kind: 'markdown', value: '```cpp\nint x\n```' },
        range: {
          start: { line: 10, character: 4 },
          end: { line: 10, character: 5 }
        }
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(client.request).toHaveBeenCalledWith('textDocument/hover', {
      textDocument: { uri: 'file:///tmp/test.cpp' },
      position: { line: 10, character: 5 }
    });
    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('```cpp\nint x\n```');
    expect(parsed.range).toEqual({
      start: { line: 11, column: 5 },
      end: { line: 11, column: 6 }
    });
  });

  it('returns hover with plaintext content', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: { kind: 'plaintext', value: 'int x' }
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('int x');
    expect(parsed.range).toBeUndefined();
  });

  it('returns hover with language-tagged content', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: { language: 'cpp', value: 'void foo()' }
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('```cpp\nvoid foo()\n```');
  });

  it('returns hover with plain string content', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: 'simple string hover'
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('simple string hover');
  });

  it('returns hover with array content (joined by newlines)', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: [
          { kind: 'markdown', value: '**Type:** int' },
          'some text'
        ]
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('**Type:** int\n\nsome text');
  });

  it('returns hover with content having only value property', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: { value: 'fallback value content' }
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('fallback value content');
  });

  it('falls back to JSON.stringify for unrecognized content format', async () => {
    const client = {
      request: jest.fn(async () => ({
        contents: { unknown: 'format' }
      }))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.contents).toBe('{"unknown":"format"}');
  });

  it('returns not-found when result is null', async () => {
    const client = {
      request: jest.fn(async () => null)
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      found: false,
      message: 'No hover information found'
    });
  });

  it('returns not-found when result has no contents', async () => {
    const client = {
      request: jest.fn(async () => ({}))
    } as unknown as LSPClient;

    const result = await getHover(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(false);
  });
});
