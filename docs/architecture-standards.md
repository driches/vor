# Software architecture standards

Vor can enforce software architecture standards across your repository using a hybrid approach:

1. **Deterministic structural enforcement (zero LLM cost)** — parses and resolves imports across files to catch layer-dependency violations, forbidden third-party packages inside pure layers, bounded-context / module boundary leaks, and custom rules. Runs both on PR diffs (inline comments tagged `_via architecture scan_`) and across the entire repository via `vor arch check` or MCP `check_architecture`.
2. **Semantic LLM enforcement** — injects your configured architecture model, layer boundaries, and principles into the PR review agent's system prompt so it flags design issues static import rules cannot express (such as business logic leaking into controllers or repositories, anemic domain models, or persistence DTO leakage).

Architecture enforcement runs independently of `security.enabled` — disabling security scanners does not disable architecture enforcement.

## Quick start

Enable a built-in preset in three lines of `.vor.yml`:

```yaml
architecture:
  enabled: true
  preset: hexagonal
  root: src          # optional: scopes default layer globs under src/
```

Or generate a standalone `.vor/architecture.yml` file to keep `.vor.yml` concise:

```sh
npx @driches/vor arch init --preset hexagonal --root src --write
```

Then enable it in `.vor.yml`:

```yaml
architecture:
  enabled: true
  file: .vor/architecture.yml
```

## Built-in presets

Inspect all presets from the terminal with `vor arch presets`.

| Preset | Default layers / contexts | Core rule summary |
|---|---|---|
| `hexagonal` | `domain`, `ports`, `application`, `adapters_in`, `adapters_out`, `adapters` | `domain` and `ports` stay framework/DB-free; `application` depends only on `domain` and `ports`; `adapters_in` and `adapters_out` cannot import each other. |
| `ddd` | `domain`, `application`, `infrastructure`, `interfaces`, `shared` + contexts (`**/contexts/*`) | `domain` depends only on `domain`/`shared`; `application` cannot import `infrastructure`/`interfaces`; cross-context imports must go through `index.*`, `public/**`, `contracts/**`, `api/**`, or `shared`. |
| `clean` | `entities`, `use_cases`, `interface_adapters`, `frameworks` | Strict concentric Dependency Rule inward from `frameworks` -> `interface_adapters` -> `use_cases` -> `entities`. |
| `layered` | `presentation`, `service`, `data`, `model`, `shared` | Top-down flow; `presentation` cannot bypass `service` to import `data`; lower layers cannot import `presentation`. |
| `modular-monolith` | `shared` + contexts (`**/modules/*`) | Feature modules interact only through public entrypoints (`index.*`, `public/**`, `api/**`, `contracts/**`) or the `shared` kernel. |
| `custom` | (none) | Start from a blank slate using your own `layers`, `contexts`, `rules`, and `principles`. |

## Customizing layers, contexts, rules, and principles

Partial `layers` entries merge onto the selected preset without dropping its dependency rules:

```yaml
architecture:
  enabled: true
  preset: hexagonal
  root: src
  severity: important                # default severity for architecture violations
  layers:
    domain:
      paths:
        - "src/core/domain/**"       # replaces only domain paths; keeps preset rules
      forbid_packages:
        - express
        - prisma
    reporting:                       # adds a new custom layer
      paths:
        - "src/reporting/**"
      can_import: [reporting, ports, domain]
  contexts:
    pattern: "src/contexts/*"        # single `*` segment captures context name
    public_api: ["index.*", "contracts/**"]
    shared: ["src/shared/**"]
    allow_dependencies:
      checkout: [billing, inventory]
  rules:
    - id: no-fs-in-domain
      from: domain
      forbid_packages: ["node:fs"]
      severity: critical
      reason: Domain entities must remain free of filesystem I/O.
  principles:
    - Domain aggregates must validate invariants in constructors/methods rather than controllers.
  include_preset_principles: true    # set false to use only your custom principles
  llm_enforcement: true              # set false for deterministic-only enforcement
  deterministic_enforcement: true    # set false for LLM-only semantic enforcement
  ignore_tests: true                 # skip test/spec files (recommended)
  exclude:
    - "src/legacy/**"
```

