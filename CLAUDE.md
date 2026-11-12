# CLAUDE.md — open-remote-ssh (Spinbox's fork)

## What this is

Spinbox's fork, `spin-stack/open-remote-ssh`: the remote resolver the Spinbox
extension (spin-stack/vscode-spinbox) opens workspaces through
(spin-stack/vscode-spinbox#24). It starts from developerz-ai/open-remote-ssh-tmux,
described below, which follows jeanp413/open-remote-ssh; `upstream` is
developerz-ai's.

A VS Code / VSCodium extension that connects to a remote dev machine over SSH —
**identical to [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh)
in look and feel** — but with one under-the-hood upgrade: the **remote terminals
are backed by [tmux](https://github.com/tmux/tmux)** so they persist and can be
re-attached from any machine.

It is a **fork of open-remote-ssh**. Upstream resolves the `ssh-remote`
authority over SSH, installs the VS Code server, and runs the remote session over
that SSH channel. We keep all of that. We add tmux-backed terminals so a long
task (e.g. a **Claude Code** run) survives client disconnects, window closes, and
**machine hand-off** (close the PC, open the laptop, re-attach to the same live
terminals).

**Read [`docs/idea/`](docs/idea/README.md) first** — it's the *why*: the
PC/laptop/VPS hand-off, keeping a long Claude Code task alive, the honest
[`persistence-model.md`](docs/idea/persistence-model.md), the tmux design in
[`tmux-approach.md`](docs/idea/tmux-approach.md), and why-tmux-not-mosh in
[`decision-mosh-vs-tmux.md`](docs/idea/decision-mosh-vs-tmux.md).

### The shape of the change

- **Scope is terminals only.** Editing, file changes, saving, extensions, and
  port forwarding already reconnect fine (the vscode-server persists) — **do not
  touch that path and do not regress it.** The one problem we fix is terminal
  lifetime.
- **SSH transport stays.** No transport rewrite. `ssh2` auth
  (`src/authResolver.ts`, `src/ssh/*`) is unchanged. (Mosh was considered for
  seamless roaming and deliberately dropped — it can't do machine hand-off; see
  `decision-mosh-vs-tmux.md`.)
- **tmux owns terminal lifetime.** Terminals run inside a long-lived tmux server
  on the remote, independent of the vscode-server and the SSH link. Neutralise
  VS Code's own persistent-terminal layer for these so there's a single owner.
- **Invisible to the user.** Same UX as open-remote-ssh — no tmux commands, no
  tmux UI. It's a pure under-the-hood upgrade.
- **No zombie sessions.** Deterministic session naming keyed to host+workspace +
  attach-or-create → re-opening re-attaches the *same* session, never a
  duplicate; empty/dead sessions get reaped. This is a hard requirement, not a
  polish item — see [`tmux-approach.md`](docs/idea/tmux-approach.md).
- **tmux is Unix-only** — degrade gracefully on Windows remotes (feature off /
  documented), never break the base SSH experience.

When a design choice can't meet "invisible + no zombies + terminals-only," say so
explicitly rather than shipping a leaky abstraction.

## Architecture — one responsibility per module (SRP)

The codebase is roughly 7k lines of TypeScript (`src/`, plus ~0.6k lines of
remote install scripts) and is organised by responsibility. Preserve that; each file below owns exactly one concern.

| File | Single responsibility |
|------|----------------------|
| `src/extension.ts` | Activation wiring plus a little glue logic: `idempotentResolveHandler` / `onceOnly` (wire the tmux layer once per resolve, retry if it was not ready), `wireTmuxTerminalLayer` (gated on the tmux capability probe and the `remote.SSH.tmux.enabled` setting), `lazyExec` (resolves the *current* connection per call, so a reconnect is picked up), the kill-workspace-sessions command, and `TMUX_PROFILE_ID`. Anything bigger belongs in a collaborator, not here. |
| `src/authResolver.ts` | Resolve the remote authority: auth handshake → ensure server → produce the connection VS Code connects to. Upstream's core, kept as close to upstream as possible (terminals-only scope), but **not untouched**: it imports `probeTmux` from `src/tmux/tmuxBootstrap` and runs it after connecting to record the remote's tmux capability, and it applies the terminal environment via `common/envCollection`. |
| `src/tmux/*` *(new)* | **The fork's addition.** `tmuxSession.ts` (pure session-naming/attach-or-create/reap-decision logic; its builders are where the tmux command lines are built, alongside `tmuxBootstrap`'s `PROBE_COMMAND` and the `TMUX_BIN` `shellPath` in `terminalProvider.ts`), `tmuxBootstrap.ts` (capability probe), `terminalProvider.ts` (VS Code `TerminalProfileProvider` wiring, multi-client slot allocation), `slotState.ts` (pure slot-lifecycle decision: reclaim our own stale client, never steal another machine's), `profileRegistration.ts` (sole owner of the single `tmux` terminal-profile id; dispose-then-register swap), `fallbackTerminalProvider.ts` (plain-shell provider on that id when tmux is unavailable or disabled), `sessionReaper.ts` (connect-time cleanup of dead/empty sessions). The heart of open-remote-ssh-tmux. |
| `src/spin/*` *(Spinbox's)* | The `spin+<workspace>` authority, beside `ssh-remote` and sharing nothing with its resolver but `SSHConnection`. `resolver.ts` (the VS Code resolver: progress, the tunnel to a local port, a refusal shown with its action), `open.ts` (the flow, with no VS Code in it so `test/e2e` drives it: `spin code`, `spin ssh-prepare`, ssh2 over `spin ssh-proxy`, the server started), `cli.ts` (the spin CLI, the only client of an installation), `contract.ts` (its JSON answers), `session.ts` (what ssh-prepare leaves in `~/.spin/ssh/hosts/<host>/`), `keys.ts` (the workspace's certificate as an ssh2 key; the host key pinned to the launch claim's), `serverStart.ts` (the server from the extension disk, never downloaded), `refusal.ts` (what a person is shown). |
| `src/clipboard/*` *(new)* | Clipboard→remote image bridge, independent of `src/tmux/*` (no imports either way). `clipboardImage.ts` (pure command/path builders, the only place the clipboard's own capture/mkdir/cleanup command lines are built), `clipboardWebview.ts` (last-resort local clipboard reader via a webview), `pasteImage.ts` (orchestration: read local clipboard → write to remote → bracketed-paste the path). |
| `src/serverSetup.ts` | Install / locate the VS Code server on the remote (script templating, path resolution, release fetch). |
| `src/serverConfig.ts` | Compute the wanted server version/quality/commit + validation policy. |
| `src/fetchRelease.ts` | Fetch release metadata (network I/O, no policy). |
| `src/commands.ts` | Command handlers invoked from the palette / menus. Thin — delegate. |
| `src/hostTreeView.ts` | The "SSH Targets" tree view (presentation only). |
| `src/remoteLocationHistory.ts` | Persist & recall recently opened remote folders. |
| `src/ssh/sshConnection.ts` | The `ssh2` connection + tunnel primitives. |
| `src/ssh/sshConfig.ts` | Parse & query the user's SSH config file. |
| `src/ssh/sshDestination.ts` | Parse/format a `user@host:port` destination. |
| `src/ssh/identityFiles.ts` | Discover & load identity/key files. |
| `src/ssh/hostfile.ts` | known_hosts handling. |
| `src/common/*` | Cross-cutting leaf utilities: `logger`, `ports`, `files`, `platform`, `disposable`, `shellQuote` (`escapeShellArg` and the PowerShell counterpart — the one shell-quoting implementation, re-exported by `tmuxSession.ts`), `envCollection` (diff-before-write of the terminal environment so reconnects do not prompt to relaunch live terminals). Depend on nothing in the project. |
| `src/scripts/*.sh \| *.ps1` | Remote-side install scripts (templated by `serverSetup`). |

Dependency direction: `extension` → feature modules → `ssh/*` / `serverSetup`
→ `common/*`. `common/*` never imports upward. Keep it that way.

## SOLID / SRP rules for changes here

Follow these — they override the temptation to "just add it where it's easy":

- **S — Single Responsibility.** One reason to change per module/function. If a
  file starts doing auth *and* UI *and* persistence, split it. The tmux
  integration gets its own module(s) (e.g. `src/tmux/tmuxSession.ts` for
  naming/attach-or-create/reaping, `src/tmux/terminalProvider.ts` for the VS Code
  terminal-profile wiring) — **do not bolt tmux logic onto the SSH classes** or
  the resolver.
- **O — Open/Closed.** Extend by adding a collaborator, not by editing a stable
  module's internals. The terminal layer plugs into the existing connection; it
  doesn't require rewriting `authResolver`.
- **L — Liskov.** Any abstraction the terminal layer introduces (e.g. a
  "terminal backend") must have implementations that honour the same contract
  callers assume — the tmux backend and a plain-shell fallback (Windows remotes)
  behave predictably, no "throws on this method" surprises.
- **I — Interface Segregation.** Small, purpose-specific interfaces. The tree
  view shouldn't depend on tmux internals; the tmux session manager shouldn't
  depend on view types.
- **D — Dependency Inversion.** High-level flow depends on abstractions (a
  command runner over the connection, a clock for reaping), not concrete `ssh2`
  or `child_process` calls scattered inline. Inject `Log` and collaborators via
  constructors — the code already does this (see `extension.ts`); keep it.

Practical: no god functions, no reaching across layers, delete before you
abstract, and introduce an abstraction only when there's a second real consumer
(e.g. tmux backend + Windows-shell fallback).

## Conventions (match the repo, don't invent)

- **Language:** TypeScript, `strict` mode. No `any`, no unused locals/params,
  explicit `override`. `tsconfig.json` typechecks `src/` and `test/` together;
  esbuild bundles (`esbuild.mjs`).
- **Indentation:** 4-space (see `.editorconfig`). YAML 2-space, JSON tabs,
  shell/PowerShell 2-space. LF, final newline, trimmed trailing whitespace.
- **Lint:** Biome (`biome.jsonc`), warnings fail. The formatter is off and the
  style-only rules are off so upstream merges stay clean; `biome.jsonc` says why.
- **Comments:** say *why*, and link the upstream issue when there is one. Don't
  narrate the obvious, and don't narrate what code replaced.
- **Tooling:** the stack's: Node 22, pnpm through Socket Firewall, `go tool task`
  (`Taskfile.yml`), every CI step one task. `CONTRIBUTING.md` has the commands.

## Build & verify

```bash
go tool task install     # pnpm through sfw; ssh2 patched as it installs
go tool task lint        # biome
go tool task typecheck   # tsc --noEmit
go tool task test        # vitest
go tool task package     # open-remote-ssh.vsix
go tool task ci          # what CI's Gate runs
```

Write the failing unit test first, then the code; prove a new test can fail by
planting the bug. For anything touching the resolver or the tmux terminal layer,
also F5 (Extension Development Host) and a real connect. Re-run developerz-ai's
zombie rows (disconnect → reconnect → same session; re-open → no duplicate) for
any change to the tmux terminal layer.

## Git / PR discipline

- Branch off `main` (in a worktree under `.wt/`); never push to main. One pull
  request per feature, merged by rebase once CI's Gate is green.
- **Fork hygiene:** keep Spinbox's changes in their own modules so upstream
  fixes still merge cleanly. Don't reformat upstream files.

## Guardrails

- This extension executes remote commands/scripts and handles credentials/keys.
  Treat `src/ssh/*`, `src/authResolver.ts`, `src/scripts/*`, and any new
  `src/tmux/*` as security-sensitive: no logging of secrets, no weakening
  host-key verification, no shell injection when building `tmux` command lines
  sent to the remote (quote/escape session names and paths).
- **Terminals only** — don't change the editing/file/protocol path; don't
  regress the base open-remote-ssh experience.
- **Invisible + no zombies** are hard requirements. If a design leaks tmux to the
  user or risks orphaned sessions, surface it — don't ship it quietly.
- tmux is Unix-only — degrade gracefully on Windows remotes, never break the base
  SSH connect.
