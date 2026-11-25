import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { resolveArchitectureSpec } from '../../architecture/presets.js';
import { explainFileArchitecture, runRepoArchitectureCheck } from '../../architecture/repo-scan.js';
import { renderArchCheck, renderArchExplain, renderArchPresets } from './arch.js';

describe('vor arch renderers', () => {
  it('renders presets overview', () => {
    const out = renderArchPresets();
    expect(out).toContain('hexagonal');
    expect(out).toContain('ddd');
    expect(out).toContain('modular-monolith');
  });

  it('renders check pass/fail output and explain output cleanly without emoji', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vor-arch-cli-'));
    try {
      mkdirSync(join(ws, 'src/domain'), { recursive: true });
      mkdirSync(join(ws, 'src/adapters/out'), { recursive: true });
      writeFileSync(join(ws, 'src/adapters/out/db.ts'), 'export const db = {};\n');
      writeFileSync(
        join(ws, 'src/domain/order.ts'),
        "import { db } from '../adapters/out/db';\nexport const x = db;\n",
      );

      const spec = resolveArchitectureSpec({
        ...DEFAULT_CONFIG.architecture,
        enabled: true,
        preset: 'hexagonal',
      });
      const checkRes = await runRepoArchitectureCheck({ workspaceDir: ws, spec });
      const checkRendered = renderArchCheck(checkRes);
      expect(checkRendered).toContain('FAIL');
      expect(checkRendered).toContain('arch:layer:domain-to-adapters_out');
      expect(checkRendered).toContain('src/domain/order.ts:1');

      const explainRes = explainFileArchitecture(ws, 'src/domain/order.ts', spec);
      const explainRendered = renderArchExplain(explainRes);
      expect(explainRendered).toContain('Layer: domain');
      expect(explainRendered).toContain('VIOLATION');
      expect(explainRendered).toContain('adapters_out');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
