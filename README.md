<div align="center">

# ☕ Subby

### The fast, private subscription tracker that lives on your machine.

No account. No bank linking. No cloud. Your subscriptions, your real monthly and yearly spend, and reminders before you get charged — all computed locally from plain files you own.

<br />

[![Latest release](https://img.shields.io/github/v/release/OpsAlchemist/subby?include_prereleases&sort=semver&label=release&color=92400e)](https://github.com/OpsAlchemist/subby/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/OpsAlchemist/subby/ci.yml?branch=main&label=CI)](https://github.com/OpsAlchemist/subby/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/OpsAlchemist/subby?style=social)](https://github.com/OpsAlchemist/subby/stargazers)

[![Downloads](https://img.shields.io/github/downloads/OpsAlchemist/subby/total?label=downloads&color=1DB954)](https://github.com/OpsAlchemist/subby/releases)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-informational)](https://github.com/OpsAlchemist/subby/releases)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Offline-first](https://img.shields.io/badge/offline-first-success)](#-privacy)

**[⬇️ Download](https://github.com/OpsAlchemist/subby/releases/latest) · [📖 Docs](./docs/README.md) · [🐛 Report a bug](https://github.com/OpsAlchemist/subby/issues) · [💡 Request a feature](https://github.com/OpsAlchemist/subby/issues)**

</div>

---

## Why Subby?

The subscription-tracker market is barbell-shaped. On one side, cloud aggregators demand your bank credentials and upload your financial life. On the other, self-hosted privacy tools are built for developers. The middle — a **polished, cross-platform, no-account, local-first desktop app for ordinary people** — is empty.

Subby owns that gap. It does well the things the incumbents do badly: **reliable native renewal reminders**, **honest multi-currency totals**, **pre-charge free-trial alerts**, and **genuinely fast local analytics** — while nothing ever leaves your device unless you explicitly turn it on.

> **It should feel instant and calm, not like heavy software that phones home.** Opening Subby paints and is interactive in under a second; nothing in the hot path ever waits on a network.

## ✨ Features

- 💸 **Honest spend totals** — what you really pay per month and per year, at a glance.
- 🔔 **Reliable reminders** — OS-native notifications before a renewal (same-day / 1-day / 3-days), fully offline, even when the window is closed (tray mode).
- 🧮 **Subscription management** — add, edit, delete, and organize with rich fields: provider, category, amount, billing cycle (incl. custom intervals), renewal dates, payment method, color, icon, notes.
- 🔎 **Fast list + command palette** — fuzzy search, filter, sort, group, multi-select bulk actions, inline quick-edit, and a `Cmd/Ctrl-K` jump-to-anything palette.
- 📊 **Local analytics** — monthly/yearly totals, category distribution, most-expensive, and an upcoming-renewal timeline — drawn with lightweight inline SVG, no chart library.
- 🗓️ **Calendar** — a monthly grid of renewals with a per-day detail panel.
- 💾 **Your data, your files** — plain JSON on disk, with atomic writes, classified safe-reads, and automatic timestamped backups before anything destructive. Import/export JSON + CSV.
- 🎨 **Theming & accessibility** — dark / light / system themes, a configurable accent, keyboard navigation, ARIA labels, chart text alternatives, high-contrast, and OS font scaling.

> 🛣️ **In active development (1.0 revamp).** A brand-new UI, honest multi-currency (native + home currency with converted totals), free-trial tracking with pre-charge alerts, price history, and an **opt-in** online-enrichment surface (brand logos, FX refresh) — all private-by-default, each disclosing exactly what, if anything, leaves your device. See [`_bmad-output/planning-artifacts`](./_bmad-output/planning-artifacts) for the PRD, UX, and architecture.

## 🔒 Privacy

Privacy is the product, not a setting.

- **No account, no login, no cloud** by default.
- **No telemetry, analytics, or tracking — ever.** This is enforced by a test (`tests/privacy.test.ts`) that fails the build if any network or tracking primitive appears in shipped source.
- **Offline-first.** The core experience is 100% offline; the renderer is sandboxed (`contextIsolation`, `nodeIntegration: false`, `sandbox: true`) behind a strict Content-Security-Policy.
- **Opt-in only.** Any future network feature is off by default and states in plain language what it sends and to whom.

## ⬇️ Install

Download the latest build for your OS from the **[Releases page](https://github.com/OpsAlchemist/subby/releases/latest)**:

| Platform | File |
| --- | --- |
| 🍎 macOS | `.dmg` (x64 / arm64) |
| 🪟 Windows | `.exe` installer |
| 🐧 Linux | `.AppImage` / `.deb` |

> **Beta builds are not yet code-signed.** On first launch:
> - **macOS** — right-click the app → **Open** (or `xattr -dr com.apple.quarantine /Applications/Subby.app`).
> - **Windows** — SmartScreen → **More info** → **Run anyway**.
>
> Code signing and notarization are planned for the stable release.

## 🛠️ Build from source

Requires **Node.js 24.x** and **npm**.

```bash
git clone https://github.com/OpsAlchemist/subby.git
cd subby
npm ci

npm run dev        # run in development
npm run build      # typecheck + production bundle
npm test           # full test suite
npm run dist       # package installers for the current OS
```

Platform-specific packaging: `npm run dist:mac` · `npm run dist:win` · `npm run dist:linux`.

## 🧱 Tech stack

| Concern | Choice |
| --- | --- |
| Desktop shell | Electron 44 (main + preload + sandboxed renderer) |
| UI | React 18 + TypeScript (strict) |
| Build / dev | electron-vite (Vite 5), three-target build |
| Styling | TailwindCSS + shadcn/ui-style CSS-variable tokens |
| Validation | zod (schemas kept in lockstep with TS types) |
| Persistence | local JSON files — no database |
| Charts | hand-rolled inline SVG, no chart library |
| Testing | Vitest, fast-check (property-based), Testing Library, jsdom, jest-axe |
| Packaging | electron-builder (dmg/zip · nsis · AppImage/deb) |

Subby is organized in three layers: a **pure, portable `core/`** (billing, renewal, money, analytics, migration — zero Electron/React/Node imports), an **`electron/` main process** (storage adapter, services, IPC), and a **sandboxed `src/` React renderer** whose only capability is a typed `window.subby` bridge. See [`docs/architecture.md`](./docs/architecture.md).

## 📖 Documentation

Full documentation lives in [`docs/`](./docs/README.md):

- [Overview](./docs/overview.md) · [Getting Started](./docs/getting-started.md) · [Architecture](./docs/architecture.md)
- [Data Model](./docs/data-model.md) · [Storage & Recovery](./docs/storage-and-recovery.md) · [IPC API](./docs/ipc-api.md)
- [Privacy & Security](./docs/privacy-and-security.md) · [Testing](./docs/testing.md) · [Contributing](./docs/contributing.md)

## 🤝 Contributing

Contributions are welcome! Please read [`docs/contributing.md`](./docs/contributing.md) first.

- Never push to `main` — land changes via a pull request from a feature branch.
- The pre-PR gate (and CI) runs all three: `npm run typecheck`, `npm test`, `npm run build`.
- Keep the privacy promise intact — the privacy test must stay green.

Found a bug or have an idea? [Open an issue](https://github.com/OpsAlchemist/subby/issues).

## 💛 Support

Subby is free and open source. If it saves you from a surprise charge, consider supporting its development:

<a href="https://buymeacoffee.com/mrkc" target="_blank"><img src="https://img.shields.io/badge/Buy%20me%20a%20tea-%E2%98%95-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=black" alt="Buy me a tea" /></a>

## 👤 Author

**Mr. K** (OpsAlchemist)

[![GitHub](https://img.shields.io/badge/GitHub-OpsAlchemist-181717?logo=github&logoColor=white)](https://github.com/OpsAlchemist)
[![Twitter / X](https://img.shields.io/badge/X-@KubeMonk-000000?logo=x&logoColor=white)](https://x.com/KubeMonk)
[![Buy me a tea](https://img.shields.io/badge/Buy%20me%20a%20tea-%E2%98%95-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/mrkc)

## 📄 License

[MIT](./LICENSE) © Mr. K (@KubeMonk), OpsAlchemist

<div align="center">
<br />
<sub>Built with care for people who just want to know what they're paying for. ☕</sub>
</div>
