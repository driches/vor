/**
 * Agent tool for reading or searching pre-loaded reference documentation &
 * engineering standards on demand without performing network or disk I/O during
 * the tool loop.
 */

import { z } from 'zod';
import {
  listReferenceCatalog,
  readReferenceSlice,
  searchReferenceCorpus,
} from '../references/search.js';
import { tool } from './tool-helper.js';
import { jsonResult, textResult, type ToolDeps } from './types.js';

export function makeReadReferenceDocTool(deps: ToolDeps) {
  return tool(
    'read_reference_doc',
    'Reads or searches configured team/org reference documentation and engineering standards. ' +
      'Call with `{ id }` (optionally `start_line`, `end_line`) to read an on-demand reference ' +
      'document from the catalog, `{ query }` to search across all reference docs, or `{}` to ' +
      'list all available document IDs.',
    {
      id: z.string().min(1).optional().describe('Document ID from the reference docs catalog.'),
      query: z
        .string()
        .min(1)
        .optional()
        .describe('Case-insensitive keyword or phrase to search across all reference docs.'),
      start_line: z.number().int().positive().optional().describe('1-based starting line.'),
      end_line: z.number().int().positive().optional().describe('1-based inclusive end line.'),
    },
    async (args) => {
      const corpus = deps.references;
      if (!corpus || corpus.docs.length === 0) {
        return textResult('No reference documentation is loaded for this review.', true);
      }

      if (args.id) {
        const res = readReferenceSlice(corpus, {
          id: args.id,
          ...(args.start_line !== undefined ? { start_line: args.start_line } : {}),
          ...(args.end_line !== undefined ? { end_line: args.end_line } : {}),
        });
        if (!res.ok) {
          return textResult(`${res.error} Available IDs: ${res.available_ids.join(', ')}`, true);
        }
        return jsonResult(res);
      }

      if (args.query) {
        const matches = searchReferenceCorpus(corpus, args.query);
        return jsonResult({
          query: args.query,
          match_count: matches.length,
          matches,
        });
      }

      return jsonResult({
        total_docs: corpus.docs.length,
        docs: listReferenceCatalog(corpus),
      });
    },
  );
}
