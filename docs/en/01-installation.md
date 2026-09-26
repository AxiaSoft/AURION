# AURION Installation (English)

AURION never invents a market. After install the desk is empty until AurionBridge sits on a live MetaTrader 5 chart.

## Windows — manual setup

1. Copy the full tree to `D:\aurion` (not nested `D:\aurion\aurion`).
2. Install **Python 3.10 / 3.11 / 3.12** (never 3.13 or 3.14) and **Node.js 18+**.
3. Run `pip install -r engine\requirements.txt`, then `npm install` inside `backend`.
4. Start **`start-aurion.cmd`** — it copies `AurionBridge.mq5` into every local `MQL5\Experts\Aurion` folder and launches engine + desk hidden.
5. The desk opens at `http://127.0.0.1:8080`. First launch creates the administrator — there is no factory password.

Daily start is **`start-aurion.cmd`**. Stop with **`stop-aurion.cmd`**.

Allow inbound TCP **8080** on the Windows Private firewall so the local desk is reachable on the machine (Settings → Firewall, or add the port yourself).

Do **not** use Python 3.13 or 3.14. Node **18+** is fine, including **26**.

## What the machine needs

| Piece | How |
|---|---|
| Python 3.12 | winget `Python.Python.3.12` or `python-3.12.10-amd64.exe /quiet` |
| Node.js 18+ (22 or 26) | existing install, winget, or official MSI |
| Engine stack | `py -3.12 -m pip install -r engine\requirements.txt` |
| MetaTrader5 Python package | installed when the wheel exists (Windows only) |
| Desk | `npm install` in `backend` |
| EA file | copied by `start-aurion.cmd` into each local MT5 Experts folder |

## MetaTrader 5 + EA 1.17

1. Install the broker terminal. Log into an account you are allowed to trade.
2. MetaEditor → open `D:\aurion\engine\ea\AurionBridge.mq5` → **F7**. Version must be **1.17**.
3. Attach it to every chart you want on the desk. AutoTrading green. Not Strategy Tester.
4. Experts tab: `hello delivered v1.17` or `file inbox writing`.
5. WebRequest is optional. If you want HTTP too, allow-list exactly:
   - `127.0.0.1`
   - `http://127.0.0.1`
   - `http://127.0.0.1:18765`
   - `http://127.0.0.1:8080`

Inputs: `InpEngineHost=127.0.0.1` on the same PC (otherwise the engine IP). `InpHttpPort=18765`.

## Windows only

AURION does not ship an Android app, APK, Flutter project, or Android SDK. Official MT5 mobile **cannot** host EAs. Use the Windows desk at `http://127.0.0.1:8080`.

## Confirm the install

- `http://127.0.0.1:8080/api/health` → backend and engine `online`
- Header pills: engine live, then MT5 live after the EA
- Markets candles match the terminal chart
- A manual desk order appears in Toolbox → Trade

If a step fails: `docs/en/03-troubleshooting.md`.
