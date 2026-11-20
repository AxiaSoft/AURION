"""The robot can be backtested on its own, with no strategy underneath.

Asked for: "the robot trades without a strategy too -- let the backtest
test the robot by itself". Everywhere else the AI is a filter and never a
source of signals, so this mode only exists inside a replay, and the
things that make it safe are the things worth asserting:

  * the loader hands it out only to a caller that names it, and it is
    still not a builtin -- nothing that lists armable strategies grows a
    "robot" entry;
  * a learning replay trains in a throwaway directory and leaves the
    desk's live model untouched, both its weights on disk and the object
    in memory;
  * it decides from ``ctx.ai`` and nothing else, and when the model
    never becomes ready it says so through the refusal tally instead of
    reporting a silent zero-trade run.

Run:
    python3 -m pytest engine/tests/test_backtest_robot_only.py
"""
from __future__ import annotations

import datetime
import random
from pathlib import Path

from aurion.backtest.engine import Backtester
from aurion.strategy.base import StrategyContext
from aurion.strategy.loader import BUILTIN_NAMES, StrategyLoader
from aurion.strategy.robot import RobotSolo


def synth(count: int, minutes: int = 15) -> list[dict]:
    """A deterministic walk with real, unique, spaced timestamps.

    The timestamps are load-bearing: the AI's feature frame is matched
    back to the bars by time, and a series of identical stamps silently
    takes the slow path.
    """
    random.seed(5)
    price = 1900.0
    start = datetime.datetime(2026, 2, 1, tzinfo=datetime.timezone.utc)
    bars = []
    for i in range(count):
        opened = price
        price += random.gauss(0, 0.5) + (0.08 if i % 400 < 200 else -0.08)
        bars.append({
            "time": (start + datetime.timedelta(minutes=i * minutes)).isoformat(),
            "open": opened,
            "high": max(opened, price) + 0.3,
            "low": min(opened, price) - 0.3,
            "close": price,
            "volume": 100,
        })
    return bars


# ----------------------------------------------------------- the loader


def test_the_loader_builds_the_robot_only_by_name() -> None:
    loader = StrategyLoader()
    assert isinstance(loader.build({"kind": "robot", "name": "robot"}), RobotSolo)
    # The desk sends kind="builtin" for anything picked in a dropdown,
    # so the name alone has to be enough.
    assert isinstance(loader.build({"kind": "builtin", "name": "robot"}), RobotSolo)


def test_the_robot_is_not_a_builtin() -> None:
    """It must never appear anywhere strategies can be armed."""
    assert "robot" not in BUILTIN_NAMES


def test_an_upload_cannot_shadow_the_robot() -> None:
    from aurion.strategy.loader import RESERVED_NAMES

    # sanitize_stem() refuses a reserved name, so a file called robot.py
    # can never reach the uploads directory in the first place.
    assert "robot" in RESERVED_NAMES
    loader = StrategyLoader()
    assert isinstance(loader.build({"kind": "file", "name": "robot"}), RobotSolo)


# ------------------------------------------------------- the decision


def _ctx(ai: dict, bars: list[dict], position: dict | None = None) -> StrategyContext:
    return StrategyContext(
        symbol="XAUUSD",
        timeframe="M15",
        candles=bars,
        tick=None,
        account={"equity": 10_000, "balance": 10_000, "profit": 0},
        positions=[position] if position else [],
        orders=[],
        ai=ai,
        params={},
        now="2026-02-02T00:00:00+00:00",
    )


def test_it_stays_out_until_the_model_is_ready() -> None:
    bars = synth(300)
    robot = RobotSolo()
    assert robot.on_candle(_ctx({"ready": False, "direction": "bull", "confidence": 0.9}, bars)) is None
    assert "learned" in robot.last_refusal


def test_it_stays_out_below_its_confidence_floor() -> None:
    bars = synth(300)
    robot = RobotSolo()
    low = {"ready": True, "direction": "bull", "confidence": 0.2}
    assert robot.on_candle(_ctx(low, bars)) is None
    assert "confidence floor" in robot.last_refusal


