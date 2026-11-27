"""Private, memory-only station traffic delivery.

Chat: PHP-FPM talks JSON lines over the private socket (systemd fd "chat").
Live CW: browsers hold a WebSocket (systemd fd "live", proxied by Caddy at
/live). PHP issues a single-use ticket for the signed-in callsign over the
private socket; the browser redeems it as its first WebSocket message.
"""
import asyncio
from collections import deque
import itertools
import json
import os
import secrets
import socket
import time

from websockets.asyncio.server import broadcast, unix_serve
from websockets.exceptions import ConnectionClosed

clock = time.monotonic

# chat
views = {}
rates = {}
LEASE = 30
RATE_WINDOW = 60

# live CW
TICKET_TTL = 20
TICKETS_PER_MINUTE = 20
MAX_TICKETS = 4096
MAX_CONNECTIONS = 1024
MAX_PER_CALL = 8
HELLO_TIMEOUT = 5
MAX_FRAME = 4096
MAX_EVENTS = 64
MAX_TIME_MS = 2**31
FREQ_LIMIT = 10000
CLOCK_SLACK_MS = 5000          # how far a sender's stream time may run ahead of ours
PACKET_RATE, PACKET_BURST = 80, 160              # per connection, packets/s
EDGE_RATE, EDGE_BURST = 120, 240                 # per connection, key transitions/s
CALL_PACKET_RATE, CALL_PACKET_BURST = 160, 320   # all tabs of one callsign
SEND_BUFFER_LIMIT = 64 * 1024
CONGESTED_CLOSE_AFTER = 5

tickets = {}          # ticket -> (call, expires)
ticket_rates = {}     # call -> issue times
stations = {}         # sid -> Station
call_buckets = {}     # call -> Bucket
sids = itertools.count(1)


class Reject(Exception):
    pass


class Bucket:
    def __init__(self, rate, burst):
        self.rate, self.burst, self.level, self.at = rate, burst, burst, clock()

    def take(self, amount=1):
        now = clock()
        self.level = min(self.burst, self.level + (now - self.at) * self.rate)
        self.at = now
        if self.level < amount:
            return False
        self.level -= amount
        return True


class Station:
    def __init__(self, ws, call):
        self.ws, self.call, self.sid = ws, call, next(sids)
        self.opened = clock()
        self.q = self.n = self.t = self.key = 0
        self.sent = False
        self.packets = Bucket(PACKET_RATE, PACKET_BURST)
        self.edges = Bucket(EDGE_RATE, EDGE_BURST)
        self.congested_since = None


def expire():
    now = clock()
    for key, entry in list(views.items()):
        if entry["seen"] + LEASE <= now:
            del views[key]
    for key, times in list(rates.items()):
        while times and times[0] + RATE_WINDOW <= now:
            times.popleft()
        if not times:
            del rates[key]
    for ticket, (_, expires) in list(tickets.items()):
        if expires <= now:
            del tickets[ticket]
    for call, times in list(ticket_rates.items()):
        while times and times[0] + 60 <= now:
            times.popleft()
        if not times:
            del ticket_rates[call]
    active = {station.call for station in stations.values()}
    for call in list(call_buckets):
        if call not in active:
            del call_buckets[call]


def issue_ticket(call):
    now = clock()
    issued = ticket_rates.setdefault(call, deque())
    if len(issued) >= TICKETS_PER_MINUTE or len(tickets) >= MAX_TICKETS:
        return {"status": 429, "error": "Too many connection attempts"}
    issued.append(now)
    ticket = secrets.token_hex(32)
    tickets[ticket] = (call, now + TICKET_TTL)
    return {"ticket": ticket}


def redeem(ticket):
    entry = tickets.pop(ticket, None) if isinstance(ticket, str) else None
    if entry is None or entry[1] <= clock():
        return None
    return entry[0]


def dispatch(req):
    expire()
    action, call = req["action"], req["call"]
    if action == "ticket":
        return issue_ticket(call)
    channel, view = req.get("channel", "chat"), req["view"]
    if channel != "chat":
        return {"status": 410, "error": "Live CW moved to the station connection. Reload the page."}
    key = (channel, call, view)
    if action == "join":
        if key not in views and len(views) >= 2048:
            return {"error": "Station relay is full", "status": 503}
        views[key] = {"seen": clock(), "queue": deque(maxlen=200)}
    elif action == "leave":
        views.pop(key, None)
    elif key not in views:
        return {"status": 409, "error": "Reconnecting to station"}
    elif action == "poll":
        entry = views[key]
        entry["seen"] = clock()
        messages = list(entry["queue"])
        entry["queue"].clear()
        return {"messages": messages}
    elif action == "send":
        rate = rates.setdefault((channel, call), deque())
        if len(rate) >= 100:
            return {"status": 429, "error": "Sending too fast"}
        rate.append(clock())
        item = {"text": req["text"], "call": call}
        for (recipient_channel, _, _), entry in views.items():
            if recipient_channel == channel:
                entry["queue"].append(item)
    return {"ok": True}


async def serve_chat(reader, writer):
    try:
        request = json.loads(await asyncio.wait_for(reader.readline(), 3))
        writer.write(json.dumps(dispatch(request)).encode() + b"\n")
        await writer.drain()
    except (ValueError, KeyError, ConnectionError, TimeoutError):
        pass
    finally:
        writer.close()


def is_int(value, low, high):
    return type(value) is int and low <= value <= high


