// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, it, expect } from '@jest/globals';
import { getIndexAwareResponseExtras } from '../../../src/tools/index-aware-response.js';
import type { BackgroundIndexStatus } from '../../../src/clangd-manager.js';

describe('index-aware-response', () => {
  it('marks empty results as non-authoritative while indexing is partial', () => {
    const status: BackgroundIndexStatus = {
      state: 'partial',
      enabled: true,
      in_progress: false,
      progress_percentage: 75
    };

    const result = getIndexAwareResponseExtras(
      {
        getBackgroundIndexStatus: () => status,
        getBackgroundIndexCompletionBasis: () => 'none'
      },
      { operation: 'Reference search', resultEmpty: true }
    );

    expect(result).toEqual({
      note: 'Background indexing has not reached confirmed full workspace coverage yet. Reference search may be incomplete.'
    });
  });

  it('keeps completed empty results non-authoritative because completion is heuristic', () => {
    const status: BackgroundIndexStatus = {
      state: 'completed',
      enabled: true,
      in_progress: false,
      progress_percentage: 100,
      indexed_files: 12,
      total_files: 12
    };

    const result = getIndexAwareResponseExtras(
      {
        getBackgroundIndexStatus: () => status,
        getBackgroundIndexCompletionBasis: () => 'progress'
      },
      { operation: 'Definition lookup', resultEmpty: true }
    );

    expect(result).toEqual({
      note: 'Background indexing activity appears complete, but full workspace coverage is inferred from clangd progress only. Definition lookup may still miss cross-file results.'
    });
  });

  it('keeps successful completed results clean', () => {
    const status: BackgroundIndexStatus = {
      state: 'completed',
      enabled: true,
      in_progress: false
    };

    const result = getIndexAwareResponseExtras(
      {
        getBackgroundIndexStatus: () => status,
        getBackgroundIndexCompletionBasis: () => 'progress'
      },
      { operation: 'Call hierarchy', resultEmpty: false }
    );

    expect(result).toEqual({});
  });
});
