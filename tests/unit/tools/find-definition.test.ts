// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { findDefinition } from '../../../src/tools/find-definition.js';
import { LSPClient } from '../../../src/lsp-client.js';
import { FileTracker } from '../../../src/file-tracker.js';

describe('findDefinition', () => {
  const fileTracker = {
    ensureFileOpen: jest.fn(async () => 'file:///tmp/test.cpp')
  } as unknown as FileTracker;

  it('returns formatted location when definition is found', async () => {
    const client = {
      request: jest.fn(async () => ({
        uri: 'file:///tmp/header.h',
        range: {
          start: { line: 20, character: 4 },
          end: { line: 20, character: 12 }
        }
      }))
    } as unknown as LSPClient;

    const result = await findDefinition(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(client.request).toHaveBeenCalledWith('textDocument/definition', {
      textDocument: { uri: 'file:///tmp/test.cpp' },
      position: { line: 10, character: 5 }
    });
    expect(parsed).toEqual({
      found: true,
      count: 1,
      locations: [{
        file: '/tmp/header.h',
        line: 21,
        column: 5,
        uri: 'file:///tmp/header.h'
      }]
    });
  });

  it('handles multiple definition locations (e.g. overloads)', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          uri: 'file:///tmp/a.h',
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 10 }
          }
        },
        {
          uri: 'file:///tmp/b.h',
          range: {
            start: { line: 15, character: 2 },
            end: { line: 15, character: 12 }
          }
        }
      ])
    } as unknown as LSPClient;

    const result = await findDefinition(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.locations).toHaveLength(2);
    expect(parsed.locations[0].file).toBe('/tmp/a.h');
    expect(parsed.locations[0].line).toBe(6);
    expect(parsed.locations[0].column).toBe(1);
    expect(parsed.locations[1].file).toBe('/tmp/b.h');
    expect(parsed.locations[1].line).toBe(16);
    expect(parsed.locations[1].column).toBe(3);
  });

  it('returns not-found when no definition exists', async () => {
    const client = {
      request: jest.fn(async () => null)
    } as unknown as LSPClient;

    const result = await findDefinition(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      found: false,
      message: 'No definition found'
    });
  });

  it('returns not-found for empty array result', async () => {
    const client = {
      request: jest.fn(async () => [])
    } as unknown as LSPClient;

    const result = await findDefinition(client, fileTracker, '/tmp/test.cpp', 10, 5);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(false);
    expect(parsed.message).toBe('No definition found');
  });
});
