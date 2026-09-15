<div align="center">

<img src="docs/logo.svg" width="72" alt="Daedalus CRM" />

# Daedalus CRM

**The next-generation CRM that runs on your own machine. AI drafts, you decide.**

A CRM for teams of 1–20: leads → customers → follow-ups → deals → contracts, with referral attribution computed for you.<br/>
The home page is an agent: ask a question and it decides what to look up; ask it to change data and it hands you a proposal card — nothing is written until you confirm.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![CI](https://github.com/BeckY824/daedalus-crm/actions/workflows/ci.yml/badge.svg)](https://github.com/BeckY824/daedalus-crm/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/BeckY824/daedalus-crm?label=release&sort=semver)](https://github.com/BeckY824/daedalus-crm/tags)
[![Docker](https://img.shields.io/badge/ghcr.io-daedalus--crm-2496ED?logo=docker&logoColor=white)](https://github.com/BeckY824/daedalus-crm/pkgs/container/daedalus-crm)
[![Stars](https://img.shields.io/github/stars/BeckY824/daedalus-crm?style=social)](https://github.com/BeckY824/daedalus-crm/stargazers)

[简体中文](README.md) · **English**

[Website](https://ai-daedalus.com) · [Live demo](https://app.ai-daedalus.com/demo) · [Deployment](docs/部署.md) · [Roadmap](ROADMAP.md) · [Issues](https://github.com/BeckY824/daedalus-crm/issues)

</div>

<br/>

<div align="center">

**100% open source &nbsp;·&nbsp; Self-hosted, data never leaves your network &nbsp;·&nbsp; AI only drafts — every write is a human click**

</div>

- ✅ One command: `docker compose up -d`. Zero config, no credit card
- ✅ The home page is an agent: ask about a customer or a number and it decides what to search, read and query — every step visible
- ✅ Tell it "log a call", "mark as signed", "schedule next Wednesday", "create a deal" — it returns an editable proposal card; nothing lands until you confirm
- ✅ Paste a chat transcript on a record page; AI turns it into a follow-up, tasks and next steps, with the original kept
- ✅ Referral attribution: who introduced whom and whose performance it counts toward, frozen at entry — upstream edits never rewrite history
- ✅ Phone dedup, double-confirm on repeated contract amounts, field-level merge on concurrent edits, full audit trail
- ✅ Model-agnostic: DeepSeek, OpenAI, local Ollama or any OpenAI-compatible relay — set it in Settings
- ✅ Ships with education-industry wording; rename the terms once and it fits any sales team

<br/>

![Home: the agent conversation](docs/shots/02-dashboard.png)

<br/>

## 🚀 Getting started

### Docker (recommended)

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
docker compose up -d
```

### Or run locally (Node 22+)

```bash
git clone https://github.com/BeckY824/daedalus-crm.git && cd daedalus-crm
npm install && npm run setup && npm run dev
```

Open **http://localhost:3000** and sign in with a demo account:

| Username | Password | Role |
|---|---|---|
| `admin` | `admin123` | Administrator |
| `zhangsan` | `admin123` | Sales (demo) |
| `lisi` | `admin123` | Sales (demo) |

Change the password under Settings → Change password. That's it.

- **Enable AI**: Settings → AI, enter the endpoint, API key and model, hit "Test connection". Without it the AI entry points simply don't appear; everything else works
- **Not in education?** Settings → Business config lets you rename "student" to "customer" and "school / grade / major" to your own fields, site-wide
- **HTTPS, upgrades, backups**: see [docs/部署.md](docs/部署.md)

### Hosted trial

Don't want to deploy? Sign up with your email at [app.ai-daedalus.com/signup](https://app.ai-daedalus.com/signup) and get your own workspace in a minute — email, verification code, password, team name, and nothing else in the way. 7-day full trial; read-only afterwards, nothing deleted. AI chat comes with 30 free calls on sign-up, plus 3 more each day you use it. Forgotten your password? "Forgot password?" on the sign-in page handles it — no need to ask us. Or click around the [live demo](https://app.ai-daedalus.com/demo): no sign-up, no code.

### Desktop apps

The Mac build (Apple silicon) **ships the whole server inside the app**: install it and it runs, your data is a single file on your machine, no server and no account required.

Two ways to get AI: sign in to a cloud account from the menu (30 free calls; the sign-in window also links out to sign-up and can reset your password), or put your own model API key in **Settings → AI**, which bypasses our allowance entirely — the key is encrypted on your machine and only ever sent to the endpoint you typed. The settings page tells you which of the two is in use and how many calls are left.

To share one database across a team, switch the menu to "Connect to a server" and point it at your own deployment. There are no Windows or Intel Mac builds yet; on those machines use the self-hosted version for now.

Builds are produced by [GitHub Actions](https://github.com/BeckY824/daedalus-crm/actions/workflows/desktop.yml) on every tag. Install, Gatekeeper and updates: [docs/桌面端安装.md](docs/桌面端安装.md).

<br/>

## ✨ Key features

### The home page is an agent, not a search box

Interaction modeled on Claude Code / Codex: Enter to send, follow-ups queue while it's answering, Esc to interrupt. Underneath is a ReAct loop where the model picks read-only tools — search customers, read a record, query a metric, check the watchlist — each call shown as a line, collapsed to a one-line summary when done. Answers stream token by token with citation chips that jump back to the source record. Multi-turn context is kept, so "what about him?" just works.

### AI proposes, you decide

Ask it to change a status or profile field, log a follow-up, schedule a plan, create a lead / deal / contract, or edit a channel — it returns a **proposal card**. Fields are editable in place; unknown ones are left blank for you. Confirming runs the exact same server actions the UI uses: dedup, cycle checks, attribution recompute and audit logging are never bypassed. Every confirmation is logged as `ai_apply`.

### Three-column record page

Profile on the left, editable with a click; a single timeline in the middle; a quick-note box on top where you paste a chat and AI drafts the follow-up, tasks and next plan for you to review — the original text is kept for later briefings. AI stays docked on the right and has already read the record you opened.

### Referral attribution with one clear rule

Channel → student → referred student: attribution goes two generations up, or to the top of the chain if shorter; the channel owner is inherited along the whole chain. Attribution is frozen at entry — **changing an upstream referrer or a channel's owner never rewrites existing students' performance**. Individual mistakes are corrected on that one record.

### Optional multi-tenant hosting

Same codebase; `MULTI_TENANT=1` turns on hosting: one SQLite file per workspace (physical isolation), email sign-up with a verification code, self-service password reset, 7-day trial, read-only after expiry, subscriptions and an ops console, a free-AI-credits ledger (30 on sign-up, 3 per active day). Self-hosted installs never execute a line of it.

### Model-agnostic, per-user switching

Configure a model list in Settings (or pull it from the endpoint) and switch right under the input box — each user picks their own. Reasoning models' "always thinking" quirks and token-budget issues are handled automatically.

<br/>

## 🧩 Use cases

| Scenario | How |
|---|---|
| **Education / study-abroad admissions** | The default wording: students, schools, grades, majors, channel teachers, referral attribution |
| **Any small sales team** | Rename the terms in Settings; the lead → customer → deal pipeline is generic |
| **Self-hosted, sensitive data** | One container, one SQLite file — backup is a file copy; AI is read-only |
| **No deployment wanted** | Hosted: sign up and get an isolated workspace in a minute |

<br/>

## 🖼️ Screens

| Customers | Record page (three columns) |
|---|---|
| ![](docs/shots/04-customers.png) | ![](docs/shots/05-customer-detail.png) |

| Deal pipeline | Dashboard |
|---|---|
| ![](docs/shots/08-pipeline.png) | ![](docs/shots/02b-overview.png) |

More in [docs/shots](docs/shots).

<br/>

## 🛠️ Tech stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 · React 19 · TypeScript 5 |
| Data | Prisma 6 · SQLite (one file per install; one per workspace when hosted) |
| UI | Ant Design 6 · motion |
| AI | OpenAI-compatible API, ReAct loop, read-only tools; DeepSeek / OpenAI / Ollama / relays |
| Tests | vitest (529 unit) · Playwright (58 self-hosted + 13 hosted e2e) · green CI required to merge |
| Delivery | Multi-arch Docker image (GHCR) · Electron desktop (macOS, Apple silicon) · Caddy auto-HTTPS |

<br/>

## 🗺️ Roadmap

Ordered by "someone actually needs it". To push an item, [open an issue](https://github.com/BeckY824/daedalus-crm/issues) with your scenario. Full version in [ROADMAP.md](ROADMAP.md).

| Area | Scope | Status |
|---|---|---|
| Conversation & proposal cards | agent loop, streaming, citations, multi-turn context, 7 card types | ✅ Shipped |
| Record page | inline profile editing, timeline, quick-note parsing, docked AI | ✅ Shipped |
| Hosting | multi-tenant, sign-up and free credits, trials, subscriptions, ops console, desktop apps | ✅ Shipped |
| List pages | inline editing, saved views, filter chips, side drawer | 🔜 Planned |
| ⌘K & motion | command palette for "ask about / ask a number / go to" | 🔜 Planned |
| Online payments | WeChat / Alipay (requires ICP filing & merchant account) | ⏸ On demand |

<br/>

## 🤝 Contributing

Issues and PRs welcome. Development, testing and commit conventions are in [CONTRIBUTING.md](CONTRIBUTING.md); conventions for AI coding assistants in [AGENTS.md](AGENTS.md).

<a href="https://github.com/BeckY824/daedalus-crm/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=BeckY824/daedalus-crm" alt="contributors" />
</a>

<br/>

## 🔒 Security

Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md) rather than opening a public issue.

<br/>

## 📄 License

[AGPL-3.0](LICENSE): use and modify freely when self-hosting; if you modify it and offer it as a service, publish your changes.

<br/>

## 🌐 Community & contact

- Website: [ai-daedalus.com](https://ai-daedalus.com)
- Live demo: [app.ai-daedalus.com/demo](https://app.ai-daedalus.com/demo)
- Questions & ideas: [GitHub Issues](https://github.com/BeckY824/daedalus-crm/issues)
- Business & trials: [Book a demo](https://ai-daedalus.com/demo.html) · qy1g18@gmail.com

<br/>

## ⭐ Star History

<a href="https://star-history.com/#BeckY824/daedalus-crm&Date">
  <img src="https://api.star-history.com/svg?repos=BeckY824/daedalus-crm&type=Date" alt="Star History" width="600" />
</a>