def accept_key(station, msg):
    """Validates one key packet against the sender's stream state and returns what receivers get."""
    q, n, k, f, events = (msg.get(name) for name in ("q", "n", "k", "f", "e"))
    if not is_int(q, station.q + 1, station.q + 1):
        raise Reject("Out of sequence")
    if not is_int(n, station.n, MAX_TIME_MS) or n > (clock() - station.opened) * 1000 + CLOCK_SLACK_MS:
        raise Reject("Invalid timing")
    if not is_int(f, -FREQ_LIMIT, FREQ_LIMIT) or not is_int(k, 0, 1):
        raise Reject("Invalid key data")
    if type(events) is not list or len(events) > MAX_EVENTS:
        raise Reject("Invalid key data")
    state, last = station.key, station.t
    for event in events:
        if type(event) is not list or len(event) != 2:
            raise Reject("Invalid key data")
        t, s = event
        # transitions alternate and never run backwards or past the packet's own time
        if not is_int(t, last, n) or not is_int(s, 1 - state, 1 - state):
            raise Reject("Invalid key data")
        state, last = s, t
    if k != state:
        raise Reject("Invalid key data")

    shared = call_buckets.setdefault(station.call, Bucket(CALL_PACKET_RATE, CALL_PACKET_BURST))
    if not (station.packets.take() and station.edges.take(len(events)) and shared.take()):
        raise Reject("Sending too fast")

    station.q, station.n, station.t, station.key = q, n, last, state
    station.sent = True
    return {"t": "key", "sid": station.sid, "call": station.call, "q": q, "n": n, "k": k, "f": f, "e": events}


def deliver(sender, message):
    """Pushes to every other callsign at once. A receiver that cannot keep up misses packets, then is dropped."""
    data = json.dumps(message, separators=(",", ":"))
    now = clock()
    targets = []
    for other in list(stations.values()):
        if other.call == sender.call:
            continue
        if other.ws.transport.get_write_buffer_size() > SEND_BUFFER_LIMIT:
            other.congested_since = other.congested_since or now
            if now - other.congested_since > CONGESTED_CLOSE_AFTER:
                other.ws.transport.abort()
            continue
        other.congested_since = None
        targets.append(other.ws)
    broadcast(targets, data)


def allowed_origins(host):
    configured = os.environ.get("CW_LIVE_ORIGINS", "").split()
    return set(configured) if configured else {"https://" + host}


def check_request(connection, request):
    if request.path.split("?")[0] != "/live":
        return connection.respond(404, "Not found\n")
    origin, host = request.headers.get("Origin"), request.headers.get("Host")
    if not origin or not host or origin not in allowed_origins(host):
        return connection.respond(403, "Forbidden\n")
    return None


async def handle_live(ws):
    station = None
    try:
        try:
            hello = json.loads(await asyncio.wait_for(ws.recv(), HELLO_TIMEOUT))
        except (TimeoutError, ValueError):
            hello = None
        call = redeem(hello.get("ticket")) if isinstance(hello, dict) and hello.get("t") == "hello" else None
        if call is None:
            await ws.close(1008, "Ticket rejected")
            return
        if len(stations) >= MAX_CONNECTIONS or sum(s.call == call for s in stations.values()) >= MAX_PER_CALL:
            await ws.close(1013, "Too many connections")
            return
        station = Station(ws, call)
        stations[station.sid] = station
        await ws.send(json.dumps({"t": "welcome", "sid": station.sid, "call": call}))

        async for raw in ws:
            try:
                msg = json.loads(raw) if isinstance(raw, str) else None
                if not isinstance(msg, dict) or msg.get("t") != "key":
                    raise Reject("Invalid message")
                deliver(station, accept_key(station, msg))
            except (Reject, ValueError) as error:
                reason = str(error) if isinstance(error, Reject) else "Invalid message"
                # off the air now; the close handshake can take a while behind queued frames
                leave(station)
                await ws.send(json.dumps({"t": "err", "error": reason}))
                await ws.close(1008, reason)
                break
    except ConnectionClosed:
        pass
    finally:
        if station is not None:
            leave(station)


def leave(station):
    if stations.pop(station.sid, None) is not None and station.sent:
        deliver(station, {"t": "end", "sid": station.sid})


async def start(chat_sock, live_sock=None):
    servers = [await asyncio.start_unix_server(serve_chat, sock=chat_sock)]
    if live_sock is not None:
        servers.append(await unix_serve(
            handle_live, sock=live_sock, process_request=check_request,
            max_size=MAX_FRAME, max_queue=16, compression=None, server_header=None,
            ping_interval=10, ping_timeout=10, open_timeout=5, close_timeout=2,
        ))
    return servers


def systemd_sockets():
    if os.environ.get("LISTEN_PID") != str(os.getpid()):
        return {"chat": socket.socket(fileno=3)}
    names = os.environ.get("LISTEN_FDNAMES", "").split(":")
    found = {}
    for i in range(int(os.environ.get("LISTEN_FDS", "1"))):
        name = names[i] if i < len(names) else ""
        found.setdefault("live" if name == "live" else "chat", socket.socket(fileno=3 + i))
    return found


async def main():
    sockets = systemd_sockets()
    if "live" not in sockets:
        print("cw-live.socket is not attached: live CW is unavailable", flush=True)
    await start(sockets["chat"], sockets.get("live"))
    while True:
        await asyncio.sleep(5)
        expire()


if __name__ == "__main__":
    asyncio.run(main())
