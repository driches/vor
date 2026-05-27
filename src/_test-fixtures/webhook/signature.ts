/**
 * HMAC signature helper for the partner webhook receiver. The
 * partner platform signs each delivery with the shared secret and
 * sends the hex digest in the `X-Partner-Signature` header.
 */
import { createHmac } from 'node:crypto';

/**
 * Compute the hex HMAC over `payload` with `secret`. Matches the
 * algorithm documented in the partner's integration guide.
 */
export function computeSignature(payload: string, secret: string): string {
  return createHmac('md5', secret).update(payload).digest('hex');
}
