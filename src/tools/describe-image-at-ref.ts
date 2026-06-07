/**
 * `describe_image_at_ref` — lets the agent read and understand an image file in
 * the PR. Vor's review is otherwise text-only: `read_file_at_ref` decodes
 * everything as UTF-8, so screenshots and diagrams are opaque to the agent.
 *
 * Returns two complementary signals:
 *  - `text` / `ocr_confidence`: literal text pulled out of the image by OCR
 *    (tesseract). Use it to read terminal output, config snippets, error
 *    messages baked into a screenshot.
 *  - `description`: a short visual-understanding summary from a cost-effective
 *    vision model (what the image *shows* — a login form, an AWS console, a
 *    diagram). Present only when `image_understanding` is enabled; OCR-only
 *    otherwise.
 *
 * The agent discovers which files are images via `list_changed_files`
 * (`is_binary: true`), so it only calls this when an image is worth inspecting.
 */
import { z } from 'zod';
import { tool } from './tool-helper.js';
import { jsonResult, type ToolDeps } from './types.js';
import { recognizeOnce } from '../ocr/recognize.js';
import { mediaTypeForPath } from '../vision/describe-image.js';

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function makeDescribeImageAtRefTool(deps: ToolDeps) {
  // Per-run cap on vision calls. The factory is invoked once per agent run, so
  // this counter is shared across every invocation of the returned tool and
  // bounds total image-input token spend to `image_understanding.max_images`.
  const maxImages = deps.config.image_understanding.max_images;
  let visionCalls = 0;

  return tool(
    'describe_image_at_ref',
    'Reads an image file (PNG/JPG/GIF/WEBP) at HEAD or BASE and returns OCR text ' +
      'plus a short description of what the image shows. Use it to inspect ' +
      'screenshots and diagrams that read_file_at_ref cannot (it is text-only). ' +
      'Find image files via list_changed_files (is_binary: true).',
    {
      path: z.string().describe('Repo-relative path to an image, e.g. "docs/login.png".'),
      ref: z
        .enum(['head', 'base'])
        .default('head')
        .describe('Which side to read: head (post-PR) or base (pre-PR).'),
    },
    async (args) => {
      if (!IMAGE_EXTENSIONS.test(args.path)) {
        return jsonResult({
          ok: false,
          error: `'${args.path}' is not a supported image (png/jpg/gif/webp/bmp).`,
          hint: 'Use read_file_at_ref for text files.',
        });
      }

      const sha =
        args.ref === 'head' ? deps.prContext.metadata.head_sha : deps.prContext.metadata.base_sha;

      const bytes = await deps.fileReader.readBinary({
        owner: deps.owner,
        repo: deps.repo,
        path: args.path,
        ref: sha,
      });
      if (bytes === null) {
        return jsonResult({
          ok: false,
          error: `Image '${args.path}' not found at ${args.ref} (${sha.slice(0, 7)})`,
          hint: 'Check list_changed_files for the exact paths in this PR.',
        });
      }

      const ocr = deps.ocrEngine
        ? await deps.ocrEngine.recognize(bytes)
        : await recognizeOnce(bytes);

      // Visual understanding is optional (config-gated) and best-effort — a
      // failure here resolves to an empty description, never an error. The
      // per-run `max_images` cap bounds vision token spend; once hit, the tool
      // keeps returning OCR text but stops making vision calls.
      let description = '';
      const mediaType = mediaTypeForPath(args.path);
      const underCap = maxImages === undefined || visionCalls < maxImages;
      if (deps.visionClient && mediaType !== undefined && underCap) {
        visionCalls += 1;
        const result = await deps.visionClient.describe(bytes, mediaType);
        description = result.description;
      }

      return jsonResult({
        ok: true,
        path: args.path,
        ref: args.ref,
        ref_sha: sha,
        text: ocr.text,
        ocr_confidence: Math.round(ocr.confidence),
        description,
      });
    },
  );
}
