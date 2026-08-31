from __future__ import annotations

import asyncio
import json
from typing import Any

import os

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from ..config import load, merge, save
from ..mt5.protocol import parse_ea_json
from ..runtime.trader import Trader
from ..util.log import RING

trader = Trader()
app = FastAPI(title="AURION Engine", version="1.0.0")
# Secure CORS: only localhost and app://aurion, never *
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://127.0.0.1:18765",
        "http://localhost:18765",
        "app://aurion",
    ],
    allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
)


@app.on_event("startup")
async def _startup() -> None:
    await trader.start()


@app.on_event("shutdown")
async def _shutdown() -> None:
    await trader.stop()


def ok(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse({"ok": True, "data": data}, status_code=status)


def fail(message: str, status: int = 400) -> JSONResponse:
    return JSONResponse({"ok": False, "error": message}, status_code=status)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {"ok": True, "product": "AURION", "engine": "online"}


@app.get("/v1/snapshot")
async def snapshot() -> dict[str, Any]:
    return {"ok": True, "data": trader.snapshot()}


@app.get("/v1/status")
async def status() -> dict[str, Any]:
    snap = trader.snapshot()
    return {
        "ok": True,
        "data": {
            "mt5": snap["mt5"],
            "kill_switch": snap["kill_switch"],
            "safe_mode": snap["safe_mode"],
            "strategy": snap["strategy"],
            "ai": snap["ai"],
            "prop": snap["prop"],
        },
    }


@app.get("/v1/account")
async def account() -> dict[str, Any]:
    return {"ok": True, "data": trader.bridge.account.to_dict()}


@app.get("/v1/positions")
async def positions() -> dict[str, Any]:
    return {"ok": True, "data": [p.to_dict() for p in trader.bridge.positions]}


@app.get("/v1/orders")
async def orders() -> dict[str, Any]:
    return {"ok": True, "data": [o.to_dict() for o in trader.bridge.orders]}


@app.get("/v1/ticks")
async def ticks() -> dict[str, Any]:
    return {"ok": True, "data": {k: v.to_dict() for k, v in trader.bridge.public_ticks().items()}}


@app.get("/v1/candles")
async def candles(symbol: str, timeframe: str = "M15", count: int = 800) -> dict[str, Any]:
    cached = trader.bridge._candles_for(symbol, timeframe)
    if not trader._is_ea_symbol(symbol) and not cached:
        return {"ok": False, "error": "no AurionBridge on that symbol", "data": [], "count": 0, "synthetic": False}
    bars = await trader.bridge.pull_candles(symbol, timeframe, count)
    return {"ok": True, "data": bars, "count": len(bars), "synthetic": False}


@app.get("/v1/agents")
async def agents() -> dict[str, Any]:
    return {"ok": True, "data": [a.to_dict() for a in trader.bridge.public_agents()]}


@app.get("/v1/ea/ingest")
async def ea_ingest_probe() -> dict[str, Any]:
    return {"ok": True, "service": "ea-ingest", "hint": "AurionBridge 1.17 POSTs JSON here or writes aurion_in_*.jsonl"}


@app.post("/v1/ea/ingest")
async def ea_ingest(request: Request) -> dict[str, Any]:
    raw = await request.body()
    if not raw or not bytes(raw).strip().strip(b"\x00"):
        return {"ok": False, "error": "empty", "has_cmd": False}
    payload = parse_ea_json(raw)
    if payload is None:
        return {"ok": False, "error": "invalid json", "has_cmd": False}
    return await trader.bridge.ingest_http(payload, via="http")


@app.get("/v1/ai")
async def ai_state() -> dict[str, Any]:
    return {"ok": True, "data": trader.ai.last}


@app.post("/v1/ai/train")
async def ai_train(body: dict[str, Any]) -> dict[str, Any]:
    symbol = str(body.get("symbol") or trader.active_symbol or "")
    timeframe = str(body.get("timeframe") or trader.active_timeframe or "M15")
    if not trader._is_ea_symbol(symbol):
        return {"ok": False, "error": "AI trains only on a chart that has AurionBridge attached"}
    bars = await trader.bridge.pull_candles(symbol, timeframe, int(body.get("count") or 1500))
    result = await asyncio.to_thread(trader.ai.train, bars, symbol, timeframe)
    return result


@app.post("/v1/market")
async def set_market(body: dict[str, Any]) -> dict[str, Any]:
    symbol = str(body.get("symbol") or "")
    timeframe = str(body.get("timeframe") or "M15")
    if not symbol:
        return {"ok": False, "error": "symbol is required"}
    return await trader.set_market(symbol, timeframe)


@app.post("/v1/mt5/connect")
async def mt5_connect(body: dict[str, Any]) -> dict[str, Any]:
    if body:
        patch = {"mt5": {k: body[k] for k in ("terminal_path", "login", "password", "server", "portable") if k in body}}
        if patch["mt5"]:
            merge(patch)
    return await trader.bridge.connect_native(body)


@app.post("/v1/mt5/disconnect")
async def mt5_disconnect() -> dict[str, Any]:
    await trader.bridge.disconnect_native()
    return {"ok": True}

@app.post("/v1/terminals/restart")
async def terminals_restart() -> dict[str, Any]:
    # Immediate restart of system terminals: disconnect native + clear agents heartbeat, then reconnect
    try:
        await trader.bridge.disconnect_native()
    except Exception:
        pass
    # Force re-connect if credentials exist
    try:
        cfg = trader.bridge._cfg() if hasattr(trader.bridge, "_cfg") else None
    except Exception:
        cfg = None
    # Attempt reconnect via trader
    try:
        # small delay to let terminal process settle
        import asyncio
        await asyncio.sleep(0.6)
        result = await trader.bridge.connect_native({})
        return {"ok": True, "restarted": True, "result": result}
    except Exception as exc:
        return {"ok": True, "restarted": True, "warning": str(exc)}

@app.get("/v1/terminals")
async def terminals_list() -> dict[str, Any]:
    return {"ok": True, "data": [a.to_dict() for a in trader.bridge.public_agents()], "mt5": trader.bridge.snapshot_status}



@app.post("/v1/order")
async def order(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.execute(body)


@app.post("/v1/flatten")
async def flatten(body: dict[str, Any] | None = None) -> dict[str, Any]:
    return await trader.flatten((body or {}).get("reason") or "desk")


@app.post("/v1/kill")
async def kill(body: dict[str, Any]) -> dict[str, Any]:
    return trader.set_kill(bool(body.get("armed", True)))


@app.post("/v1/safe")
async def safe(body: dict[str, Any]) -> dict[str, Any]:
    return trader.set_safe(bool(body.get("value", True)))


@app.get("/v1/strategies")
async def strategies() -> dict[str, Any]:
    return {
        "ok": True,
        "data": {
            "items": trader.loader.list(),
            "builtins": ["ema_rsi", "price_action", "atr_breakout", "scalp_impulse"],
            "active": trader.strategy_meta,
        },
    }


@app.post("/v1/strategies/apply")
async def apply_strategy(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.apply_strategy(body)


@app.post("/v1/strategies/toggle")
async def toggle_strategy(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.toggle_strategy(str(body.get("name") or ""), bool(body.get("enabled")), body.get("params"))


@app.post("/v1/auto")
async def set_auto(body: dict[str, Any]) -> dict[str, Any]:
    return trader.set_auto(body or {})


@app.post("/v1/strategies/upload")
async def upload_strategy(body: dict[str, Any]) -> dict[str, Any]:
    if not trader.license.feature("strategy_upload"):
        return {"ok": False, "error": "premium_required", "feature": "strategy_upload", "upgrade": True}
    filename = str(body.get("filename") or "custom.py")
    source = str(body.get("source") or "")
    if not source.strip():
        return {"ok": False, "error": "empty strategy"}
    try:
        dest = trader.loader.save_upload(filename, source)
        # Always register the strategy in the live book so its card shows up on
        # the desk immediately — armed only when the upload asked for it.
        applied = await trader.apply_strategy(
            {"kind": "file", "name": dest.name, "params": body.get("params") or {}, "enabled": bool(body.get("activate"))}
        )
        return {**applied, "file": dest.name, "name": dest.stem}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@app.get("/v1/strategies/source")
async def strategy_source(name: str = "") -> dict[str, Any]:
    return trader.strategy_source(name)


@app.post("/v1/strategies/update")
async def update_strategy(body: dict[str, Any]) -> dict[str, Any]:
    if not trader.license.feature("strategy_upload"):
        return {"ok": False, "error": "premium_required", "feature": "strategy_upload", "upgrade": True}
    return await trader.update_strategy(str(body.get("name") or ""), str(body.get("source") or ""))


@app.post("/v1/strategies/delete")
async def delete_strategy(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.delete_strategy(str(body.get("name") or ""))


@app.get("/v1/strategies/template")
async def strategy_template() -> dict[str, Any]:
    from ..config import ROOT

    path = ROOT / "engine" / "strategies" / "template.py"
    return {"ok": True, "data": path.read_text(encoding="utf-8"), "filename": "template.py"}


@app.get("/v1/prop")
async def prop_state() -> dict[str, Any]:
    from ..prop.profiles import PROFILES

    return {"ok": True, "data": {"metrics": trader.prop.metrics(trader.bridge.account.to_dict()), "profiles": list(PROFILES.values())}}


@app.post("/v1/prop")
async def prop_save(body: dict[str, Any]) -> dict[str, Any]:
    if not trader.license.feature("prop"):
        return {"ok": False, "error": "premium_required", "feature": "prop", "upgrade": True}
    profile = trader.prop.set_profile(body.get("profile") or body)
    cfg = load()
    prop = dict(cfg.get("prop") or {})
    prop["active_profile"] = profile.get("id") or "custom"
    prop["enabled"] = trader.prop.enabled
    if profile.get("id") == "custom":
        prop["profile"] = profile
    else:
        prop["profile"] = {"id": profile.get("id")}
    cfg["prop"] = prop
    save(cfg)
    metrics = trader.prop.metrics(trader.bridge.account.to_dict())
    trader._sync_book_meta()
    await trader.bus.publish("prop", metrics)
    await trader.bus.publish("strategy", trader.strategy_meta)
    return {"ok": True, "data": profile, "prop": metrics}


@app.post("/v1/prop/unlock")
async def prop_unlock() -> dict[str, Any]:
    trader.prop.unlock()
    trader.safe_mode = False
    metrics = trader.prop.metrics(trader.bridge.account.to_dict())
    await trader.bus.publish("prop", metrics)
    return {"ok": True, "prop": metrics}


@app.post("/v1/prop/lock")
async def prop_lock(body: dict[str, Any]) -> dict[str, Any]:
    trader.prop.lock(str(body.get("reason") or "manual"))
    metrics = trader.prop.metrics(trader.bridge.account.to_dict())
    await trader.bus.publish("prop", metrics)
    return {"ok": True, "prop": metrics}


@app.post("/v1/prop/enable")
async def prop_enable(body: dict[str, Any]) -> dict[str, Any]:
    if body.get("enabled") and not trader.license.feature("prop"):
        return {"ok": False, "error": "premium_required", "feature": "prop", "upgrade": True}
    result = trader.prop.set_enabled(bool(body.get("enabled", True)))
    merge({"prop": {"enabled": trader.prop.enabled}})
    metrics = trader.prop.metrics(trader.bridge.account.to_dict())
    trader._sync_book_meta()
    await trader.bus.publish("prop", metrics)
    await trader.bus.publish("strategy", trader.strategy_meta)
    return {**result, "prop": metrics}


@app.get("/v1/history")
async def history(limit: int = 400) -> dict[str, Any]:
    return {"ok": True, "data": trader.store.history(limit, closed_only=False)}


@app.get("/v1/equity")
async def equity(limit: int = 2000) -> dict[str, Any]:
    return {"ok": True, "data": trader.store.equity_series(limit)}


@app.get("/v1/logs")
async def logs(limit: int = 300) -> dict[str, Any]:
    return {"ok": True, "data": RING.snapshot(limit)}


@app.get("/v1/robot")
async def robot_log(limit: int = 300) -> dict[str, Any]:
    rows = list(trader.robot_log)
    return {"ok": True, "data": rows[-int(limit or 300) :]}


@app.post("/v1/factory-reset")
async def factory_reset() -> dict[str, Any]:
    return await trader.factory_reset()


@app.post("/v1/history/reset")
async def history_reset(request: Request) -> dict[str, Any]:
    try:
        raw = await request.body()
        body = json.loads(raw.decode("utf-8") or "{}") if raw else {}
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    days = int(body.get("days") or 0)
    result = trader.store.archive_and_reset(days)
    if result.get("ok"):
        trader._closed_tickets = set()
        trader._known_pos = {}
        trader._sync_book_meta()
        await trader.bus.publish("history", {"items": []})
        await trader.bus.publish("strategy", trader.strategy_meta)
    return result


@app.get("/v1/telegram")
async def telegram_state() -> dict[str, Any]:
    bot = getattr(trader, "telegram", None)
    if bot is None:
        from ..telegram.bot import TelegramBot

        bot = TelegramBot(trader)
        trader.telegram = bot
    return {"ok": True, "data": bot.public()}


@app.post("/v1/telegram")
async def telegram_save(body: dict[str, Any] | None = None) -> dict[str, Any]:
    if not trader.license.feature("telegram"):
        return {"ok": False, "error": "premium_required", "feature": "telegram", "upgrade": True}
    bot = getattr(trader, "telegram", None)
    if bot is None:
        from ..telegram.bot import TelegramBot

        bot = TelegramBot(trader)
        trader.telegram = bot
    return bot.apply(body or {})


@app.post("/v1/telegram/pair")
async def telegram_pair() -> dict[str, Any]:
    if not trader.license.feature("telegram"):
        return {"ok": False, "error": "premium_required", "feature": "telegram", "upgrade": True}
    bot = getattr(trader, "telegram", None)
    if bot is None:
        return {"ok": False, "error": "telegram"}
    return bot.make_pair_code()


@app.post("/v1/telegram/test")
async def telegram_test() -> dict[str, Any]:
    if not trader.license.feature("telegram"):
        return {"ok": False, "error": "premium_required", "feature": "telegram", "upgrade": True}
    bot = getattr(trader, "telegram", None)
    if bot is None:
        return {"ok": False, "error": "telegram"}
    return await bot.send_test()


@app.post("/v1/telegram/unlink")
async def telegram_unlink(body: dict[str, Any] | None = None) -> dict[str, Any]:
    if not trader.license.feature("telegram"):
        return {"ok": False, "error": "premium_required", "feature": "telegram", "upgrade": True}
    bot = getattr(trader, "telegram", None)
    if bot is None:
        return {"ok": False, "error": "telegram"}
    body = body or {}
    return bot.unlink(int(body.get("chat_id") or body.get("id") or 0))


@app.post("/v1/persist")
async def persist_now() -> dict[str, Any]:
    try:
        trader._persist_runtime()
        return {"ok": True}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@app.post("/v1/shutdown")
async def shutdown_now() -> dict[str, Any]:
    try:
        trader._persist_runtime()
    except Exception:
        pass
    loop = asyncio.get_running_loop()
    loop.call_later(0.4, lambda: os._exit(0))
    return {"ok": True, "stopping": True}


@app.get("/v1/chart/signals")
async def chart_signals(symbol: str, timeframe: str = "M15", count: int = 800, strict: bool = True) -> dict[str, Any]:
    return await trader.chart_signals(symbol, timeframe, count, strict)

@app.post("/v1/chart/signals")
async def chart_signals_post(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.chart_signals(
        str(body.get("symbol") or ""),
        str(body.get("timeframe") or "M15"),
        int(body.get("count") or 800),
        bool(body.get("strict", True)),
    )

@app.post("/v1/backtest")
async def backtest(body: dict[str, Any]) -> dict[str, Any]:
    return await trader.backtest(body)


@app.get("/v1/backtest")
async def backtest_state() -> dict[str, Any]:
    return {"ok": True, "data": trader.backtest_run or {"running": False, "mode": "idle"}}


@app.get("/v1/license")
async def license_state() -> dict[str, Any]:
    return {"ok": True, "data": trader.license.public()}


@app.post("/v1/license/issue")
async def license_issue(request: Request, body: dict[str, Any]) -> dict[str, Any]:
    host = request.client.host if request.client else ""
    # Strict local-only: never exposed to internet. Private key lives only on owner machine.
    if host not in {"127.0.0.1", "::1", "localhost"}:
        return {"ok": False, "error": "local_only"}
    plan = str(body.get("plan") or "").lower()
    # Allow all mintable plans locally: m1,m3,m6,y1 + developer (admin). Billing still uses m1..y1 only.
    if plan not in {"m1", "m3", "m6", "y1", "developer"}:
        return {"ok": False, "error": "plan"}
    from ..license.guard import mint

    try:
        key = mint(plan, str(body.get("note") or body.get("identity") or ""))
    except RuntimeError:
        return {"ok": False, "error": "signing_not_configured"}
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "key": key, "plan": plan}


@app.post("/v1/license/activate")
async def license_activate(body: dict[str, Any]) -> dict[str, Any]:
    key = str(body.get("key") or "")
    identity = str(body.get("identity") or "")
    result = trader.license.activate(key, identity)
    if result.get("ok"):
        await trader.bus.publish("license", result.get("license") or {})
        await trader.journal("info", "license", f"License activated: {result['license'].get('plan')}")
    return result


@app.post("/v1/license/bind")
async def license_bind(body: dict[str, Any]) -> dict[str, Any]:
    trader.license.bind_identity(str(body.get("identity") or ""))
    return {"ok": True, "data": trader.license.public()}


@app.get("/v1/updates")
async def updates() -> dict[str, Any]:
    from ..license.updates import check

    return check()


@app.get("/v1/config")
async def get_config() -> dict[str, Any]:
    cfg = load()
    public = json.loads(json.dumps(cfg))
    if public.get("mt5"):
        if public["mt5"].get("password"):
            public["mt5"]["password"] = "***"
    if public.get("telegram") and public["telegram"].get("bot_token"):
        from ..telegram.bot import mask_token

        public["telegram"]["bot_token"] = mask_token(str(public["telegram"].get("bot_token") or ""))
    return {"ok": True, "data": public}


@app.post("/v1/config")
async def set_config(body: dict[str, Any]) -> dict[str, Any]:
    cfg = merge(body)
    if cfg.get("mt5") and cfg["mt5"].get("password"):
        cfg = json.loads(json.dumps(cfg))
        cfg["mt5"]["password"] = "***"
    return {"ok": True, "data": cfg}


@app.get("/v1/i18n/{lang}")
async def i18n(lang: str) -> dict[str, Any]:
    from ..i18n import pack

    return {"ok": True, "data": pack(lang)}


@app.websocket("/v1/stream")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=500)
    trader.bus.add_client(queue)
    await ws.send_json({"type": "hello", "data": trader.snapshot()})
    try:
        async def reader() -> None:
            while True:
                message = await ws.receive_json()
                kind = message.get("type")
                if kind == "ping":
                    await ws.send_json({"type": "pong", "ts": message.get("ts")})
                elif kind == "subscribe_market":
                    await trader.set_market(message.get("symbol"), message.get("timeframe") or "M15")

        async def writer() -> None:
            while True:
                payload = await queue.get()
                await ws.send_json(payload)

        await asyncio.gather(reader(), writer())
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        trader.bus.drop_client(queue)
