/**
 * `vor arch` CLI command group — repo-wide zero-LLM architecture enforcement,
 * preset inspection, starter config generation, and single-file diagnostics.
 */

import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  DEFAULT_ARCH_FILE,
  DEFAULT_BASELINE_FILE,
  resolveSafeWorkspaceWritePath,
  resolveWorkspaceArchitectureConfig,
  saveArchBaseline,
} from '../../architecture/loader.js';
import {
  generateStarterYaml,
  listPresets,
  resolveArchitectureSpec,
} from '../../architecture/presets.js';
import {
  explainFileArchitecture,
  runRepoArchitectureCheck,
  type FileArchitectureExplanation,
  type RepoArchCheckResult,
} from '../../architecture/repo-scan.js';
import { architecturePresetSchema } from '../../config/schema.js';
import type { ArchitecturePresetId } from '../../config/types.js';
import type { Severity } from '../../types.js';
import { color, out, status } from '../output.js';
import { workspace } from './shared.js';

const SEVERITIES: readonly Severity[] = ['critical', 'important', 'minor', 'nit'];

const SEVERITY_COLOR: Record<Severity, Parameters<typeof color>[0]> = {
  critical: 'red',
  important: 'yellow',
  minor: 'blue',
  nit: 'gray',
};

function parsePresetOrExit(raw: string): ArchitecturePresetId {
  const res = architecturePresetSchema.safeParse(raw);
  if (!res.success) {
    status(
      color(
        'red',
        `Invalid preset '${raw}'. Valid presets: hexagonal, ddd, clean, layered, modular-monolith, custom.`,
      ),
    );
    process.exit(2);
  }
  return res.data;
}

function parseSeverityOrExit(raw: string): Severity {
  if ((SEVERITIES as readonly string[]).includes(raw)) {
    return raw as Severity;
  }
  status(
    color('red', `Invalid --fail-on severity '${raw}'. Valid values: ${SEVERITIES.join(', ')}.`),
  );
  process.exit(2);
}

export function renderArchCheck(result: RepoArchCheckResult): string {
  const lines: string[] = [];
  const badge = result.passed ? color('blue', 'PASS') : color('red', 'FAIL');
  lines.push(`${badge} ${color('bold', `VOR architecture check (${result.preset})`)}`);
  lines.push(
    color(
      'dim',
      `Scanned ${result.files_scanned} file(s) · ${result.layers_matched} matched layer(s) · ` +
        `${result.contexts_matched} matched context(s) · ${result.duration_ms}ms`,
    ),
  );

  if (result.suppressed_by_ignore > 0 || result.suppressed_by_baseline > 0) {
    const bits: string[] = [];
    if (result.suppressed_by_ignore > 0) bits.push(`${result.suppressed_by_ignore} ignored`);
    if (result.suppressed_by_baseline > 0) bits.push(`${result.suppressed_by_baseline} baselined`);
    lines.push(color('dim', `Suppressed: ${bits.join(', ')}`));
  }

  if (result.layers_matched === 0 && result.contexts_matched === 0 && result.files_scanned > 0) {
    lines.push(
      color(
        'yellow',
        'Warning: 0 files matched any configured layer or bounded-context glob. Verify `root` or `layers.*.paths`.',
      ),
    );
  }

  if (result.violations.length === 0) {
    lines.push('');
    lines.push('No architecture violations found.');
    return lines.join('\n');
  }

  for (const v of result.violations) {
    lines.push('');
    const tag = color(SEVERITY_COLOR[v.severity], `[${v.severity}]`);
    lines.push(`${tag} ${color('bold', v.title)}  ${color('dim', `${v.file_path}:${v.line}`)}`);
    lines.push(color('dim', `  rule: ${v.rule_id} · import: ${v.specifier}`));
    lines.push(`  ${v.description}`);
  }

  lines.push('');
  const statusWord = result.passed ? 'passed' : 'failed';
  lines.push(
    `${result.violations.length} violation(s) found (${statusWord} against --fail-on ${result.fail_on}).`,
  );
  return lines.join('\n');
}