### Configuration reference

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Master switch for architecture enforcement. |
| `file` | — | Optional repo-relative path to an external architecture YAML (e.g. `.vor/architecture.yml`). |
| `preset` | `hexagonal` (or `custom` if `layers`/`contexts`/`rules` are defined) | Built-in architecture preset. |
| `root` | — | Optional directory prefix scoping default preset globs (e.g. `src`, `app`, `internal`). |
| `severity` | `important` | Default severity (`critical` \| `important` \| `minor` \| `nit`). |
| `layers` | — | Map of layer definitions or partial overrides (`paths`, `can_import`, `cannot_import`, `forbid_packages`, `allow_packages`, `severity`, `description`). |
| `contexts` | — | Bounded-context or module isolation rules (`pattern`, `public_api`, `shared`, `allow_public_api_imports`, `allow_dependencies`, `severity`). |
| `rules` | — | Custom rules (`id`, `from`, `forbid_imports`, `forbid_packages`, `severity`, `reason`). |
| `principles` | — | Natural-language semantic rules appended to the LLM review prompt. |
| `include_preset_principles` | `true` | Include curated semantic principles from the active preset. |
| `llm_enforcement` | `true` | Inject architecture standards into the PR review agent prompt. |
| `deterministic_enforcement` | `true` | Run the static import/boundary scanner on PRs and `vor arch check`. |
| `ignore_tests` | `true` | Skip test/spec files so integration wiring tests do not trigger boundary violations. |
| `exclude` | — | Additional repo-relative globs excluded from deterministic architecture checks. |
| `baseline_file` | `.vor/arch-baseline.json` | Optional baseline file suppressing pre-existing violations during whole-repo checks. |

## Whole-repo enforcement (`vor arch`)

Use the CLI to enforce standards across the entire repository in CI or locally with zero LLM calls and no API key required:

```sh
# Check the full repository (exits 1 if violations meet --fail-on severity)
npx @driches/vor arch check

# Run ad-hoc with a preset before committing config
npx @driches/vor arch check --preset ddd --root src --fail-on important

# Inspect how a specific file and every import inside it are classified
npx @driches/vor arch explain src/domain/order.ts

# List available presets
npx @driches/vor arch presets

# Generate a starter .vor/architecture.yml
npx @driches/vor arch init --preset hexagonal --write
```

### CI gate example

```yaml
- name: Architecture check
  run: npx -y @driches/vor arch check --fail-on important
```

### Gradual adoption with a baseline

For legacy repositories with existing boundary debt, snapshot current violations into `.vor/arch-baseline.json` so `vor arch check` blocks newly introduced violations while passing on existing ones:

```sh
npx @driches/vor arch check --update-baseline
git add .vor/arch-baseline.json
```

Pass `--no-baseline` to audit all violations including baselined debt.

## Supported languages

The deterministic import extractor and resolver support:

- **TypeScript / JavaScript** (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), including `tsconfig.json` `baseUrl` / `paths` aliases and `.js` -> `.ts` ESM imports
- **Python** (`.py`), relative and internal package imports
- **Go** (`.go`), internal package resolution via `go.mod` module path
- **Dart / Flutter** (`.dart`), `package:<app>/...` resolution via `pubspec.yaml` and relative imports
- **Rust** (`.rs`), `crate::`, `super::`, `self::`, `mod`, grouped `use` trees, and external crates
- **Java / Kotlin** (`.java`, `.kt`, `.kts`), `package` declaration root inference
- **C#** (`.cs`), `namespace` root inference and `using` directives

## Suppressing individual exceptions

Architecture findings share `.vor/security-ignore.yml` with security scanners (`file` + `rule` entries with required `reason` and optional `expires`):

```yaml
entries:
  - file: src/domain/legacy_order.ts
    rule: "arch:layer:domain-to-adapters_out"
    reason: "Scheduled for port extraction in Q3"
    expires: 2026-10-01
```

Rule IDs follow:
- `arch:layer:<source>-to-<target>`
- `arch:forbidden-package:<layer>`
- `arch:disallowed-package:<layer>`
- `arch:context-boundary`
- `arch:rule:<rule-id>`
