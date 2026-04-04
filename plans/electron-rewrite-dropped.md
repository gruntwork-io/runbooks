# Dropped Features

Features intentionally removed in the Electron rewrite.

## TfModule / HCL Parsing

**What it did**: Parsed `.tf` files using `hashicorp/hcl/v2` to extract variable/output/resource blocks. Powered two features:
1. `<TfModule>` MDX component - rendered a form for a Terraform module's variables
2. `runbooks open /path/to/terraform/module` - auto-generated a runbook from a bare TF module directory

**Why dropped**: HCL is a Go-native format with no lightweight Node.js equivalent. The feature required `hashicorp/hcl/v2` + `zclconf/go-cty` (heavy dependencies) and would need `@cdktf/hcl2json` WASM in Node.js. Not worth the complexity.

**Files removed**:
- `api/tf_parser.go` (870+ lines) - HCL parsing, variable extraction, section grouping
- `api/tf_parse_handler.go` - HTTP handler for `POST /api/tf/parse`
- `api/tf_generator.go` - Auto-generates runbook MDX from TF module templates
- `api/files.go` - `IsBareTfModule()` detection
- `templates/tf/` - Built-in runbook templates (terragrunt, terragrunt-github, opentofu)
- `web/src/components/mdx/TfModule/` - Frontend component
- `web/src/hooks/useApiParseTfModule.ts` - Frontend hook

**CLI flags removed**:
- `--tf-runbook` (selects template: `::terragrunt`, `::terragrunt-github`, `::tofu`, or custom path)

**IPC channels removed** (from plan):
- `tf:parse`

**Impact**: Users can no longer point runbooks at a bare TF module directory. They must write a `runbook.mdx` file with explicit `<Inputs>` and `<Template>` blocks instead. This was already the primary workflow - TfModule was a convenience shortcut.

## PTY (pseudo-terminal) Support

**What it did**: Spawned script execution inside a virtual terminal (120x40) via `creack/pty` so CLI tools like git, npm, and docker would emit progress bars, colors, and interactive output as if running in a real terminal. The frontend rendered ANSI escape sequences and handled carriage return (`\r`) line replacement for progress bar updates.

**Why dropped**: PTY adds significant complexity for marginal benefit in a desktop app context:
- Requires `node-pty` native module, which needs platform-specific compilation and is the hardest Electron dependency to maintain across macOS/Linux/Windows
- The pipe-based fallback already works - most tools still emit useful output, just without progress bars
- ANSI color output works fine through pipes for many tools (git, etc.) when `FORCE_COLOR=1` or equivalent env vars are set
- Removes the byte-by-byte `\r` parsing logic, `replace` flag handling, and PTY-specific streaming code

**Files removed/simplified**:
- `api/exec_pty.go` (143 lines) - PTY spawning and output streaming. No TypeScript equivalent created.
- `api/exec.go` lines 167, 330-346 - PTY preference logic and `startCommandWithPTY` path removed
- `web/src/hooks/useApiExec.ts` - `replace` flag handling in log entries can be simplified (kept for compatibility but PTY won't produce them)
- `web/src/components/mdx/_shared/ViewLogs` - Progress bar line replacement logic unused

**Props removed**:
- `usePty` prop on `<Command>` and `<Check>` blocks (and `use_pty` in ExecRequest)

**Backend simplification**:
- `src/exec/executor.ts` uses only `child_process.spawn` with pipes (stdout + stderr)
- No `node-pty` dependency
- No platform-specific native module compilation
- ANSI regex (`ansiRegex` in exec_pty.go / logs.ts) can be kept for stripping in non-display contexts

**Impact**: Commands lose progress bar rendering (git clone percentage, npm install spinner, etc.) but retain all other output including colors (via `FORCE_COLOR=1`). This is an acceptable tradeoff given the complexity reduction.
