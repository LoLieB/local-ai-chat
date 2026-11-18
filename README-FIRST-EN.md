# Local AI Chat — start here

[English](README-FIRST-EN.md) | [Русский](README-FIRST-RU.md)

Open the [PDF guide](docs/Local-AI-Chat-Guide-EN.pdf) or its [Markdown source](docs/Local-AI-Chat-Guide-EN.md). Windows x64 BAT launchers require no manual terminal commands.

1. Extract the entire archive into a writable folder.
2. Double-click `1_INSTALL.bat`. Internet is required for dependencies. Wait for installation and the build.
3. If Node.js is missing, https://nodejs.org/en/download opens. Download the Windows Installer for a supported LTS release, install with npm, then run the BAT again. Node.js 20.19+ or 22.12+ is required.
4. On first setup, choose an admin password of 12–256 characters and enter it twice. Input is completely hidden; press Enter after each entry. The password is stored as a hash, not in a BAT or `.env`.
5. After setup reports success, open `2_START.bat`. The browser opens after the server is ready. Sign in as `admin` with your password.
6. Keep the launcher window open. Press Enter in that window to stop normally. For daily use, start at step 5.

Re-running setup preserves accounts, passwords, `project/server-data` and an existing `.env`. Stop the application first. On failure, the window remains open and does not report success. The launcher does not terminate another process occupying the port; close that application normally.

If installing Node.js requires unavailable privileges, extract its entire official Windows x64 ZIP into `runtime/node` next to project, including node.exe, node_modules/npm and LICENSE. No runtime is bundled; this alternative has not been tested on clean Windows.

Install LM Studio from https://lmstudio.ai/ , load a model, open Developer and start the server. In Local AI Chat Settings, enter its URL and model ID. A typical same-computer URL is `http://127.0.0.1:1234/v1`. The app opens without LM Studio, but cannot generate replies.

Backups are available in Settings. For a complete backup, stop the app and copy `project/server-data` and `project/.env` to a protected location. No separate backup BAT is provided. Manual startup remains documented in project/README.md.

The model runs separately. Connect a compatible server as described in chapter 5; chapters 8 and 10 cover backups and security. Choose English or Russian on the sign-in screen or in Settings. The browser remembers your choice. Project files are distributed under the [MIT license](project/LICENSE).
