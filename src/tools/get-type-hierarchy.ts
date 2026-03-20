// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { getIndexAwareResponseExtras, type IndexAwareToolOptions } from './index-aware-response.js';
import { uriToPath } from '../utils/uri.js';
import { withRetry } from '../utils/errors.js';
import { TypeHierarchyItem, symbolKindNames } from '../utils/lsp-types.js';
import { fetchTwoPhaseHierarchy } from '../utils/hierarchy-helper.js';

export async function getTypeHierarchy(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number,
  options: IndexAwareToolOptions = {}
): Promise<string> {
  // Ensure file is opened
  const uri = await fileTracker.ensureFileOpen(filePath);

  // Fetch type hierarchy with retry
  const result = await withRetry(async () => {
    return await fetchTwoPhaseHierarchy<
      TypeHierarchyItem,
      TypeHierarchyItem,
      TypeHierarchyItem
    >(
      lspClient,
      'textDocument/prepareTypeHierarchy',
      'typeHierarchy/supertypes',
      'typeHierarchy/subtypes',
      uri,
      { line, character: column }
    );
  });

  // Handle no hierarchy available
  if (!result) {
    return JSON.stringify({
      found: false,
      message: 'No type hierarchy available at this position',
      ...getIndexAwareResponseExtras(options, {
        operation: 'Type hierarchy',
        resultEmpty: true
      })
    }, null, 2);
  }

  // Format the main type
  const symbolKind = symbolKindNames[result.item.kind] || `Unknown(${result.item.kind})`;
  const mainType = {
    name: result.item.name,
    kind: symbolKind,
    location: {
      file: uriToPath(result.item.uri),
      line: result.item.selectionRange.start.line + 1,
      column: result.item.selectionRange.start.character + 1
    }
  };

  // Format supertypes (base classes)
  const supertypes = result.incoming.map((supertype: TypeHierarchyItem) => {
    const supertypeKind = symbolKindNames[supertype.kind] || `Unknown(${supertype.kind})`;
    return {
      name: supertype.name,
      kind: supertypeKind,
      location: {
        file: uriToPath(supertype.uri),
        line: supertype.selectionRange.start.line + 1,
        column: supertype.selectionRange.start.character + 1
      }
    };
  });

  // Format subtypes (derived classes)
  const subtypes = result.outgoing.map((subtype: TypeHierarchyItem) => {
    const subtypeKind = symbolKindNames[subtype.kind] || `Unknown(${subtype.kind})`;
    return {
      name: subtype.name,
      kind: subtypeKind,
      location: {
        file: uriToPath(subtype.uri),
        line: subtype.selectionRange.start.line + 1,
        column: subtype.selectionRange.start.character + 1
      }
    };
  });

  return JSON.stringify({
    found: true,
    type: mainType,
    supertypes: supertypes,
    supertypes_count: supertypes.length,
    subtypes: subtypes,
    subtypes_count: subtypes.length,
    ...getIndexAwareResponseExtras(options, {
      operation: 'Type hierarchy',
      resultEmpty: false
    })
  }, null, 2);
}
