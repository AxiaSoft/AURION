# AURION

Intelligent live execution operating system for **MetaTrader 5**.

AURION never invents candles, fills, equity, or AI signals. If the terminal is unreachable the desk shows a disconnected state and waits for a real tape.

```
MT5 terminal ── AurionBridge.mq5 ──┐
                                   ├── Python engine (AI, strategies, prop, backtest)
MT5 Python API (Windows) ──────────┘              │
                                                  ▼
                                         Node.js desk API + WebSocket
                                                  │
                    ┌─────────────────────────────┴──────────────────────────┐
                    ▼                                                        ▼
              Web desk on Windows                                  Hidden engine + desk
```

## What you get

- Live MT5 bridge (official Python package on Windows **and** a socket/file EA on every chart)
- AI that trains only on real OHLC from that account
- Hot-swappable Python strategies with a sandboxed loader
- Prop-firm rules (daily loss, drawdown, lot, hours, optional news calendar)
- Backtester that refuses to run without real history
- Liquid-glass desk in English, فارسی, العربية with live RTL/LTR
- Excel export with translated headers and P/L colouring
- 30-day archive / reset
- Read-only **Telegram** status bot (open/close alerts with live P/L — no trading commands)

## Repository layout

| Folder | What lives there |
|---|---|
| `backend/` | Node.js desk API, WebSocket fan-out, Excel export |
| `engine/` | Python engine: AI, strategies, prop rules, backtest, MT5 bridge |
| `apps/web/` | The desk UI (served by the backend on :8080) |
| `config/`, `lang/`, `data/` | Configuration, translations, live state |
| `scripts/` | Day-to-day helpers used by `start-aurion.cmd` (`hidden.vbs`, `copy-ea.ps1`, `restart-aurion.cmd`, `fix-npm.ps1`, `fix-numpy.ps1`) |
| [`windows-app/`](windows-app/README.md) | **The Windows application and everything that builds it** — Electron app, prerequisite installers, MSI packaging |
| [`store/`](store/README.md) | **The shop** — standalone key server / store (own app, own deploy) |
| [`admin/`](admin/README.md) | **Owner/admin tooling** — local key minting, update server and its hidden panel |

## Windows — prerequisites install themselves

Copy the **full** tree to `D:\aurion` (not nested `D:\aurion\aurion`).

| When | What to run |
|---|---|
| First time | **`windows-app\installer\install-aurion.cmd`** |
| Every later day | **`start-aurion.cmd`** |
| Stop | **`stop-aurion.cmd`** |

`windows-app\installer\install-aurion.cmd` downloads and silently installs **Python 3.12** and **Node.js 18+** (22 LTS or 26) if they are missing (winget first, else official python.org / nodejs.org), then `pip` + `npm`, copies `AurionBridge.mq5` **1.17** into every local `MQL5\Experts\Aurion`, opens the Private-network firewall for port **8080**, and launches the desk.

`start-aurion.cmd` calls the same installer automatically when a prerequisite is missing, waits for `/api/health` before opening the browser, and runs engine + desk **hidden**. Logs live inside the dashboard (**Terminal**).

Python must be **3.10, 3.11 or 3.12** (3.12 preferred). **Never 3.13 or 3.14** — `engine/main.py` exits on them and `numpy==1.26.4` has no 3.13 wheels. Node **18 to 30** is fine, including **26**.

Desk: `http://127.0.0.1:8080`  
Install guide (FA / EN / AR): `http://127.0.0.1:8080/guide-install.html`

First launch creates the administrator. There is no factory password.

## Linux / macOS host (desk only)

```bash
cd aurion
bash scripts/setup.sh
bash scripts/start.sh
```

Execution still needs a Windows/VPS MetaTrader 5 terminal with AurionBridge attached.

## MetaTrader 5

Compile `engine/ea/AurionBridge.mq5` with **F7**. Version must be **1.17**. Attach it to every chart you want on the desk. AutoTrading green. Not Strategy Tester.

WebRequest is optional. If you want HTTP too, allow-list:

- `127.0.0.1`
- `http://127.0.0.1`
- `http://127.0.0.1:18765`
- `http://127.0.0.1:8080`

## Documentation

Interactive three-language guides inside the desk:

- `/guide-install.html` — Windows install
- `/guide.html` — how the robot trades
- `/guide-backtest.html` — backtest

Markdown (each topic in EN / AR — this tree has no `docs/fa/`; the Persian
guides ship inside the desk as `apps/web/guide*.html`):

| Topic | EN | AR |
|---|---|---|
| Installation | [docs/en/01-installation.md](docs/en/01-installation.md) | [docs/ar/01-installation.md](docs/ar/01-installation.md) |
| System setup | [docs/en/02-system-setup.md](docs/en/02-system-setup.md) | [docs/ar/02-system-setup.md](docs/ar/02-system-setup.md) |
| Troubleshooting | [docs/en/03-troubleshooting.md](docs/en/03-troubleshooting.md) | [docs/ar/03-troubleshooting.md](docs/ar/03-troubleshooting.md) |
| User manual | [docs/en/04-user-manual.md](docs/en/04-user-manual.md) | [docs/ar/04-user-manual.md](docs/ar/04-user-manual.md) |
| Advanced | [docs/en/05-advanced.md](docs/en/05-advanced.md) | [docs/ar/05-advanced.md](docs/ar/05-advanced.md) |

Windows app and store documentation moved with the code:
[`windows-app/docs/`](windows-app/README.md), [`admin/`](admin/README.md),
[`store/`](store/README.md).

## Windows only

AURION is a Windows desk. There is no Android app, APK, Flutter project, or Android SDK in this tree. The official MetaTrader 5 **mobile** application cannot host Expert Advisors and has no public trade API. Execution always happens on the Windows / VPS terminal where `AurionBridge.mq5` (or the official Python API) is running.

## Licence

Private desk software. Use on accounts you are authorised to trade. Prop-firm compatibility means the rules engine can enforce typical challenge constraints — it does not replace the firm’s own legal terms.

## Licensing (product key + key server)

AURION runs in **freemium** mode until a product key is activated:

- **Key gate on boot** — no username/password. Premium machines never see the key screen; freemium/expired machines meet it every start and can continue free with *“I don’t have a key”*.
- **Freemium mode** keeps live trading, the desk and the built-in strategies. **Prop profiles, scalping style and custom strategy upload are locked** (enforced server-side in the engine, not just in the UI).
- **Premium** — activate a key once (online, one-time): it binds to the machine, the plan (۱/۳/۶/۱۲ months) starts at first activation and the desk shows the type, plan, expiry and days left in the **Account upgrade** page and the sidebar footer (logo + copyright year follows the UI language: Gregorian / شمسی / هجری).
- **Lost key / reinstall / new PC** — keys are single-use. The customer gets a **free replacement** from the store website (old key dies), or re-activates the same key when the machine fingerprint still matches.
- **Key server** — the standalone issuer lives in [`store/keyserver/`](store/keyserver/README.md) (own app + sample store + ZarinPal). It is NOT part of the desk: register with Gmail or Iranian mobile + password → OTP verification at first login → anti-bot captcha → pay → key. Admin (owner) mints/revokes keys with `ADMIN_TOKEN`.

Connect the desk to your key server via env or `config/aurion.json → license`:

```
AURION_KEYSERVER_URL=https://your-keyserver
AURION_STORE_URL=https://your-keyserver
```
