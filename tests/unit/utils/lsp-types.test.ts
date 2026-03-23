// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from '@jest/globals';
import { normalizeLocationResult, symbolKindNames } from '../../../src/utils/lsp-types.js';

describe('normalizeLocationResult', () => {
  it('returns empty array for null', () => {
    expect(normalizeLocationResult(null)).toEqual([]);
  });

  it('returns empty array for undefined', () => {
    expect(normalizeLocationResult(undefined)).toEqual([]);
  });

  it('wraps single Location into array', () => {
    const location = {
      uri: 'file:///tmp/test.cpp',
      range: {
        start: { line: 10, character: 5 },
        end: { line: 10, character: 15 }
      }
    };

    const result = normalizeLocationResult(location);
    expect(result).toEqual([location]);
  });

  it('returns Location array as-is', () => {
    const locations = [
      {
        uri: 'file:///tmp/a.cpp',
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }
      },
      {
        uri: 'file:///tmp/b.cpp',
        range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } }
      }
    ];

    const result = normalizeLocationResult(locations);
    expect(result).toBe(locations); // same reference
  });

  it('returns empty array as-is', () => {
    const result = normalizeLocationResult([]);
    expect(result).toEqual([]);
  });
});

describe('symbolKindNames', () => {
  it('maps standard LSP symbol kinds', () => {
    expect(symbolKindNames[1]).toBe('File');
    expect(symbolKindNames[5]).toBe('Class');
    expect(symbolKindNames[6]).toBe('Method');
    expect(symbolKindNames[12]).toBe('Function');
    expect(symbolKindNames[13]).toBe('Variable');
    expect(symbolKindNames[23]).toBe('Struct');
    expect(symbolKindNames[26]).toBe('TypeParameter');
  });

  it('returns undefined for unknown kinds', () => {
    expect(symbolKindNames[0]).toBeUndefined();
    expect(symbolKindNames[99]).toBeUndefined();
  });
});
