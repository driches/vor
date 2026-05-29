import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from './tool-helper.js';

const ok = async () => ({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('tool() helper', () => {
  it('applies Zod schema defaults to omitted fields before the handler runs', async () => {
    let seen: unknown;
    const t = tool(
      'defaults',
      'desc',
      {
        a: z.enum(['x', 'y']).default('x'),
        flag: z.boolean().default(true),
        n: z.number().default(7),
      },
      async (args) => {
        seen = args;
        return ok();
      },
    );

    await t.handler({}, undefined);

    expect(seen).toEqual({ a: 'x', flag: true, n: 7 });
  });

  it('passes provided values through unchanged', async () => {
    let seen: unknown;
    const t = tool('passthrough', 'desc', { a: z.string() }, async (args) => {
      seen = args;
      return ok();
    });

    await t.handler({ a: 'hello' }, undefined);

    expect(seen).toEqual({ a: 'hello' });
  });

  it('throws a readable, name-prefixed error on schema-invalid input', async () => {
    const t = tool('mytool', 'desc', { a: z.enum(['x', 'y']) }, ok);

    await expect(t.handler({ a: 'z' }, undefined)).rejects.toThrow(/Invalid arguments for mytool/);
  });

  it('strips unknown keys not declared in the schema', async () => {
    let seen: unknown;
    const t = tool('strip', 'desc', { a: z.string() }, async (args) => {
      seen = args;
      return ok();
    });

    await t.handler({ a: 'keep', extra: 'drop' }, undefined);

    expect(seen).toEqual({ a: 'keep' });
  });
});
