// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect, jest } from '@jest/globals';
import { getDocumentSymbols } from '../../../src/tools/document-symbols.js';
import { LSPClient } from '../../../src/lsp-client.js';
import { FileTracker } from '../../../src/file-tracker.js';

describe('getDocumentSymbols', () => {
  const fileTracker = {
    ensureFileOpen: jest.fn(async () => 'file:///tmp/test.cpp')
  } as unknown as FileTracker;

  it('returns formatted symbols for a file', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          name: 'MyClass',
          kind: 5, // Class
          range: {
            start: { line: 0, character: 0 },
            end: { line: 20, character: 1 }
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 }
          }
        }
      ])
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(client.request).toHaveBeenCalledWith('textDocument/documentSymbol', {
      textDocument: { uri: 'file:///tmp/test.cpp' }
    });
    expect(parsed).toEqual({
      found: true,
      count: 1,
      symbols: [{
        name: 'MyClass',
        kind: 'Class',
        line: 1,
        column: 1,
        endLine: 21,
        endColumn: 2
      }]
    });
  });

  it('handles nested symbols (class with methods)', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          name: 'MyClass',
          kind: 5,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 20, character: 1 }
          },
          selectionRange: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 }
          },
          children: [
            {
              name: 'doSomething',
              kind: 6, // Method
              range: {
                start: { line: 5, character: 2 },
                end: { line: 10, character: 3 }
              },
              selectionRange: {
                start: { line: 5, character: 7 },
                end: { line: 5, character: 18 }
              }
            },
            {
              name: 'value_',
              kind: 8, // Field
              range: {
                start: { line: 15, character: 2 },
                end: { line: 15, character: 14 }
              },
              selectionRange: {
                start: { line: 15, character: 6 },
                end: { line: 15, character: 12 }
              }
            }
          ]
        }
      ])
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.count).toBe(3); // 1 class + 2 children
    expect(parsed.symbols).toHaveLength(1);
    expect(parsed.symbols[0].name).toBe('MyClass');
    expect(parsed.symbols[0].children).toHaveLength(2);
    expect(parsed.symbols[0].children[0].name).toBe('doSomething');
    expect(parsed.symbols[0].children[0].kind).toBe('Method');
    expect(parsed.symbols[0].children[0].line).toBe(6);
    expect(parsed.symbols[0].children[0].column).toBe(3);
    expect(parsed.symbols[0].children[1].name).toBe('value_');
    expect(parsed.symbols[0].children[1].kind).toBe('Field');
  });

  it('returns not-found for empty results', async () => {
    const client = {
      request: jest.fn(async () => [])
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(parsed).toEqual({
      found: false,
      message: 'No symbols found in document'
    });
  });

  it('returns not-found for null result', async () => {
    const client = {
      request: jest.fn(async () => null)
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(false);
  });

  it('handles unknown symbol kinds gracefully', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          name: 'UnknownThing',
          kind: 999,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 12 }
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 12 }
          }
        }
      ])
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(parsed.found).toBe(true);
    expect(parsed.symbols[0].kind).toBe('Unknown(999)');
  });

  it('counts deeply nested symbols correctly', async () => {
    const client = {
      request: jest.fn(async () => [
        {
          name: 'Outer',
          kind: 3, // Namespace
          range: { start: { line: 0, character: 0 }, end: { line: 30, character: 1 } },
          selectionRange: { start: { line: 0, character: 10 }, end: { line: 0, character: 15 } },
          children: [
            {
              name: 'Inner',
              kind: 5, // Class
              range: { start: { line: 2, character: 2 }, end: { line: 28, character: 3 } },
              selectionRange: { start: { line: 2, character: 8 }, end: { line: 2, character: 13 } },
              children: [
                {
                  name: 'method',
                  kind: 6, // Method
                  range: { start: { line: 5, character: 4 }, end: { line: 10, character: 5 } },
                  selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 15 } }
                }
              ]
            }
          ]
        }
      ])
    } as unknown as LSPClient;

    const result = await getDocumentSymbols(client, fileTracker, '/tmp/test.cpp');
    const parsed = JSON.parse(result);

    expect(parsed.count).toBe(3); // Outer + Inner + method
  });
});
