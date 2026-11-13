# Spinbox Remote

The VS Code extension that opens [Spinbox](https://github.com/spin-stack/spin) workspaces: a
window on `vscode-remote://spin+<workspace>/<path>` connects to the workspace through the spin
CLI, with no SSH configuration of its own, and whatever refuses is shown in VS Code with what to
do. The [Spinbox extension](https://github.com/spin-stack/vscode-spinbox) opens workspaces
through it ([spin-stack/vscode-spinbox#24](https://github.com/spin-stack/vscode-spinbox/issues/24)).

It began as a fork of open-remote-ssh ([Credit](#credit)) and keeps only what opening a Spinbox
workspace uses.

## How a workspace opens

- `ssh -V` says this machine's OpenSSH is 9.9 or newer (below);
- `spin code <workspace> --no-open --vscode-commit <this editor's commit> --start` has the
  workspace running with the VS Code server for this commit on the extension disk the
  installation publishes;
- `spin ssh-session -o json` opens a session, checking the workspace's launch claim, and answers
  the host key it names, the certificate the workspace signed for this machine's key and the
  session's name; this machine's `ssh` connects, carried by `spin tunnel <session>` as its
  ProxyCommand, accepts that host key only, and logs in with that certificate - one connection
  (a ControlMaster) that everything after rides on;
- the server is started from the extension disk, and **never downloaded**: a workspace
  without it is refused with what to do;
- VS Code reaches the server through a port on this machine's loopback, each of its
  connections an `ssh -W` through that one;
- whatever refuses - a key the installation has not enrolled (`Spin-Refused:
  key-not-enrolled`), a profile not signed in, an installation that does not answer - is shown
  in VS Code with the CLI's words and the one thing to do.

The CLI is the setting `remote.spin.cliPath`, or the one the Spinbox extension carries, or `spin`
on the PATH. `Spinbox: Show Connection Log` shows what each open did.

### OpenSSH 9.9 or newer, on Linux or macOS

A workspace's sshd accepts one key exchange, the post-quantum `mlkem768x25519-sha256`, which
OpenSSH added in 9.9, and refuses an older client with `no matching key exchange method found`.
The `ssh` on the PATH is asked its version first, and an older one is refused before anything
else runs, in VS Code:

```
Spinbox could not open my-workspace: ssh is OpenSSH 9.6 (OpenSSH_9.6p1 Ubuntu-3ubuntu13.20); a
workspace needs OpenSSH 9.9 or newer. Its sshd accepts only the post-quantum key exchange
mlkem768x25519-sha256, which OpenSSH added in 9.9, and refuses older clients. Update OpenSSH (on
macOS, 'brew install openssh') and open the workspace again.
```

An `ssh -V` it cannot read is let through, with a line in the log. The connection reads none of
your `~/.ssh/config`. Windows is refused: there is no spin CLI for it, and OpenSSH for Windows
has no ControlMaster.

## Install

The extension is `spin-stack.spinbox-remote`. It resolves a remote authority through VS Code's
proposed `resolvers` API, and the Visual Studio Marketplace refuses an extension that uses a
proposed API, so it is published outside it: each release's VSIX is attached, with its signed
SHA256SUMS, to its [GitHub release](https://github.com/spin-stack/open-remote-ssh/releases).
`spin vscode install` installs it beside the Spinbox extension, held to the digest the spin
release pins.
`go tool task package` builds `spinbox-remote.vsix` from a checkout, and
`Extensions: Install from VSIX…` installs it.

An extension may use a proposed API only when the editor is told to let it: in `argv.json`
(`Preferences: Configure Runtime Arguments`; `~/.vscode/argv.json` for Microsoft's VS Code),

```json
{
    "enable-proposed-api": ["spin-stack.spinbox-remote"]
}
```

and the editor restarted. The server a Spinbox installation publishes is Microsoft's VS Code
server, so the editor is Microsoft's VS Code. Whether its stable release honours
`enable-proposed-api` for an extension it did not ship is still to verify
([spin-stack/vscode-spinbox#24](https://github.com/spin-stack/vscode-spinbox/issues/24)).

## Developing

[CONTRIBUTING.md](CONTRIBUTING.md): Go (for `go tool task`), Node 22 and pnpm, and
`go tool task ci` runs what CI runs.

## Credit

This extension is a fork of
[developerz-ai/open-remote-ssh-tmux](https://github.com/developerz-ai/open-remote-ssh-tmux),
itself a fork of [jeanp413/open-remote-ssh](https://github.com/jeanp413/open-remote-ssh), which
resolves the `ssh-remote` authority over SSH; the connection here began as their
`SSHConnection`, and the server's answer is read as their install script writes it. Both are MIT
licensed, and their copyright notices are kept in [LICENSE.txt](LICENSE.txt), as is this
fork's licence.
