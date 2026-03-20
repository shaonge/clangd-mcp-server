// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { getIndexAwareResponseExtras, type IndexAwareToolOptions } from './index-aware-response.js';
import { uriToPath } from '../utils/uri.js';
import { withRetry } from '../utils/errors.js';
import {
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  symbolKindNames
} from '../utils/lsp-types.js';
import { fetchTwoPhaseHierarchy } from '../utils/hierarchy-helper.js';

export async function getCallHierarchy(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number,
  options: IndexAwareToolOptions = {}
): Promise<string> {
  // Ensure file is opened
  const uri = await fileTracker.ensureFileOpen(filePath);

  // Fetch call hierarchy with retry
  const result = await withRetry(async () => {
    return await fetchTwoPhaseHierarchy<
      CallHierarchyItem,
      CallHierarchyIncomingCall,
      CallHierarchyOutgoingCall
    >(
      lspClient,
      'textDocument/prepareCallHierarchy',
      'callHierarchy/incomingCalls',
      'callHierarchy/outgoingCalls',
      uri,
      { line, character: column }
    );
  });

  // Handle no hierarchy available
  if (!result) {
    return JSON.stringify({
      found: false,
      message: 'No call hierarchy available at this position',
      ...getIndexAwareResponseExtras(options, {
        operation: 'Call hierarchy',
        resultEmpty: true
      })
    }, null, 2);
  }

  // Format the main item
  const symbolKind = symbolKindNames[result.item.kind] || `Unknown(${result.item.kind})`;
  const mainSymbol = {
    name: result.item.name,
    kind: symbolKind,
    location: {
      file: uriToPath(result.item.uri),
      line: result.item.selectionRange.start.line + 1,
      column: result.item.selectionRange.start.character + 1
    }
  };

  // Format incoming calls (who calls this function)
  const incomingCalls = result.incoming.map((call: CallHierarchyIncomingCall) => {
    const callerKind = symbolKindNames[call.from.kind] || `Unknown(${call.from.kind})`;
    return {
      caller: call.from.name,
      kind: callerKind,
      location: {
        file: uriToPath(call.from.uri),
        line: call.from.selectionRange.start.line + 1,
        column: call.from.selectionRange.start.character + 1
      },
      call_sites: call.fromRanges.map(range => ({
        line: range.start.line + 1,
        column: range.start.character + 1
      }))
    };
  });

  // Format outgoing calls (what this function calls)
  const outgoingCalls = result.outgoing.map((call: CallHierarchyOutgoingCall) => {
    const calleeKind = symbolKindNames[call.to.kind] || `Unknown(${call.to.kind})`;
    return {
      callee: call.to.name,
      kind: calleeKind,
      location: {
        file: uriToPath(call.to.uri),
        line: call.to.selectionRange.start.line + 1,
        column: call.to.selectionRange.start.character + 1
      },
      call_sites: call.fromRanges.map(range => ({
        line: range.start.line + 1,
        column: range.start.character + 1
      }))
    };
  });

  return JSON.stringify({
    found: true,
    symbol: mainSymbol,
    incoming_calls: incomingCalls,
    incoming_count: incomingCalls.length,
    outgoing_calls: outgoingCalls,
    outgoing_count: outgoingCalls.length,
    ...getIndexAwareResponseExtras(options, {
      operation: 'Call hierarchy',
      resultEmpty: false
    })
  }, null, 2);
}
