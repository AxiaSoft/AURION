# AURION System Setup Guide (English)

How to configure the backend, attach accounts, activate experts, and prove that the tape is real.

---

## 1. Central configuration

Edit `config/aurion.json`. The engine and the desk reread it on save from the Settings page or a process restart.

Important keys:

| Key | Meaning |
|---|---|
| `allow_synthetic_data` | Must stay `false`. The engine ignores any request to invent bars. |
| `engine.port` | FastAPI port (`18765`) |
| `mt5.ea_listen_port` | Socket the EA dials (`18766`) |
| `mt5.login` / `server` / `password` | Optional native API credentials (Windows) |
| `mt5.symbols` | Empty = follow whatever the terminal already has selected |
| `ai.min_bars_to_train` | Default `400` real feature-complete bars |
| `ai.confidence_threshold` | Strategies may read this; the model still reports raw probability |
| `execution.flatten_on_disconnect` | Flatten if the engine is stopped while positions are open |
| `execution.magic` | `908173` — filter AURION tickets in MT5 |
| `prop.active_profile` | `conservative` / `ftmo_challenge` / `fundingpips` / `the5ers` / `custom` |
| `backend.history_retention_days` | Live window before Archive & reset (`30`) |

Passwords entered in the UI are stored only on the engine host. The API redacts them on the way back to the browser.

---

## 2. Connect an MT5 account

### Path A — Expert Advisor (any OS for the engine)

1. Compile `AurionBridge.mq5`.
2. Attach it to EURUSD M15 (or whatever you actually trade). Repeat per chart.
3. Each chart reports independently: symbol, timeframe, chart id, parameters, EA log.
4. The engine marks `source: "ea"` (or `"native+ea"`).

### Path B — Official Python API (Windows)

1. Terminal running and logged in.
2. Desk → Settings → fill login / server / password → **Connect terminal**.
3. The engine polls account, positions, pending orders and ticks from the market watch.

You can use both. Orders prefer the native API when it is connected; otherwise they are broadcast to every EA socket.

---

## 3. Activate the EA on charts

On each chart:

1. Confirm the smiling-face icon (auto-trading allowed).
2. Experts tab of the Toolbox should print `AURION: connected to engine …`.
3. Desk → **EA Charts** lists that chart as its own card.
4. Detaching the EA flips the card to `offline`. AURION does not keep a ghost chart.

If you want a second visible name, set input `InpEaName` to `AurionChartAgent`.

---

## 4. Verify real-time data flow

Work through this checklist with the terminal and the desk side by side.

1. **Tick identity**  
   Hover a quote in MT5 Market Watch. The desk Markets tape must show the same bid/ask. If they differ, you are looking at two accounts — stop.

2. **Candle identity**  
   Open the same symbol/timeframe. The last *closed* candle’s OHLC on the desk must equal `iOpen/iHigh/iLow/iClose` on the chart. AURION never interpolates missing bars.

3. **Account identity**  
   Command centre Balance / Equity / Margin must match the MT5 headline. Floating P/L is the terminal’s number, not a recalculation from mid prices.

4. **Order identity**  
   Place a 0.01 market from the desk Execution page. The ticket must appear in MT5 Toolbox → Trade with comment prefix `AURION`. Close it from either side; both views update.

5. **EA identity**  
   Open a second chart, attach the EA. A second card appears. Remove it; the card goes offline.

6. **AI honesty**  
   Intelligence stays **idle** until at least `min_bars_to_train` real bars exist. There is no factory model. Pressing train on an empty book returns an error, not a decorative arrow.

7. **Disconnect honesty**  
   Stop the terminal. Within a second the desk pill turns **MT5 disconnected**, candles freeze on the last real bar, and new market orders are rejected with *“AURION will not fabricate a fill.”*

---

## 5. Strategies

Built-ins: `ema_rsi`, `price_action`, `atr_breakout`. They ship **disabled**. Enabling them sends live orders.

To load your own:

1. Download the multilingual template from Strategies.
2. Implement `on_candle` / `on_tick`.
3. Upload. The loader parses the AST and rejects `os`, `subprocess`, `socket`, `eval`, `exec`, network clients, and file deletion.
4. Hot-reload does not restart the engine.

Backtest is a separate button. It replays **only** the history already pulled from MT5 for that symbol/timeframe.

---

## 6. Prop-firm profile

Risk → pick or edit a profile.

- `max_daily_loss_pct` is measured from UTC midnight equity snapshot.
- `max_drawdown_pct` is measured from the session high-water equity.
- `on_violation`: `flatten_and_lock` or `lock`.
- News filter reads `config/news_calendar.template.csv` (or the path you set). If the file has only headers, the filter is inert — AURION will not invent headlines.

Unlocking after a trip is a conscious desk action. It is not automatic.

---

## 7. Users and language

The first account is an administrator. Language is stored on the profile and also on the device. The desk detects `Accept-Language` on first visit (`fa`, `ar`, `en`) and can be overridden at any time.

---

## 8. History window

Live trades and equity samples sit in `data/aurion.engine.db`. **Archive & reset** copies the file into `data/archive/` and deletes rows older than 30 days (configurable), then vacuums. The terminal’s own history is untouched.
