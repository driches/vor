/**
 * Concrete `Scanner` for risky DDL in database migration files.
 *
 * Why this exists: a destructive or locking migration is one of the highest-
 * blast-radius mistakes a PR can contain — `DROP COLUMN` deletes production
 * data, `ALTER TABLE ... ADD COLUMN ... NOT NULL` without a default takes a
 * full-table lock (and fails outright on a populated table), `TRUNCATE` wipes
 * a table. These are deterministic to spot and worth a human's explicit
 * sign-off, so we surface them as comments rather than spending agent turns.
 *
 * Pipeline mirrors the secrets/debris scanners: skip binary/generated files,
 * walk each migration file's `added_lines`, run the rule table against each
 * line's text, and consult the ignore-list per finding.
 *
 * Scope: line-level heuristics, not a SQL parser. A statement split across
 * lines (e.g. `NOT NULL` on one line and `DEFAULT` on the next) can produce a
 * false positive — those rules are marked `medium` confidence accordingly.
 * The clearly-destructive rules (DROP/TRUNCATE) are `high`.
 *
 * Failure contract: MUST NOT throw — a misbehaving rule records a non-fatal
 * `ScanError` and the scan continues with the remaining rules.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger as defaultLogger } from '../util/logger.js';
import type {
  Scanner,
  ScannerDeps,
  ScanResult,
  ScanFinding,
  ScanError,
  ScannerMetrics,
} from './types.js';
import type { Category, ChangedFile, Confidence, ScannerId, Severity } from '../types.js';

const SCANNER_ID: ScannerId = 'migration-safety';

export type Logger = Pick<typeof defaultLogger, 'debug' | 'notice' | 'warn'>;

export interface MigrationSafetyScannerOptions {
  rules?: readonly MigrationRule[];
  logger?: Logger;
}

interface MigrationRule {
  id: string;
  /** Statement-detecting regex (global). */
  pattern: RegExp;
  /**
   * Optional "the line must NOT also match this" guard. Used for rules that
   * are only risky in the ABSENCE of a mitigating clause — e.g. a NOT NULL
   * column add is fine when it carries a DEFAULT. Non-global; reset is not
   * required because we only `test()` it.
   */
  absent?: RegExp;
  severity: Severity;
  category: Category;
  confidence: Confidence;
  title: string;
  description: string;
}

/**
 * Paths we treat as database migrations. Covers the common conventions:
 * any `migrations/` directory (Django, Sequelize, node-pg-migrate),
 * Rails' `db/migrate/`, Prisma's `prisma/migrations/`, Alembic's
 * `alembic/versions/`, and any `.sql` file.
 */
const MIGRATION_PATH = /(?:^|\/)(?:migrations?|db\/migrate|alembic\/versions)\/|\.sql$/i;

function isMigration(file: ChangedFile): boolean {
  return !file.is_binary && !file.is_generated && MIGRATION_PATH.test(file.path);
}

export const DEFAULT_MIGRATION_RULES: readonly MigrationRule[] = [
  {
    id: 'drop-table',
    pattern: /\bDROP\s+TABLE\b/gi,
    severity: 'critical',
    category: 'data-loss',
    confidence: 'high',
    title: 'Migration drops a table',
    description:
      '`DROP TABLE` permanently deletes a table and all its data. Confirm the table is truly ' +
      'unused, that this is reversible (or intentionally irreversible), and consider a phased ' +
      'deprecation before dropping.',
  },
  {
    id: 'drop-column',
    pattern: /\bDROP\s+COLUMN\b/gi,
    severity: 'critical',
    category: 'data-loss',
    confidence: 'high',
    title: 'Migration drops a column',
    description:
      '`DROP COLUMN` permanently deletes the column data. If any deployed code still reads or ' +
      'writes this column the rollout will error. Confirm the column is unused and the drop is ' +
      'sequenced after code that depends on it is gone.',
  },
  {
    id: 'drop-database',
    pattern: /\bDROP\s+(?:DATABASE|SCHEMA)\b/gi,
    severity: 'critical',
    category: 'data-loss',
    confidence: 'high',
    title: 'Migration drops a database or schema',
    description:
      '`DROP DATABASE`/`DROP SCHEMA` destroys an entire namespace of data. This is almost never ' +
      'intended inside a migration — double-check.',
  },
  {
    id: 'truncate',
    pattern: /\bTRUNCATE\b/gi,
    severity: 'important',
    category: 'data-loss',
    confidence: 'high',
    title: 'Migration truncates a table',
    description:
      '`TRUNCATE` removes every row in the table (and cannot be rolled back inside a transaction ' +
      'on some engines). Confirm this is intentional and not a leftover from local testing.',
  },
  {
    // Adding a NOT NULL column without a DEFAULT fails on any table that
    // already has rows, and on Postgres < 11 rewrites the whole table under
    // an exclusive lock. Only flag when the same line lacks DEFAULT — a
    // statement that spans lines can still slip through (hence medium).
    id: 'add-not-null-without-default',
    pattern: /\bADD\s+(?:COLUMN\s+)?[^;]*\bNOT\s+NULL\b/gi,
    absent: /\bDEFAULT\b/i,
    severity: 'important',
    category: 'data-loss',
    confidence: 'medium',
    title: 'Adds a NOT NULL column without a default',
    description:
      'Adding a `NOT NULL` column without a `DEFAULT` fails on any table that already contains ' +
      'rows, and can take a long exclusive lock while the table is rewritten. Add a default, or ' +
      'backfill in a separate step and set NOT NULL afterwards.',
  },
];

