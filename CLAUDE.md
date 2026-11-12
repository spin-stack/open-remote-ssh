# CLAUDE.md — open-remote-ssh (Spinbox Remote)

## What this is

`spin-stack/open-remote-ssh`, shown as Spinbox Remote: the VS Code extension that resolves the
`spin+<workspace>` remote authority, which the Spinbox extension (spin-stack/vscode-spinbox)
opens workspaces through (spin-stack/vscode-spinbox#24). It began as a fork of
developerz-ai/open-remote-ssh-tmux, itself a fork of jeanp413/open-remote-ssh, and keeps only
what opening a Spinbox workspace uses: no `ssh-remote` resolver, ~/.ssh/config, password
prompts, server download, tmux terminals or clipboard bridge. The editor it targets is
Microsoft's VS Code: the server a Spinbox installation publishes is Microsoft's.

A feature lands here when the Spinbox path calls it, with a test that reaches it through that
path.

## Architecture

| File | Responsibility |
|------|----------------|
| `src/extension.ts` | Activation: the resolver registered for `spin`, the show-log command. |
| `src/logger.ts` | The output channel. |
| `src/spin/authority.ts` | `spin+<workspace>` parsed, and the ssh host the CLI knows it as. |
| `src/spin/resolver.ts` | The VS Code resolver: this editor's commit, progress, the local port, a refusal shown with its action. |
| `src/spin/open.ts` | The flow, with no VS Code in it so `test/e2e` drives it: `spin code`, `spin ssh-prepare`, ssh2 over `spin ssh-proxy`, the server started. |
| `src/spin/cli.ts` | The spin CLI, the only client of an installation. |
| `src/spin/contract.ts` | The CLI's JSON answers. |
| `src/spin/session.ts` | What ssh-prepare leaves in `~/.spin/ssh/hosts/<host>/`. |
| `src/spin/keys.ts` | The workspace's certificate as an ssh2 key; the host key pinned to the launch claim's. |
| `src/spin/connection.ts` | The ssh2 connection: exec, a channel, the loopback port to the server. |
| `src/spin/serverStart.ts` | The server from the extension disk, never downloaded, and its answer read. |
| `src/spin/refusal.ts` | What a person is shown. |
| `src/typings/` | VS Code's proposed `resolvers` API, as Microsoft wrote it. |

## Conventions

- **Language:** TypeScript, `strict`. No `any`, no unused locals/params, explicit `override`.
  `tsconfig.json` typechecks `src/` and `test/` together; esbuild bundles (`esbuild.mjs`).
- **Indentation:** 4-space (`.editorconfig`). YAML 2-space, JSON tabs. LF, final newline.
- **Lint:** Biome (`biome.jsonc`), warnings fail; the formatter is off.
- **Comments:** say *why*. Don't narrate the obvious, and don't narrate what code replaced.
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
go tool task test:e2e SPIN=<spin checkout> VSCODE_COMMIT=<commit>   # against spin's e2e stack
```

Write the failing unit test first, then the code; prove a new test can fail by planting the bug.
`test/spin/resolve.test.ts` opens `spin+<workspace>` from activation to the server's answer;
a change to the flow runs `test:e2e` against a real stack too.

## Git / PR discipline

Branch off `main` (in a worktree under `.wt/`); never push to main. One pull request per
feature, merged by rebase once CI's Gate is green.

## Guardrails

The extension runs commands in a workspace and holds a connection authenticated by the person's
key: no logging of secrets (the server's token included), no weakening of the pinned host key,
no unquoted value in a command sent to the workspace.
