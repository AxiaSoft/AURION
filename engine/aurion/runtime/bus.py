from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from ..util.log import get

log = get("bus")

Handler = Callable[[str, dict[str, Any]], Awaitable[None] | None]

#: How many messages may be waiting for one client before something has
#: to give. A history stream hands over thousands of bars in a few
#: large messages while ticks keep arriving, so a backlog is normal; a
#: backlog that never drains is not.
QUEUE_MAX = 500

#: Messages that may be thrown away to make room, newest-wins. Each one
#: is a snapshot of something that is about to be sent again anyway: a
#: tick is replaced by the next tick, the analysis by the next
#: analysis. Everything else - an order result, a log line, the bars of
#: a history download - happens once and is kept.
DROPPABLE = frozenset({"tick", "ticks", "analysis", "prop", "ai", "status", "agents"})


class Bus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = {}
        self._clients: set[asyncio.Queue] = set()

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._subs.setdefault(topic, []).append(handler)

    def client_count(self) -> int:
        """How many listeners there are. Nobody listening is work not worth doing.

        Both kinds count. A socket client is a desk with a chart open;
        a subscriber is something inside the engine - an alert rule, a
        recorder, a test - that asked for the same messages. Counting
        only the sockets would let the engine decide nobody cares
        while a subscriber sat waiting for exactly that payload.
        """
        subs = sum(len(v) for v in self._subs.values())
        return len(self._clients) + subs

    def add_client(self, queue: asyncio.Queue) -> None:
        self._clients.add(queue)

    def drop_client(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        message = {"topic": topic, **payload} if "type" not in payload else payload
        if "type" not in message:
            message = {"type": topic, "data": payload}
        for handler in list(self._subs.get(topic, [])) + list(self._subs.get("*", [])):
            try:
                result = handler(topic, payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception:
                pass
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
                continue
            except asyncio.QueueFull:
                pass
            except Exception:
                self._clients.discard(queue)
                continue
            # A full queue used to detach the client from the bus and
            # leave its socket open, which is the worst of both: the
            # desk went permanently silent - no ticks, no candles, no
            # prices - while still believing it was connected, because
            # nothing ever closed the connection that would have made
            # it reconnect. A backlog is a slow reader, not a dead one.
            #
            # So make room instead. The oldest message that will be
            # superseded anyway is dropped; if there is nothing
            # droppable the client keeps its backlog and this one
            # message is lost rather than the whole feed.
            if self._make_room(queue):
                try:
                    queue.put_nowait(message)
                except Exception:
                    pass
            else:
                log.warning("bus: a client is %d messages behind; dropped a %s",
                            queue.qsize(), message.get("type", "?"))

    @staticmethod
    def _make_room(queue: asyncio.Queue) -> bool:
        """Discard the oldest superseded message. True if one went.

        The queue is drained and refilled in order because asyncio
        queues cannot be indexed; it only happens on a queue that is
        already full, which is rare and bounded by QUEUE_MAX.
        """
        held: list[dict[str, Any]] = []
        while True:
            try:
                held.append(queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        dropped = False
        for item in held:
            if not dropped and isinstance(item, dict) and item.get("type") in DROPPABLE:
                dropped = True
                continue
            try:
                queue.put_nowait(item)
            except asyncio.QueueFull:  # pragma: no cover - cannot happen
                break
        return dropped
