# Contributing

Every change goes in by pull request, rebased onto main and merged by rebase once CI's Gate is
green.

## Developing

Needs Go (the tools are pinned in `go.mod` and `versions.yaml`), Node 22 and pnpm.

```sh
go tool task install     # dependencies, through Socket Firewall; ssh2 is patched as it installs
go tool task lint        # Biome
go tool task typecheck   # tsc over src/ and test/
go tool task test        # unit tests (Vitest), with vscode replaced by test/mocks/vscode.ts
go tool task package     # open-remote-ssh.vsix
go tool task ci          # what CI runs
```

F5 in VS Code runs the extension in an Extension Development Host (`.vscode/launch.json`).

## ssh2

ssh2 1.17.0 lacks the ECDSA signature fix jeanp413's ssh2 fork carried, so pnpm patches it as it
installs (`patches/ssh2@1.17.0.patch`, `patchedDependencies` in `pnpm-workspace.yaml`), and
`test/ssh/ssh2.security.test.ts` holds the installed tree to the fix and to strict key exchange
(Terrapin). A bump of ssh2 installs unpatched, which that test refuses: make the patch again with
`pnpm patch ssh2@<version>` and `pnpm patch-commit`, or delete it when ssh2 has the fix.

## Following upstream

`upstream` is developerz-ai/open-remote-ssh-tmux, which follows jeanp413/open-remote-ssh. The
fork keeps upstream's code style and import order (the formatter is off, `biome.jsonc` says
why), so a merge from upstream conflicts only where the code differs.