function fingerprintOf(
  rule_id: string,
  file_path: string,
  line: number,
  matchIndex: number,
): string {
  return createHash('sha1')
    .update(`${rule_id}:${file_path}:${line}:${matchIndex}`)
    .digest('hex')
    .slice(0, 12);
}

function statementOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 160 ? trimmed : `${trimmed.slice(0, 157)}...`;
}

export function createMigrationSafetyScanner(options: MigrationSafetyScannerOptions = {}): Scanner {
  const log = options.logger ?? defaultLogger;
  const rules = options.rules ?? DEFAULT_MIGRATION_RULES;

  return {
    id: SCANNER_ID,

    applies(files: readonly ChangedFile[]): boolean {
      return files.some(isMigration);
    },

    async scan(deps: ScannerDeps): Promise<ScanResult> {
      const started = Date.now();
      const errors: ScanError[] = [];
      const findings: ScanFinding[] = [];
      let files_examined = 0;

      for (const file of deps.changedFiles) {
        if (!isMigration(file)) continue;
        files_examined += 1;

        for (const lineNo of file.added_lines) {
          const text = file.head_line_text.get(lineNo);
          if (text === undefined) continue;

          for (const rule of rules) {
            let matchIndex = 0;
            try {
              rule.pattern.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = rule.pattern.exec(text)) !== null) {
                // Mitigating-clause guard (e.g. NOT NULL + DEFAULT on the
                // same line is safe).
                if (rule.absent && rule.absent.test(text)) {
                  break;
                }
                const rule_id = `migration:${rule.id}`;
                const finding: ScanFinding = {
                  scanner: SCANNER_ID,
                  rule_id,
                  file_path: file.path,
                  line: lineNo,
                  severity: rule.severity,
                  category: rule.category,
                  confidence: rule.confidence,
                  title: `${rule.title} (${path.basename(file.path)})`,
                  description: rule.description,
                  evidence: { kind: 'migration', statement: statementOf(text) },
                  fingerprint: fingerprintOf(rule_id, file.path, lineNo, matchIndex++),
                };

                const match = deps.ignoreList.matches(finding);
                if (!match.ignored) {
                  findings.push(finding);
                } else if (match.expired) {
                  void log.notice(
                    `migration-safety: ignore entry for ${finding.rule_id} (${finding.file_path}:${finding.line}) is expired; finding still suppressed but will need refresh. Reason: ${match.reason ?? '(no reason)'}`,
                  );
                }

                if (m.index === rule.pattern.lastIndex) {
                  rule.pattern.lastIndex += 1;
                }
              }
            } catch (err) {
              void log.warn(
                `migration-safety: rule ${rule.id} threw on ${file.path}:${lineNo}: ${(err as Error).message}`,
              );
              errors.push({
                message: `Rule ${rule.id} threw while scanning ${file.path}`,
                cause: (err as Error).message,
                fatal: false,
              });
              rule.pattern.lastIndex = 0;
            }
          }
        }
      }

      return {
        scanner: SCANNER_ID,
        findings,
        errors,
        metrics: buildMetrics(started, files_examined),
      };
    },
  };
}

function buildMetrics(started: number, files_examined: number): ScannerMetrics {
  return {
    duration_ms: Date.now() - started,
    files_examined,
    network_calls: 0,
    cache_hits: 0,
  };
}
