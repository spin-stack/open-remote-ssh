# Contributing

Every change goes in by pull request, rebased onto main and merged by rebase once CI's Gate is
green.

## Developing

Needs Go (the tools are pinned in `go.mod` and `versions.yaml`), Node 22, pnpm, and OpenSSH 9.9
or newer - `ssh`, `sshd` and `ssh-keygen`.

```sh
go tool task install     # dependencies, through Socket Firewall
go tool task lint        # Biome
go tool task typecheck   # tsc over src/ and test/
go tool task test        # unit tests (Vitest), with vscode replaced by test/mocks/vscode.ts
go tool task package     # spinbox-remote.vsix
go tool task ci          # what CI runs
go tool task test:e2e SPIN=<spin checkout> VSCODE_COMMIT=<commit>   # the Spinbox resolver, below
```

The unit tests run OpenSSH: `test/sshd.ts` starts a real sshd set up as a workspace's - it admits
certificates only and accepts the key exchange `mlkem768x25519-sha256` alone, which takes
OpenSSH 9.9 - `test/spin/connection.sshd.test.ts` connects to it with this machine's `ssh` as the
extension does, and `test/spin/resolve.test.ts` opens `spin+<workspace>` from the extension's
activation to a request its server answers, with a stand-in CLI and that sshd as the workspace.

## The Spinbox resolver against a real installation

`test/e2e/` drives `src/spin/open.ts` - what the `spin+<workspace>` resolver runs - against
spin's e2e stack and the real spin CLI. In a spin checkout, `go tool task build:cli`,
`go tool task e2e:up` and `go tool task e2e:workspaces` (KVM and `sudo -n`); then here
`go tool task test:e2e SPIN=<that checkout> VSCODE_COMMIT=<commit>`, where the commit is one the
stack published: `e2e:up` publishes the newest two VS Code releases (its log says
`downloading and verifying a VS Code server commit=...`), and its installation downloads no
other. `test/e2e/cli.e2e.test.ts` needs only the CLI (`SPIN_E2E_CLI`): the refusals it gives
with no installation.

F5 in VS Code runs the extension in an Extension Development Host (`.vscode/launch.json`).
