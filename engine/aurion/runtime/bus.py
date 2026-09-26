from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

Handler = Callable[[str, dict[str, Any]], Awaitable[None] | None]


class Bus:
    def __init__(self) -> None:
        self._subs: dict[str, list[Handler]] = {}
        self._clients: set[asyncio.Queue] = set()

    def subscribe(self, topic: str, handler: Handler) -> None:
        self._subs.setdefault(topic, []).append(handler)

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
        dead = []
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                dead.append(queue)
            except Exception:
                dead.append(queue)
        for queue in dead:
            self._clients.discard(queue)