export function renderArchExplain(info: FileArchitectureExplanation): string {
  const lines: string[] = [];
  lines.push(color('bold', `Architecture profile — ${info.file_path}`));
  lines.push(color('dim', `language: ${info.language ?? 'unsupported'}`));
  if (info.ignored_reason) {
    lines.push(color('yellow', `ignored in normal scans: ${info.ignored_reason}`));
  }

  lines.push('');
  if (info.layer) {
    lines.push(`${color('bold', 'Layer:')} ${info.layer.name}`);
    if (info.layer.description) lines.push(`  ${info.layer.description}`);
    if (info.layer.can_import?.length) {
      lines.push(`  can_import: ${info.layer.can_import.join(', ')}`);
    }
    if (info.layer.cannot_import?.length) {
      lines.push(`  cannot_import: ${info.layer.cannot_import.join(', ')}`);
    }
    if (info.layer.forbid_packages?.length) {
      lines.push(
        `  forbid_packages: ${info.layer.forbid_packages.slice(0, 8).join(', ')}` +
          (info.layer.forbid_packages.length > 8
            ? ` (+${info.layer.forbid_packages.length - 8} more)`
            : ''),
      );
    }
  } else {
    lines.push(`${color('bold', 'Layer:')} (unclassified)`);
  }

  if (info.context) {
    lines.push(
      `${color('bold', 'Context:')} ${info.context.context} (root: ${info.context.contextRoot}, rel: ${info.context.relativePath || '.'})`,
    );
  }

  lines.push('');
  if (info.imports.length === 0) {
    lines.push(color('dim', 'No imports found.'));
    return lines.join('\n');
  }

  lines.push(color('bold', `Imports (${info.imports.length}):`));
  for (const imp of info.imports) {
    const targetDesc = imp.resolved_path
      ? `${imp.resolved_path}${imp.target_layer ? ` [layer: ${imp.target_layer}]` : ''}${imp.target_context ? ` [context: ${imp.target_context}]` : ''}`
      : `pkg:${imp.package_name ?? imp.specifier}`;
    const statusLabel =
      imp.violations.length === 0 ? color('blue', 'OK') : color('red', 'VIOLATION');
    lines.push(`  L${imp.line}  ${statusLabel}  ${imp.specifier} -> ${targetDesc}`);
    for (const v of imp.violations) {
      lines.push(`       ${color('red', `[${v.severity}] ${v.rule_id}`)}: ${v.title}`);
    }
  }

  return lines.join('\n');
}

