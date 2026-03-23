// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { workspaceSymbolSearch } from '../../../src/tools/workspace-symbol.js';
import { LSPClient } from '../../../src/lsp-client.js';

describe('workspaceSymbolSearch', () => {
  it('formats workspace symbol results', async () => {
    const client = {
      request: jest.fn(async () => [{
        name: 'StartupExtra',
        kind: 5,
        location: {
          uri: 'file:///tmp/startup_extra.h',
          range: {
            start: { line: 10, character: 4 },
            end: { line: 10, character: 16 }
          }
        },
        containerName: 'blink'
      }])
    } as unknown as LSPClient;

    const result = await workspaceSymbolSearch(client, 'StartupExtra', 100);
    const parsed = JSON.parse(result);

    expect(client.request).toHaveBeenCalledWith('workspace/symbol', { query: 'StartupExtra' });
    expect(parsed).toEqual({
      found: true,
      count: 1,
      returned: 1,
      truncated: false,
      symbols: [{
        name: 'StartupExtra',
        kind: 'Class',
        file: '/tmp/startup_extra.h',
        line: 11,
        column: 5,
        container: 'blink',
        uri: 'file:///tmp/startup_extra.h'
      }]
    });
  });

  it('truncates results to the requested limit', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          name: 'A',
          kind: 12,
          location: {
            uri: 'file:///tmp/a.cc',
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 }
            }
          }
        },
        {
          name: 'B',
          kind: 12,
          location: {
            uri: 'file:///tmp/b.cc',
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 1 }
            }
          }
        }
      ])
    } as unknown as LSPClient;

    const result = await workspaceSymbolSearch(client, 'A', 1);
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.returned).toBe(1);
    expect(parsed.truncated).toBe(true);
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0].name).toBe('A');
  });

  it('returns a not-found response for empty results', async () => {
    const client = {
      request: jest.fn(async () => [])
    } as unknown as LSPClient;

    const result = await workspaceSymbolSearch(client, 'DefinitelyMissing', 100);
    const parsed = JSON.parse(result);

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(parsed).toEqual({
      found: false,
      message: "No symbols found matching 'DefinitelyMissing'"
    });
  });
});