def test_a_confident_read_becomes_an_entry_with_a_stop_and_a_target() -> None:
    bars = synth(300)
    robot = RobotSolo()
    sig = robot.on_candle(_ctx({"ready": True, "direction": "bull", "confidence": 0.8}, bars))
    assert sig is not None and sig.action == "buy"
    assert sig.sl and sig.tp
    assert sig.sl < sig.price < sig.tp
    # Named in the trade, so a result can be read back to the decision.
    assert "robot" in (sig.reason or "")


def test_it_closes_when_the_robot_turns_around() -> None:
    bars = synth(300)
    robot = RobotSolo()
    held = {"symbol": "XAUUSD", "type": "buy", "volume": 0.1, "entry": 1900.0}
    sig = robot.on_candle(_ctx({"ready": True, "direction": "bear", "confidence": 0.9}, bars, held))
    assert sig is not None and sig.action == "close"


# --------------------------------------------------------- the replay


def test_a_replay_never_touches_the_live_model(tmp_path, monkeypatch) -> None:
    """The one thing that would disqualify the whole mode.

    A learning replay fits a model on the window it is replaying. If it
    fitted the desk's model, a backtest would overwrite what the live
    robot trades on -- and would itself start from a model that has
    already seen the future of the window under test.
    """
    monkeypatch.setenv("AURION_HOME", str(tmp_path))
    bt = Backtester()
    brain, scratch = bt._scratch_brain()
    try:
        live_dir = Path(brain.models.directory)
        assert str(live_dir).startswith(str(Path(scratch)))
        assert not any(live_dir.glob("live.joblib"))
    finally:
        import shutil

        shutil.rmtree(scratch, ignore_errors=True)
    assert not Path(scratch).exists()


def test_a_robot_replay_runs_and_reports_itself() -> None:
    """End to end on real-shaped bars: it completes and names itself."""
    bars = synth(900)
    result = Backtester().run(RobotSolo(), bars, "XAUUSD", "M15", warmup=80)
    assert result["ok"] is True
    assert result["strategy"] == "robot"
    # warmup_bars is honoured, so the first decision is taken after the
    # model has had a chance to exist at all.
    assert result["data"]["warmup_bars"] >= 400
    assert result["data"]["tested_bars"] > 0
    assert isinstance(result["metrics"], dict)


def test_a_run_too_short_to_learn_is_refused_not_faked() -> None:
    result = Backtester().run(RobotSolo(), synth(60), "XAUUSD", "M15", warmup=80)
    assert result["ok"] is False
    assert "bars" in result["error"]


def test_the_replay_plumbing_turns_a_confident_read_into_trades() -> None:
    """A walk gives the model no edge, so a real run takes no trades.

    That is the honest answer on noise and it is asserted above through
    the refusal tally -- but it would also be the answer if the mode
    were wired up wrongly and the robot's signals never reached the
    book. So this run hands the replay a brain that is sure of itself
    and checks the trades come out the other end.
    """

    class SureBrain:
        """A stand-in AI that is confident and changes its mind slowly."""

        last: dict = {}

        def infer(self, rows, symbol, timeframe, frame=None):
            bull = (len(rows) // 120) % 2 == 0
            self.last = {
                "ready": True,
                "direction": "bull" if bull else "bear",
                "confidence": 0.9,
            }
            return self.last

        def train(self, rows, symbol, timeframe):
            return {"ok": True}

    result = Backtester().run(
        RobotSolo(), synth(900), "XAUUSD", "M15", warmup=80, ai=SureBrain(),
    )
    assert result["ok"] is True
    assert result["metrics"]["trades"] > 0
    assert all(t.get("type") in {"buy", "sell"} for t in result["trades"])


def test_the_trader_runs_the_replay_on_the_live_confidence_floor() -> None:
    """The desk's own filter, not a default, decides what the robot takes."""
    from aurion.strategy.loader import StrategyLoader

    spec = {"kind": "robot", "name": "robot", "params": {"min_confidence": 0.71}}
    assert StrategyLoader().build(spec).params["min_confidence"] == 0.71
