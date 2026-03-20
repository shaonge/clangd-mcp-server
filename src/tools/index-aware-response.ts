// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { BackgroundIndexStatus } from '../clangd-manager.js';

export interface IndexAwareToolOptions {
  getBackgroundIndexStatus?: () => BackgroundIndexStatus;
}

interface IndexAwareResponseContext {
  operation: string;
  resultEmpty: boolean;
}

interface IndexAwareResponseExtras {
  index_status?: BackgroundIndexStatus;
  note?: string;
  result_confidence?: 'low' | 'medium' | 'high';
  empty_result_is_authoritative?: boolean;
}

export function getIndexAwareResponseExtras(
  options: IndexAwareToolOptions | undefined,
  context: IndexAwareResponseContext
): IndexAwareResponseExtras {
  const status = options?.getBackgroundIndexStatus?.();
  if (!status) {
    return {};
  }

  const includeMetadata = status.state !== 'completed' || context.resultEmpty;
  const note = includeMetadata
    ? getBackgroundIndexNote(status, context.operation, context.resultEmpty)
    : undefined;

  return {
    ...(includeMetadata ? { index_status: status } : {}),
    ...(includeMetadata ? { result_confidence: getResultConfidence(status, context.resultEmpty) } : {}),
    ...(context.resultEmpty ? { empty_result_is_authoritative: false } : {}),
    ...(note ? { note } : {})
  };
}

function getResultConfidence(
  status: BackgroundIndexStatus,
  resultEmpty: boolean
): 'low' | 'medium' | 'high' {
  if (status.state === 'completed' && !resultEmpty) {
    return 'high';
  }

  return resultEmpty ? 'low' : 'medium';
}

function getBackgroundIndexNote(
  status: BackgroundIndexStatus,
  operation: string,
  resultEmpty: boolean
): string | undefined {
  switch (status.state) {
    case 'disabled':
      return `Background indexing is disabled. ${operation} may miss cross-file results.`;
    case 'indexing':
      return `Background indexing is in progress. ${operation} may be incomplete until indexing settles.`;
    case 'partial':
      return `Background indexing has not reached confirmed full workspace coverage yet. ${operation} may be incomplete.`;
    case 'completed':
      return resultEmpty
        ? `Background indexing activity appears complete, but full workspace coverage is inferred from clangd progress only. ${operation} may still miss cross-file results.`
        : undefined;
  }
}
