# Bundled Semgrep rule pack

This directory ships with the action and is loaded automatically — Semgrep
combines it with its built-in `--config=auto` ruleset on every PR. The
intent is to catch a small set of high-signal bug shapes deterministically
so the LLM reviewer doesn't have to spend turns hunting for them.

The pack is opt-out: if you don't want any of these rules to fire, set
`security.scanners.sast.semgrep.custom_rules_path: ''` (empty string) in
your `.code-review.yml`, or point it at a different directory.

## How loading works

The `semgrep` linter under [src/scanners/sast/semgrep.ts](../../src/scanners/sast/semgrep.ts)
resolves `custom_rules_path` against the workspace root, existence-checks
it, and — when the path exists — appends `--config <abs_path>` to the
semgrep invocation. Semgrep accepts multiple `--config` flags and merges
them; the auto-detected rules still run.

When the path is set but missing (e.g. you've cleared the directory or
pointed at a path that doesn't exist), the linter logs at debug level
and silently runs with `--config=auto` only. No failed scan, no error.

## Rule index

All rules are namespaced under `code-review.*`. The full Scanner rule ID
emitted on PR comments is `sast:semgrep/<rule.id>` (e.g.
`sast:semgrep/code-review.n-plus-one.await-in-for-loop`).

### `n-plus-one.yml` — sequential `await` in loops

| Rule ID | Severity | Languages | What it catches |
|---|---|---|---|
| `code-review.n-plus-one.await-in-for-loop` | WARNING | TS/JS | `await` inside a `for (...)` body |
| `code-review.n-plus-one.await-in-for-of-loop` | WARNING | TS/JS | `await` inside `for ... of` body |
| `code-review.n-plus-one.await-in-while-loop` | WARNING | TS/JS | `await` inside a `while` body |
| `code-review.n-plus-one.await-in-forEach` | ERROR | TS/JS | `await` inside `.forEach(async ...)` — additionally a correctness bug (forEach discards the promise) |
| `code-review.n-plus-one.await-in-map` | ERROR | TS/JS | bare `.map(async ...)` without surrounding `Promise.all(...)` |
| `code-review.n-plus-one.await-in-for-loop-py` | WARNING | Python | `await` inside `for ... in` body |
| `code-review.n-plus-one.await-in-while-loop-py` | WARNING | Python | `await` inside `while` body |

**Why WARNING for most:** sequential awaits can be intentional (each
iteration depends on the prior). Surface them for review without
auto-blocking. The two `ERROR`s are different — `forEach(async ...)`
silently drops the promise (race bug), and `arr.map(async ...)` without
`Promise.all` is almost never what was intended.

### `sync-in-async.yml` — blocking I/O inside async functions

| Rule ID | Severity | Languages | What it catches |
|---|---|---|---|
| `code-review.sync-in-async.readFileSync` | ERROR | TS/JS | `fs.readFileSync` inside `async function` |
| `code-review.sync-in-async.readFileSync-arrow` | ERROR | TS/JS | `fs.readFileSync` inside `async () => ...` |
| `code-review.sync-in-async.writeFileSync` | ERROR | TS/JS | `fs.writeFileSync` inside `async function` |
| `code-review.sync-in-async.writeFileSync-arrow` | ERROR | TS/JS | `fs.writeFileSync` inside `async () => ...` |
| `code-review.sync-in-async.execSync` | ERROR | TS/JS | `child_process.execSync` / `spawnSync` / `execFileSync` inside any async function |

**Why ERROR:** the call already declares `async`, the author already
knows about non-blocking I/O. A sync syscall in that scope is a copy/
paste accident with real production impact (every other request on the
event loop stalls).

### `raw-sql-concat.yml` — SQL built by string concatenation / interpolation

| Rule ID | Severity | Languages | What it catches |
|---|---|---|---|
| `code-review.raw-sql-concat.string-plus` | ERROR | TS/JS | `"SELECT ..." + x` and variants |
| `code-review.raw-sql-concat.template-literal` | ERROR | TS/JS | `` `SELECT ... ${x} ...` `` (untagged) |
| `code-review.raw-sql-concat.python-fstring` | ERROR | Python | `f"SELECT ... {x} ..."` |
| `code-review.raw-sql-concat.python-percent` | ERROR | Python | `"SELECT ..." % x` and `.format(...)` |

**Caveats:** matches the syntactic shape. Test fixtures, migrations, and
audit-log queries that legitimately need dynamic table/column names will
fire here and should be suppressed via `.code-review/security-ignore.yml`.
Tagged template literals like `` sql`SELECT ... ${x}` `` (postgres-js,
@vercel/postgres, etc.) intentionally do NOT match — the tag itself
parameterizes.

### `missing-auth-middleware.yml` — mutating routes without auth

| Rule ID | Severity | Languages | What it catches |
|---|---|---|---|
| `code-review.missing-auth-middleware.post-no-auth` | ERROR | TS/JS | `app.post(path, handler)` with no `authenticate` / `requireAuth` / `isAuthenticated` / `requireUser` / `ensureAuthenticated` / `authMiddleware` / `auth` in the call |
| `code-review.missing-auth-middleware.put-no-auth` | ERROR | TS/JS | same shape, `PUT` |
| `code-review.missing-auth-middleware.patch-no-auth` | ERROR | TS/JS | same shape, `PATCH` |
| `code-review.missing-auth-middleware.delete-no-auth` | ERROR | TS/JS | same shape, `DELETE` |
| `code-review.missing-auth-middleware.fastify-route-no-auth` | ERROR | TS/JS | `fastify.route({ method, ... })` with a mutating method and no `preHandler` / `onRequest` / `preValidation` |

**Limits:** the rules only see what's in the same call. A codebase that
registers auth via a global `app.use(authMiddleware)` or
`fastify.addHook('onRequest', ...)` will trip every individual route.
That's an opinionated trade — explicit per-route auth is easier to audit
in PR review, and the false positives are easy to suppress per-file.
`GET` / `HEAD` are intentionally NOT flagged (most public read endpoints
are legitimately unauthenticated).

## Suppressing findings

Add an entry to [`../security-ignore.yml`](../security-ignore.yml). The
rule id field uses the `sast:semgrep/<rule.id>` form:

```yaml
entries:
  # Suppress one file
  - file: src/legacy/old-handler.ts
    rule: "sast:semgrep/code-review.missing-auth-middleware.post-no-auth"
    reason: "Legacy public webhook — auth is enforced by upstream gateway."

  # Suppress everywhere a fixture pattern lives
  - file: tests/fixtures/sql-builder.test.ts
    rule: "sast:semgrep/code-review.raw-sql-concat.string-plus"
    reason: "Positive fixture for SQL-builder tests."
```

The `entries[].file` field is a glob, and the `rule` field is the
finding's `rule_id` exactly as it appears in the comment.

## Authoring your own rules

Drop additional `*.yml` files into this directory; semgrep will load
them automatically (the `--config` flag points at the directory, not at
individual files). Or override `custom_rules_path` in your
`.code-review.yml` to point somewhere else entirely:

```yaml
security:
  scanners:
    sast:
      enabled: true
      semgrep:
        custom_rules_path: rules/code-review/semgrep
```

A path missing on disk is silently skipped — your CI will still run
with the auto-detected ruleset.

## Configuration

Default applied by [src/config/defaults.ts](../../src/config/defaults.ts):

```yaml
security:
  scanners:
    sast:
      enabled: true
      semgrep:
        custom_rules_path: .code-review/semgrep-rules
```

To opt out of the bundled rules entirely without disabling SAST:

```yaml
security:
  scanners:
    sast:
      enabled: true
      semgrep:
        custom_rules_path: ""
```
