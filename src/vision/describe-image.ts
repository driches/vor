/**
 * Visual understanding of an image via a cost-effective vision model.
 *
 * OCR (src/ocr) answers "what does the text say"; this answers "what is this an
 * image of" — a login form, an AWS console, an architecture diagram, a UI
 * before/after. The agent can't reason about pixels, so the `describe_image_at_ref`
 * tool runs this and hands the agent a short text description.
 *
 * This is a deliberately isolated one-shot sub-call (mirroring the Haiku
 * {@link WorkerClient} pattern), NOT a change to the canonical agent message
 * path. It uses a separately-configured cheap model (default `claude-haiku-4-5`
 * — $1/$5 per 1M tokens vs Sonnet's $3/$15) reusing the API key the orchestrator
 * already resolves, and records spend against the same {@link Budget} so the
 * run's `cost_usd` stays accurate.
 *
 * Consumers depend on the {@link VisionClient} seam so tests run against a fake
 * with no network.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { Budget } from '../util/budget.js';
import { logger as defaultLogger } from '../util/logger.js';

/** Media types the Anthropic vision API accepts for base64 image blocks. */
export type VisionMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

export interface VisionDescription {
  description: string;
}

/**
 * The seam the `describe_image_at_ref` tool depends on. `describe` MUST NOT
 * throw — failures resolve to an empty description so a review never fails
 * because the vision sub-call did.
 */
export interface VisionClient {
  describe(image: Buffer, mediaType: VisionMediaType): Promise<VisionDescription>;
}

export type Logger = Pick<typeof defaultLogger, 'debug' | 'warn'>;

const SYSTEM_PROMPT =
  'You analyze images attached to a code review. Describe concisely what the ' +
  'image shows (UI, diagram, terminal, chart, etc.) in 1-3 sentences. If the ' +
  'image appears to display credentials, API keys, tokens, private keys, ' +
  'connection strings, or other secrets, say so explicitly and first. Do not ' +
  'transcribe long passages of text — another tool handles OCR.';

const MAX_OUTPUT_TOKENS = 300;

/**
 * Anthropic-backed vision client. Maps the raw image bytes into a base64
 * `image` content block and asks the cheap model for a short description.
 */
export class AnthropicVisionClient implements VisionClient {
  constructor(
    private readonly client: Anthropic,
    private readonly budget: Budget,
    private readonly model = 'claude-haiku-4-5',
    private readonly log: Logger = defaultLogger,
  ) {}

  async describe(image: Buffer, mediaType: VisionMediaType): Promise<VisionDescription> {
    let response: Anthropic.Message;
    // Only the API call is best-effort — a network/API failure degrades to an
    // empty description so a review never fails on a vision hiccup.
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Determinism over variety — same image should yield the same gist.
        temperature: 0,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: image.toString('base64') },
              },
              { type: 'text', text: 'Describe this image.' },
            ],
          },
        ],
      });
    } catch (err) {
      void this.log.warn(`vision: describe failed: ${(err as Error).message}`);
      return { description: '' };
    }

    // Budget accounting is NOT best-effort. Mirror WorkerClient: call addUsage
    // OUTSIDE the catch so a BudgetError (cap exceeded) propagates and halts the
    // run instead of being silently swallowed as a vision failure after the
    // call has already incurred cost.
    this.budget.addUsage(this.model, response.usage);

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return { description: text };
  }
}

/**
 * Map a file extension to the media type the vision API expects. Returns
 * `undefined` for extensions Anthropic's vision input doesn't support (e.g.
 * `.bmp`), so callers can skip the vision call for those.
 */
export function mediaTypeForPath(filePath: string): VisionMediaType | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return undefined;
}