export function renderArchPresets(): string {
  const presets = listPresets();
  const lines: string[] = [];
  for (const p of presets) {
    lines.push(`${color('bold', p.id)} — ${p.name}`);
    lines.push(`  ${p.summary}`);
    const layerNames = Object.keys(p.layers);
    if (layerNames.length > 0) {
      lines.push(color('dim', `  layers: ${layerNames.join(', ')}`));
    }
    if (p.contexts) {
      lines.push(color('dim', `  contexts: ${p.contexts.pattern}`));
    }
    if (p.principles.length > 0) {
      lines.push(color('dim', `  semantic principles: ${p.principles.length}`));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function registerArch(program: Command): void {
  const arch = program
    .command('arch')
    .description(
      'Enforce software architecture standards (hexagonal, DDD, clean, layered, modular-monolith)',
    );

  arch
    .command('check')
    .description(
      'Check the repository deterministically against configured architecture rules (zero LLM cost)',
    )
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--arch-config <path>', 'Path to standalone architecture YAML file')
    .option('--preset <preset>', 'Override or run ad-hoc with a built-in preset')
    .option('--root <dir>', 'Scope default preset globs under a root directory (e.g. src)')
    .option('--fail-on <severity>', 'Minimum severity to fail with exit code 1', 'minor')
    .option('--json', 'Emit JSON result to stdout')
    .option('--update-baseline', 'Write current violations to baseline file and exit 0')
    .option('--no-baseline', 'Ignore any existing baseline file during check')
    .action(
      async (flags: {
        config: string;
        archConfig?: string;
        preset?: string;
        root?: string;
        failOn: string;
        json?: boolean;
        updateBaseline?: boolean;
        baseline: boolean;
      }) => {
        const ws = workspace();
        const preset = flags.preset ? parsePresetOrExit(flags.preset) : undefined;
        const failOn = parseSeverityOrExit(flags.failOn);

        let resolved;
        try {
          resolved = resolveWorkspaceArchitectureConfig({
            workspaceDir: ws,
            configPath: flags.config,
            ...(flags.archConfig !== undefined ? { archConfigPath: flags.archConfig } : {}),
            ...(preset !== undefined ? { preset } : {}),
            ...(flags.root !== undefined ? { root: flags.root } : {}),
            strict: true,
          });
        } catch (err) {
          status(color('red', (err as Error).message));
          process.exit(2);
        }

        if (!resolved.architecture.enabled) {
          status(
            'No architecture configuration found. Add an `architecture:` block to .vor.yml, ' +
              'create .vor/architecture.yml (`vor arch init --write`), or run with `--preset hexagonal`.',
          );
          process.exit(2);
        }

        const spec = resolveArchitectureSpec(resolved.architecture);
        const result = await runRepoArchitectureCheck({
          workspaceDir: ws,
          spec,
          excludePaths: resolved.reviewConfig.exclude.paths,
          ignoreFilePath: resolved.reviewConfig.security.ignore_file,
          useBaseline: flags.updateBaseline ? false : flags.baseline,
          failOn,
        });

        if (flags.updateBaseline) {
          const baselinePath = spec.baseline_file ?? DEFAULT_BASELINE_FILE;
          saveArchBaseline(ws, baselinePath, result.all_fingerprints);
          status(
            color(
              'blue',
              `Saved ${new Set(result.all_fingerprints).size} baseline fingerprint(s) to ${baselinePath}.`,
            ),
          );
          if (flags.json) {
            out(JSON.stringify(result, null, 2));
          } else {
            out(renderArchCheck(result));
          }
          return;
        }

        if (flags.json) {
          out(JSON.stringify(result, null, 2));
        } else {
          out(renderArchCheck(result));
        }

        if (!result.passed) {
          process.exit(1);
        }
      },
    );

  arch
    .command('init')
    .description('Generate a starter architecture configuration YAML')
    .option('--preset <preset>', 'Architecture preset', 'hexagonal')
    .option('--root <dir>', 'Optional root directory (e.g. src)')
    .option('--file <path>', 'Target file when --write is set', DEFAULT_ARCH_FILE)
    .option('--write', 'Write generated config to --file instead of printing only')
    .option('--force', 'Overwrite --file if it already exists')
    .action(
      (flags: {
        preset: string;
        root?: string;
        file: string;
        write?: boolean;
        force?: boolean;
      }) => {
        const preset = parsePresetOrExit(flags.preset);
        const yaml = generateStarterYaml(
          preset,
          flags.root !== undefined ? { root: flags.root } : {},
        );

        if (!flags.write) {
          out(yaml.trimEnd());
          return;
        }

        const ws = workspace();
        let target: string;
        try {
          target = resolveSafeWorkspaceWritePath(ws, flags.file);
        } catch (err) {
          status(color('red', (err as Error).message));
          process.exit(2);
        }

        if (existsSync(target) && !flags.force) {
          status(color('red', `${flags.file} already exists. Re-run with --force to overwrite.`));
          process.exit(1);
        }

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, yaml, 'utf-8');
        status(color('blue', `Wrote ${flags.file} (preset: ${preset}).`));
        status(
          'To enable during PR reviews, add `architecture: { enabled: true, file: ' +
            `${flags.file} }` +
            '` to .vor.yml (or run `vor arch check` directly).',
        );
      },
    );

  arch
    .command('presets')
    .description('List built-in architecture presets and their layers/principles')
    .option('--json', 'Emit JSON instead of human-readable text')
    .action((flags: { json?: boolean }) => {
      if (flags.json) {
        out(JSON.stringify(listPresets(), null, 2));
      } else {
        out(renderArchPresets());
      }
    });

  arch
    .command('explain <file>')
    .description('Explain which layer/context a file belongs to and check its imports')
    .option('--config <path>', 'Path to .vor.yml (default: .vor.yml)', '.vor.yml')
    .option('--arch-config <path>', 'Path to standalone architecture YAML file')
    .option('--preset <preset>', 'Override or inspect with a built-in preset')
    .option('--root <dir>', 'Scope default preset globs under a root directory')
    .option('--json', 'Emit JSON instead of human-readable text')
    .action(
      (
        file: string,
        flags: {
          config: string;
          archConfig?: string;
          preset?: string;
          root?: string;
          json?: boolean;
        },
      ) => {
        const ws = workspace();
        const preset = flags.preset ? parsePresetOrExit(flags.preset) : undefined;
        let resolved;
        try {
          resolved = resolveWorkspaceArchitectureConfig({
            workspaceDir: ws,
            configPath: flags.config,
            ...(flags.archConfig !== undefined ? { archConfigPath: flags.archConfig } : {}),
            ...(preset !== undefined ? { preset } : {}),
            ...(flags.root !== undefined ? { root: flags.root } : {}),
            strict: true,
          });
        } catch (err) {
          status(color('red', (err as Error).message));
          process.exit(2);
        }

        if (!resolved.architecture.enabled) {
          status(
            'No architecture configuration found. Add an `architecture:` block to .vor.yml, ' +
              'create .vor/architecture.yml, or pass `--preset hexagonal`.',
          );
          process.exit(2);
        }

        const spec = resolveArchitectureSpec(resolved.architecture);
        let info: FileArchitectureExplanation;
        try {
          info = explainFileArchitecture(ws, file, spec, resolved.reviewConfig.exclude.paths);
        } catch (err) {
          status(color('red', `Could not read ${file}: ${(err as Error).message}`));
          process.exit(1);
        }

        if (flags.json) {
          out(JSON.stringify(info, null, 2));
        } else {
          out(renderArchExplain(info));
        }
      },
    );
}
