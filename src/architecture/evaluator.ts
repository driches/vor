/**
 * Pure architecture rule evaluation engine.
 *
 * Evaluates a single file's extracted + resolved imports against a
 * {@link ResolvedArchitectureSpec} across:
 *   1. Layer dependency rules (`can_import` / `cannot_import`)
 *   2. Layer package restrictions (`forbid_packages` / `allow_packages`)
 *   3. Bounded-context / module isolation (`contexts`)
 *   4. Custom repo rules (`rules`)
 */

import { createHash } from 'node:crypto';
import type { ArchitectureLayerDef } from '../config/types.js';
import type { Severity } from '../types.js';
import {
  extractContext,
  globSpecificity,
  isTestFile,
  matchesAnyGlob,
  matchesGlob,
  normalizePath,
  type ContextMatch,
} from './glob.js';
import {
  detectArchLanguage,
  extractImports,
  resolveImports,
  type WorkspaceResolveContext,
} from './imports.js';
import type { ResolvedArchitectureSpec } from './presets.js';

export interface ArchViolation {
  rule_id: string;
  file_path: string;
  line: number;
  severity: Severity;
  title: string;
  description: string;
  fingerprint: string;
  specifier: string;
  snippet: string;
  source_layer?: string;
  target_layer?: string;
  source_context?: string;
  target_context?: string;
}

export interface EvaluateFileInput {
  filePath: string;
  content: string;
  spec: ResolvedArchitectureSpec;
  resolveCtx: WorkspaceResolveContext;
  /** Optional line filter (e.g. PR `added_lines`) so only changed imports fire. */
  onlyLines?: ReadonlySet<number>;
}

export interface LayerMatch {
  name: string;
  def: ArchitectureLayerDef;
}

function matchesLayerPath(filePath: string, patterns: readonly string[]): number {
  const norm = normalizePath(filePath);
  if (!norm) return -1;
  // Directory/namespace targets (including dotted .NET project folders such as
  // `src/Acme.Infrastructure`) probe `${norm}/index` so subtree globs (`/**`) match.
  const extensionless =
    detectArchLanguage(norm) === null &&
    !/\.(?:json|ya?ml|md|txt|toml|xml|csproj|fsproj|sln|lock|mod|sum)$/i.test(norm);
  let best = -1;
  for (const pattern of patterns) {
    if (matchesGlob(norm, pattern) || (extensionless && matchesGlob(`${norm}/index`, pattern))) {
      const score = globSpecificity(pattern);
      if (score > best) best = score;
    }
  }
  return best;
}

/**
 * Classify `filePath` into its most specific matching layer.
 * Ties in glob specificity preserve layer declaration order.
 */
export function classifyLayer(filePath: string, spec: ResolvedArchitectureSpec): LayerMatch | null {
  let best: LayerMatch | null = null;
  let bestScore = -1;
  for (const [name, def] of Object.entries(spec.layers)) {
    const score = matchesLayerPath(filePath, def.paths);
    if (score >= 0 && score > bestScore) {
      bestScore = score;
      best = { name, def };
    }
  }
  return best;
}

/**
 * Match an import specifier or package name against a pattern. A trailing `*` is
 * a literal prefix wildcard (use `@scope/*` to restrict to one npm scope).
 */
export function matchesPackagePattern(
  packageName: string,
  rawSpecifier: string,
  pattern: string,
): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (p.endsWith('*')) {
    const prefix = p.slice(0, -1);
    return packageName.startsWith(prefix) || rawSpecifier.startsWith(prefix);
  }
  return packageName === p || rawSpecifier === p || rawSpecifier.startsWith(`${p}/`);
}

