// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { findReferences } from '../../../src/tools/find-references.js';
import { findImplementations } from '../../../src/tools/find-implementations.js';
import { LSPClient } from '../../../src/lsp-client.js';
import { FileTracker } from '../../../src/file-tracker.js';
import type { BackgroundIndexStatus } from '../../../src/clangd-manager.js';

describe('index-aware cross-file tools', () => {
  const fileTracker = {
    ensureFileOpen: jest.fn(async () => 'file:///tmp/test.cpp')
  } as unknown as FileTracker;

  it('adds a partial-index note to reference results', async () => {
    const client = {
      request: jest.fn(async () => [{
        uri: 'file:///tmp/ref.cpp',
        range: {
          start: { line: 3, character: 2 },
          end: { line: 3, character: 8 }
        }
      }])
    } as unknown as LSPClient;
    const status: BackgroundIndexStatus = {
      state: 'partial',
      enabled: true,
      in_progress: false,
      progress_percentage: 80
    };

    const result = await findReferences(client, fileTracker, '/tmp/test.cpp', 10, 5, true, {
      getBackgroundIndexStatus: () => status,
      getBackgroundIndexCompletionBasis: () => 'none'
    });
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.note).toContain('Reference search may be incomplete');
  });

  it('adds an indexing note to implementation results', async () => {
    const client = {
      request: jest.fn(async () => [{
        uri: 'file:///tmp/impl.cpp',
        range: {
          start: { line: 7, character: 1 },
          end: { line: 7, character: 9 }
        }
      }])
    } as unknown as LSPClient;
    const status: BackgroundIndexStatus = {
      state: 'indexing',
      enabled: true,
      in_progress: true,
      progress_percentage: 45
    };

    const result = await findImplementations(client, fileTracker, '/tmp/test.cpp', 10, 5, {
      getBackgroundIndexStatus: () => status,
      getBackgroundIndexCompletionBasis: () => 'none'
    });
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.note).toContain('Implementation search may be incomplete');
  });
});
