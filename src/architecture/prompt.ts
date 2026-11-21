/**
 * Renders configured architecture standards into a compact system-prompt block
 * for semantic review (domain purity, aggregate invariants, thin adapters, etc.).
 */

import type { ResolvedArchitectureSpec } from './presets.js';

export function renderArchitecturePrompt(spec: ResolvedArchitectureSpec): string | null {
  if (!spec.enabled || !spec.llm_enforcement) return null;

  const layerEntries = Object.entries(spec.layers);
  const hasContent =
    layerEntries.length > 0 ||
    spec.contexts !== undefined ||
    spec.rules.length > 0 ||
    spec.principles.length > 0;
  if (!hasContent) return null;

  const lines: string[] = [
    '### Software architecture standards',
    '',
    `This repository enforces **${spec.preset}** architecture standards` +
      (spec.root ? ` (scoped under \`${spec.root}\`)` : '') +
      `. Default violation severity: \`${spec.severity}\`.`,
  ];

  if (spec.deterministic_enforcement) {
    lines.push(
      '',
      'A deterministic architecture scanner runs in parallel for direct import, layer-dependency, bounded-context, and forbidden-package violations. Do NOT duplicate straightforward import-path violations; focus your judgment on **semantic** architecture concerns that static import rules cannot verify (e.g., business logic leaking into controllers/repositories, anemic domain models, domain types exposing persistence/HTTP concepts, boundary DTO leakage, or subtle coupling).',
    );
  }

  if (layerEntries.length > 0) {
    lines.push(
      '',
      '| Layer | Paths | Allowed layer imports | Forbidden imports / packages |',
      '|---|---|---|---|',
    );
    for (const [name, def] of layerEntries) {
      const pathsText =
        def.paths
          .slice(0, 3)
          .map((p) => `\`${p}\``)
          .join(', ') + (def.paths.length > 3 ? ` (+${def.paths.length - 3})` : '');
      const allowed = def.can_import && def.can_import.length > 0 ? def.can_import.join(', ') : '—';
      const forbiddenParts: string[] = [];
      if (def.cannot_import?.length) forbiddenParts.push(`layers: ${def.cannot_import.join(', ')}`);
      if (def.forbid_packages?.length) {
        forbiddenParts.push(
          `packages: ${def.forbid_packages.slice(0, 5).join(', ')}` +
            (def.forbid_packages.length > 5 ? ` (+${def.forbid_packages.length - 5})` : ''),
        );
      }
      if (def.allow_packages !== undefined) {
        forbiddenParts.push(`allow_packages only (${def.allow_packages.length})`);
      }
      const forbidden = forbiddenParts.length > 0 ? forbiddenParts.join('; ') : '—';
      lines.push(`| \`${name}\` | ${pathsText} | ${allowed} | ${forbidden} |`);
    }
  }

  if (spec.contexts) {
    lines.push('');
    const pub = (spec.contexts.public_api ?? ['index.*', 'public/**', 'contracts/**', 'api/**'])
      .map((p) => `\`${p}\``)
      .join(', ');
    lines.push(
      `**Bounded contexts / modules (\`${spec.contexts.pattern}\`):** cross-context imports ` +
        (spec.contexts.allow_public_api_imports === false
          ? 'are disabled (use shared kernel or events).'
          : `must target public API (${pub})${spec.contexts.shared?.length ? ` or shared paths (${spec.contexts.shared.map((s) => `\`${s}\``).join(', ')})` : ''}.`),
    );
    if (spec.contexts.allow_dependencies) {
      const deps = Object.entries(spec.contexts.allow_dependencies)
        .map(([ctx, targets]) => `\`${ctx}\` -> [${targets.join(', ')}]`)
        .join('; ');
      if (deps) lines.push(`Allowed context dependencies: ${deps}.`);
    }
  }

  if (spec.rules.length > 0) {
    lines.push('', '**Custom architecture rules:**');
    for (const rule of spec.rules) {
      lines.push(`- \`${rule.id}\`: ${rule.reason}`);
    }
  }

  if (spec.principles.length > 0) {
    lines.push('', '**Semantic architecture principles to enforce:**');
    for (const principle of spec.principles) {
      lines.push(`- ${principle}`);
    }
  }

  lines.push(
    '',
    'When reporting an architecture violation via `post_inline_comment`, use `category: "architecture"`, verify the full file and related boundaries with `read_file_at_ref` first, explain the concrete decoupling impact in `why_it_matters`, and include a concrete `suggestion` for Critical/Important findings.',
  );

  return lines.join('\n');
}