function fingerprintOf(
  rule_id: string,
  file_path: string,
  specifier: string,
  occurrence: number,
): string {
  // Line-number-independent so baselines stay stable across unrelated edits.
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${specifier}:${occurrence}`)
    .digest('hex')
    .slice(0, 12);
}

const DEFAULT_PUBLIC_API_PATTERNS = ['index.*', 'public/**', 'contracts/**', 'api/**'];

function matchesAnyTarget(
  target: string,
  resolvedPath: string | undefined,
  targetLayer: LayerMatch | null,
): boolean {
  if (targetLayer && target === targetLayer.name) return true;
  if (!resolvedPath) return false;
  if (matchesGlob(resolvedPath, target)) return true;
  const extensionless = !/\.[^/]+$/.test(resolvedPath);
  return extensionless && matchesGlob(`${resolvedPath}/index`, target);
}

export function evaluateFileArchitecture(input: EvaluateFileInput): ArchViolation[] {
  const normFile = normalizePath(input.filePath);
  if (!normFile) return [];
  if (input.spec.ignore_tests && isTestFile(normFile)) return [];
  if (matchesAnyGlob(normFile, input.spec.exclude)) return [];

  const { imports, meta } = extractImports(normFile, input.content);
  if (imports.length === 0) return [];

  const resolvedImports = resolveImports(imports, normFile, input.resolveCtx, meta);
  const filteredResolved = input.onlyLines
    ? resolvedImports.filter((r) => input.onlyLines!.has(r.line))
    : resolvedImports;
  if (filteredResolved.length === 0) return [];

  const sourceLayer = classifyLayer(normFile, input.spec);
  const sourceCtx: ContextMatch | null = input.spec.contexts
    ? extractContext(normFile, input.spec.contexts.pattern)
    : null;

  const violations: ArchViolation[] = [];
  const occCounts = new Map<string, number>();

  const pushViolation = (v: Omit<ArchViolation, 'fingerprint'>): void => {
    const key = `${v.rule_id}:${v.specifier}`;
    const occ = occCounts.get(key) ?? 0;
    occCounts.set(key, occ + 1);
    violations.push({
      ...v,
      fingerprint: fingerprintOf(v.rule_id, normFile, v.specifier, occ),
    });
  };

  for (const resolved of filteredResolved) {
    const targetLayer = resolved.resolvedPath
      ? classifyLayer(resolved.resolvedPath, input.spec)
      : null;

    // 1. Layer dependency boundary (same-layer imports are always permitted
    // regardless of can_import / cannot_import config).
    if (sourceLayer && targetLayer && sourceLayer.name !== targetLayer.name) {
      const forbiddenExplicit = sourceLayer.def.cannot_import?.includes(targetLayer.name) ?? false;
      // An explicit empty allowlist (`can_import: []`) forbids all cross-layer imports.
      const disallowedByAllowlist =
        sourceLayer.def.can_import !== undefined &&
        !sourceLayer.def.can_import.includes(targetLayer.name);

      if (forbiddenExplicit || disallowedByAllowlist) {
        const rule_id = `arch:layer:${sourceLayer.name}-to-${targetLayer.name}`;
        const allowedText =
          sourceLayer.def.can_import === undefined
            ? ''
            : sourceLayer.def.can_import.length > 0
              ? ` Allowed layer dependencies for \`${sourceLayer.name}\`: ${sourceLayer.def.can_import.map((l) => `\`${l}\``).join(', ')}.`
              : ` Layer \`${sourceLayer.name}\` cannot import any other layer (\`can_import: []\`).`;
        pushViolation({
          rule_id,
          file_path: normFile,
          line: resolved.line,
          severity: sourceLayer.def.severity ?? input.spec.severity,
          title: `Layer '${sourceLayer.name}' cannot import '${targetLayer.name}'`,
          description:
            `\`${normFile}\` (layer \`${sourceLayer.name}\`) imports \`${resolved.specifier}\` ` +
            `(resolved to \`${resolved.resolvedPath}\`, layer \`${targetLayer.name}\`), which violates ` +
            `the configured \`${input.spec.preset}\` architecture boundaries.${allowedText}`,
          specifier: resolved.specifier,
          snippet: resolved.snippet,
          source_layer: sourceLayer.name,
          target_layer: targetLayer.name,
        });
      }
    }

    // 2. Layer forbidden external packages
    let matchedForbiddenPackage = false;
    if (
      !resolved.resolvedPath &&
      resolved.packageName &&
      sourceLayer?.def.forbid_packages?.length
    ) {
      const matchedPattern = sourceLayer.def.forbid_packages.find((p) =>
        matchesPackagePattern(resolved.packageName!, resolved.specifier, p),
      );
      if (matchedPattern) {
        matchedForbiddenPackage = true;
        pushViolation({
          rule_id: `arch:forbidden-package:${sourceLayer.name}`,
          file_path: normFile,
          line: resolved.line,
          severity: sourceLayer.def.severity ?? input.spec.severity,
          title: `Forbidden package '${resolved.packageName}' in '${sourceLayer.name}' layer`,
          description:
            `\`${normFile}\` (layer \`${sourceLayer.name}\`) imports package \`${resolved.packageName}\` ` +
            `(matched rule \`${matchedPattern}\`). Pure \`${sourceLayer.name}\` code must remain independent ` +
            `of framework, transport, and persistence libraries; depend on a port/interface instead.`,
          specifier: resolved.specifier,
          snippet: resolved.snippet,
          source_layer: sourceLayer.name,
        });
      }
    }

    // 3. Layer package allowlist (when explicitly configured); skipped when
    // forbid_packages already flagged this import so one import does not emit
    // two separate findings.
    if (
      !matchedForbiddenPackage &&
      !resolved.resolvedPath &&
      resolved.packageName &&
      sourceLayer?.def.allow_packages !== undefined
    ) {
      const allowed = sourceLayer.def.allow_packages.some((p) =>
        matchesPackagePattern(resolved.packageName!, resolved.specifier, p),
      );
      if (!allowed) {
        const allowListText =
          sourceLayer.def.allow_packages.length > 0
            ? ` Allowed packages: ${sourceLayer.def.allow_packages.map((p) => `\`${p}\``).join(', ')}.`
            : ' No external packages are permitted in this layer.';
        pushViolation({
          rule_id: `arch:disallowed-package:${sourceLayer.name}`,
          file_path: normFile,
          line: resolved.line,
          severity: sourceLayer.def.severity ?? input.spec.severity,
          title: `Package '${resolved.packageName}' is not allowlisted for '${sourceLayer.name}'`,
          description:
            `\`${normFile}\` (layer \`${sourceLayer.name}\`) imports external package \`${resolved.packageName}\`, ` +
            `which is outside the layer's \`allow_packages\` policy.${allowListText}`,
          specifier: resolved.specifier,
          snippet: resolved.snippet,
          source_layer: sourceLayer.name,
        });
      }
    }

    // 4. Bounded-context / module boundary check
    if (input.spec.contexts && sourceCtx && resolved.resolvedPath) {
      const targetCtx = extractContext(resolved.resolvedPath, input.spec.contexts.pattern);
      if (targetCtx && targetCtx.context !== sourceCtx.context) {
        const isShared =
          input.spec.contexts.shared !== undefined &&
          matchesAnyGlob(resolved.resolvedPath, input.spec.contexts.shared);

        if (!isShared) {
          const ctxSeverity = input.spec.contexts.severity ?? input.spec.severity;
          const allowDeps = input.spec.contexts.allow_dependencies?.[sourceCtx.context];

          if (allowDeps !== undefined && !allowDeps.includes(targetCtx.context)) {
            const permitted =
              allowDeps.length > 0
                ? ` Allowed context dependencies: ${allowDeps.map((c) => `\`${c}\``).join(', ')}.`
                : ' This context has no allowed cross-context dependencies.';
            pushViolation({
              rule_id: 'arch:context-boundary',
              file_path: normFile,
              line: resolved.line,
              severity: ctxSeverity,
              title: `Context '${sourceCtx.context}' cannot depend on context '${targetCtx.context}'`,
              description:
                `\`${normFile}\` (context \`${sourceCtx.context}\`) imports \`${resolved.resolvedPath}\` ` +
                `(context \`${targetCtx.context}\`).${permitted}`,
              specifier: resolved.specifier,
              snippet: resolved.snippet,
              source_context: sourceCtx.context,
              target_context: targetCtx.context,
            });
          } else {
            // Both unconfigured contexts and explicitly listed `allow_dependencies` contexts
            // still enforce the target context's `public_api` boundary (`evaluator.test.ts`).
            const publicGlobs = input.spec.contexts.public_api ?? DEFAULT_PUBLIC_API_PATTERNS;
            const allowPublicApi = input.spec.contexts.allow_public_api_imports !== false;
            const allowsRootIndex = publicGlobs.some(
              (g) => g.startsWith('index') || g.startsWith('__init__'),
            );
            const isPublicTarget =
              matchesAnyGlob(targetCtx.relativePath, publicGlobs) ||
              (allowsRootIndex &&
                (targetCtx.relativePath === '' || targetCtx.relativePath === 'index'));

            if (!allowPublicApi || !isPublicTarget) {
              pushViolation({
                rule_id: 'arch:context-boundary',
                file_path: normFile,
                line: resolved.line,
                severity: ctxSeverity,
                title: `Cross-context import bypasses '${targetCtx.context}' public API`,
                description:
                  `\`${normFile}\` (context \`${sourceCtx.context}\`) imports internal path ` +
                  `\`${resolved.resolvedPath}\` from context \`${targetCtx.context}\`. ` +
                  (allowPublicApi
                    ? `Import through \`${targetCtx.context}\`'s public API (${publicGlobs.map((g) => `\`${g}\``).join(', ')}) or shared kernel instead.`
                    : `Direct cross-context imports are disabled; communicate via events or shared contracts.`),
                specifier: resolved.specifier,
                snippet: resolved.snippet,
                source_context: sourceCtx.context,
                target_context: targetCtx.context,
              });
            }
          }
        }
      }
    }

    // 5. Custom rules
    for (const rule of input.spec.rules) {
      const fromList = Array.isArray(rule.from) ? rule.from : [rule.from];
      const matchesFrom = fromList.some(
        (f) => (sourceLayer && f === sourceLayer.name) || matchesGlob(normFile, f),
      );
      if (!matchesFrom) continue;

      let violated = false;
      // Matches resolved internal repository paths only; unresolved specifiers
      // (e.g. missing path aliases or external packages) fall through to `forbid_packages`.
      if (rule.forbid_imports?.length && resolved.resolvedPath) {
        violated = rule.forbid_imports.some((t) =>
          matchesAnyTarget(t, resolved.resolvedPath, targetLayer),
        );
      }
      if (
        !violated &&
        rule.forbid_packages?.length &&
        !resolved.resolvedPath &&
        resolved.packageName
      ) {
        violated = rule.forbid_packages.some((p) =>
          matchesPackagePattern(resolved.packageName!, resolved.specifier, p),
        );
      }

      if (violated) {
        pushViolation({
          rule_id: `arch:rule:${rule.id}`,
          file_path: normFile,
          line: resolved.line,
          severity: rule.severity ?? input.spec.severity,
          title: `Architecture rule '${rule.id}' violated`,
          description: `${rule.reason} (offending import: \`${resolved.specifier}\`).`,
          specifier: resolved.specifier,
          snippet: resolved.snippet,
          ...(sourceLayer ? { source_layer: sourceLayer.name } : {}),
          ...(targetLayer ? { target_layer: targetLayer.name } : {}),
        });
      }
    }
  }

  return violations;
}
