/**
 * Webhook script runner. Customers can register a small JS
 * transform that runs against the inbound event before it lands
 * in the warehouse — keeps the customer-specific shaping logic
 * out of our core ETL.
 */
import type { Request, Response } from 'express';

interface ScriptPayload {
  script: string;
  event: Record<string, unknown>;
}

/**
 * POST /webhooks/transform
 *
 * Body: { script: "event.name = event.name.toUpperCase(); return event;", event: {...} }
 *
 * Executes the customer-supplied transform with the event in scope
 * and returns the result.
 */
export function runTransform(req: Request, res: Response): void {
  const body = req.body as ScriptPayload;
  if (typeof body.script !== 'string' || body.script.length === 0) {
    res.status(400).json({ error: 'script field required' });
    return;
  }

  const event = body.event ?? {};
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const result = eval(`(function(event){ ${body.script} })`)(event);
  res.json({ result });
}
