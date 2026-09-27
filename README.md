# Tern

A free, open source SSH and SFTP client for the desktop, built with [Tauri 2](https://tauri.app), Rust and React.

## What works today

- **Hosts**: add, edit and delete hosts, organised into color-coded groups with tags. Reachability and latency show in the host list.
- **Terminal**: tabbed SSH sessions using xterm.js (WebGL renderer, 256-color and truecolor, clickable links). Sessions keep running while you switch tabs or views. Log output is easier to scan: levels (INFO, WARN, ERROR) and HTTP methods are bold and colored, and timestamps are dimmed, while the message itself stays plain. This works in pagers like `less` and `journalctl` too, and scrolling in them is faster. It can be switched off in Settings, and output that sets its own colors, and interactive apps like `vim` and `htop`, are left alone.
- **Authentication** works like OpenSSH: ssh-agent, then `~/.ssh/id_ed25519` / `id_ecdsa` / `id_rsa`, then password. You can also pick a key file for a host. Encrypted keys, keyboard-interactive and two-factor prompts are all supported.
- **Host key verification**: you're asked about unknown keys, and changed keys are flagged. Tern reads `~/.ssh/known_hosts` but only ever writes its own file.
- **SFTP**: local and remote panes side by side, with upload and download of files or whole folders, a progress queue with cancel, drag and drop (including from Finder), new folder, rename and delete. It reuses an open terminal connection to the same host, so there's no second login.
- **Keychain**: save a key once and use it on any number of hosts. You can import one by pasting it or choosing a file (OpenSSH, PEM or PKCS#8, with or without a passphrase), or generate an Ed25519 key. Each key shows its fingerprint, public key (with a copy button) and the hosts using it.
- **Command palette** (⌘K) for connecting, browsing files and switching views.
- **Four layouts** (sidebar, rail, minimal, focus) and dark, light and system themes.

## What's designed but not built yet

The design in [`design/`](design/) also covers port forwarding, snippets, split panes, an encrypted vault synced through your own git remote, idle lock, biometric unlock, and a mobile app. The data model is set up for sync: every record has a UUID and `updated_at`, and secrets are kept apart from host records.

## Where your data lives

- Hosts, groups and session history are in a local SQLite database in the app data directory.
- Host passwords, and passphrases for key files on disk, go in the OS credential store (macOS Keychain, Windows Credential Manager, or Secret Service on Linux), and only when you choose to save them.
- Keys saved in the keychain are sealed with AES-256-GCM using a random vault key, and only that vault key goes in the OS credential store (key files are too big for some of them). The UI never receives a saved private key.
- Keys used as files on disk stay where they are. Tern reads them when it connects.

## Development

Prerequisites: [Rust](https://rustup.rs), Node 20+, and the [Tauri system dependencies](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install
npm run tauri dev
```

### Working on the UI without Rust

`npm run dev` serves the UI at http://localhost:1420 using a fake backend (`src/dev/mockBackend.ts`) with sample hosts, a toy shell and simulated transfers. It only loads in development, outside Tauri.

### Tests

The backend integration test runs Tern's real connection, authentication, terminal and SFTP code against a real `sshd`. It is skipped unless you point it at one:

```bash
TERN_TEST_SSH_PORT=2222 TERN_TEST_KEY_DIR=/path/to/keys cargo test --manifest-path src-tauri/Cargo.toml
```

`TERN_TEST_KEY_DIR` must contain `client_plain` (no passphrase) and `client_pass` (passphrase `hunter2`), both authorized for the current user on `127.0.0.1`.

## Project layout

```
src/                 React UI
  lib/               state (zustand), backend bindings, terminal and SFTP managers
  views/             Hosts, Terminal, SFTP, Settings
  components/        layout chrome, command palette, dialogs
  styles/            design tokens and styles
  dev/               mock backend for browser-only development
src-tauri/src/       Rust backend
  ssh.rs             connect, host key checks, authentication
  terminal.rs        interactive shell sessions
  sftp.rs            SFTP, local listing, transfers
  db.rs              SQLite store
  keychain.rs        saved keys: import, generate, load
  vault.rs           AES-256-GCM sealing for saved keys
  secrets.rs         OS credential store
design/              the Claude Design source for the UI
```

## License

MIT
