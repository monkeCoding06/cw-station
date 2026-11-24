"""Private, memory-only station traffic delivery for PHP-FPM."""
import asyncio
from collections import deque
import json
import socket
import time

views = {}
rates = {}
LEASE = 30
CW_TTL = 4
RATE_WINDOW = 60


def expire():
    now = time.monotonic()
    for key, entry in list(views.items()):
        if entry["seen"] + LEASE <= now:
            del views[key]
        elif key[0] == "cw":
            queue = entry["queue"]
            while queue and queue[0][0] + CW_TTL <= now:
                queue.popleft()
    for key, times in list(rates.items()):
        while times and times[0] + RATE_WINDOW <= now:
            times.popleft()
        if not times:
            del rates[key]


def dispatch(req):
    expire()
    action, call, view = req["action"], req["call"], req["view"]
    channel = req.get("channel", "chat")
    key = (channel, call, view)
    if action == "join":
        if key not in views and len(views) >= 2048:
            return {"error": "Station relay is full", "status": 503}
        views[key] = {"seen": time.monotonic(), "queue": deque(maxlen=32 if channel == "cw" else 200)}
    elif action == "leave":
        views.pop(key, None)
    elif key not in views:
        return {"status": 409, "error": "Reconnecting to station"}
    elif action == "poll":
        entry = views[key]
        entry["seen"] = time.monotonic()
        messages = [msg for _, msg in entry["queue"]]
        entry["queue"].clear()
        return {"messages": messages}
    elif action == "send":
        rate = rates.setdefault((channel, call), deque())
        if len(rate) >= 100:
            return {"status": 429, "error": "Sending too fast"}
        now = time.monotonic()
        rate.append(now)
        payload = req["transmission"] if channel == "cw" else {"text": req["text"]}
        item = (now, {**payload, "call": call})
        for (recipient_channel, recipient, _), entry in views.items():
            if recipient_channel == channel and (channel == "chat" or recipient != call):
                entry["queue"].append(item)
    return {"ok": True}


async def serve(reader, writer):
    try:
        request = json.loads(await asyncio.wait_for(reader.readline(), 3))
        writer.write(json.dumps(dispatch(request)).encode() + b"\n")
        await writer.drain()
    except (ValueError, KeyError, ConnectionError, TimeoutError):
        pass
    finally:
        writer.close()


async def main():
    server = await asyncio.start_unix_server(serve, sock=socket.socket(fileno=3))
    async with server:
        while True:
            await asyncio.sleep(5)
            expire()


if __name__ == "__main__":
    asyncio.run(main())
