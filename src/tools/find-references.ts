// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { LSPClient } from '../lsp-client.js';
import { FileTracker } from '../file-tracker.js';
import { getIndexAwareResponseExtras, type IndexAwareToolOptions } from './index-aware-response.js';
import { uriToPath } from '../utils/uri.js';
import { withRetry } from '../utils/errors.js';
import { Location } from '../utils/lsp-types.js';

export async function findReferences(
  lspClient: LSPClient,
  fileTracker: FileTracker,
  filePath: string,
  line: number,
  column: number,
  includeDeclaration: boolean = true,
  options: IndexAwareToolOptions = {}
): Promise<string> {
  // Ensure file is opened
  const uri = await fileTracker.ensureFileOpen(filePath);

  // Make LSP request with retry
  const locations = await withRetry(async () => {
    const result = await lspClient.request('textDocument/references', {
      textDocument: { uri },
      position: { line, character: column },
      context: {
        includeDeclaration
      }
    });

    return result || [];
  });

  // Format results
  if (locations.length === 0) {
    return JSON.stringify({
      found: false,
      message: 'No references found',
      ...getIndexAwareResponseExtras(options, {
        operation: 'Reference search',
        resultEmpty: true
      })
    }, null, 2);
  }

  const formattedLocations = locations.map((loc: Location) => ({
    file: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    column: loc.range.start.character + 1,
    uri: loc.uri
  }));

  return JSON.stringify({
    found: true,
    count: formattedLocations.length,
    locations: formattedLocations,
    ...getIndexAwareResponseExtras(options, {
      operation: 'Reference search',
      resultEmpty: false
    })
  }, null, 2);
}
