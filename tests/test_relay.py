import asyncio
import json
import os
import socket
import statistics
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import chat_relay as relay  # noqa: E402

from websockets.asyncio.client import unix_connect  # noqa: E402
from websockets.exceptions import ConnectionClosed, InvalidStatus  # noqa: E402


def listener(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.bind(path)
    sock.listen()
    return sock


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


relay_close_wait = 4   # the close handshake may wait out close_timeout behind queued frames


def key(q, n, k, e, f=0):
    return json.dumps({"t": "key", "q": q, "n": n, "k": k, "f": f, "e": e})


class RelayTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        for table in (relay.views, relay.rates, relay.tickets, relay.ticket_rates, relay.stations, relay.call_buckets):
            table.clear()
        self.dir = tempfile.TemporaryDirectory()
        self.chat_path = os.path.join(self.dir.name, "chat.sock")
        self.live_path = os.path.join(self.dir.name, "live.sock")
        self.servers = await relay.start(listener(self.chat_path), listener(self.live_path))
        self.clients = []

    async def asyncTearDown(self):
        for ws in self.clients:
            await ws.close()
        for server in self.servers:
            server.close()
        await asyncio.sleep(0.05)
        self.dir.cleanup()

    async def chat(self, request):
        reader, writer = await asyncio.open_unix_connection(self.chat_path)
        writer.write(json.dumps(request).encode() + b"\n")
        await writer.drain()
        reply = json.loads(await reader.readline())
        writer.close()
        return reply

    async def connect(self, call, origin="https://cw.test", path="/live"):
        ws = await unix_connect(self.live_path, uri="ws://cw.test" + path, origin=origin)
        self.clients.append(ws)
        if call is None:
            return ws
        ticket = (await self.chat({"action": "ticket", "call": call}))["ticket"]
        await ws.send(json.dumps({"t": "hello", "ticket": ticket}))
        welcome = json.loads(await ws.recv())
        self.assertEqual(welcome["t"], "welcome")
        self.assertEqual(welcome["call"], call)
        ws.sid = welcome["sid"]
        return ws

    async def recv(self, ws, timeout=1):
        return json.loads(await asyncio.wait_for(ws.recv(), timeout))

    async def expect_rejected(self, ws, reason):
        self.assertEqual(await self.recv(ws), {"t": "err", "error": reason})
        with self.assertRaises(ConnectionClosed) as closed:
            await asyncio.wait_for(ws.recv(), relay_close_wait)
        self.assertEqual(closed.exception.rcvd.code, 1008)

    # tickets

    async def test_ticket_is_single_use_and_expires(self):
        clock = FakeClock()
        with mock.patch.object(relay, "clock", clock):
            first = relay.issue_ticket("OE1AAA")["ticket"]
            self.assertEqual(relay.redeem(first), "OE1AAA")
            self.assertIsNone(relay.redeem(first))
            late = relay.issue_ticket("OE1AAA")["ticket"]
            clock.now += relay.TICKET_TTL
            self.assertIsNone(relay.redeem(late))
            relay.issue_ticket("OE1AAA")
            clock.now += relay.TICKET_TTL + 61
            relay.expire()
            self.assertEqual(relay.tickets, {})
            self.assertEqual(relay.ticket_rates, {})
        self.assertIsNone(relay.redeem(None))
        self.assertIsNone(relay.redeem(["x"]))

    async def test_ticket_issue_is_rate_limited_per_call(self):
        for _ in range(relay.TICKETS_PER_MINUTE):
            self.assertIn("ticket", await self.chat({"action": "ticket", "call": "OE1AAA"}))
        self.assertEqual((await self.chat({"action": "ticket", "call": "OE1AAA"}))["status"], 429)
        self.assertIn("ticket", await self.chat({"action": "ticket", "call": "OE1BBB"}))

    # handshake

    async def test_foreign_origin_and_wrong_path_are_refused(self):
        with self.assertRaises(InvalidStatus) as refused:
            await self.connect(None, origin="https://evil.test")
        self.assertEqual(refused.exception.response.status_code, 403)
        with self.assertRaises(InvalidStatus) as refused:
            await unix_connect(self.live_path, uri="ws://cw.test/live")
        self.assertEqual(refused.exception.response.status_code, 403)
        with self.assertRaises(InvalidStatus) as refused:
            await self.connect(None, path="/other")
        self.assertEqual(refused.exception.response.status_code, 404)
        with mock.patch.dict(os.environ, {"CW_LIVE_ORIGINS": "https://a.test https://b.test"}):
            await self.connect(None, origin="https://b.test")
            with self.assertRaises(InvalidStatus):
                await self.connect(None)

    async def test_bad_ticket_and_missing_hello_are_closed(self):
        ws = await self.connect(None)
        await ws.send(json.dumps({"t": "hello", "ticket": "0" * 64}))
        with self.assertRaises(ConnectionClosed) as closed:
            await ws.recv()
        self.assertEqual(closed.exception.rcvd.code, 1008)

        with mock.patch.object(relay, "HELLO_TIMEOUT", 0.1):
            ws = await self.connect(None)
            with self.assertRaises(ConnectionClosed) as closed:
                await asyncio.wait_for(ws.recv(), 2)
            self.assertEqual(closed.exception.rcvd.code, 1008)
        self.assertEqual(relay.stations, {})

    async def test_connections_per_call_are_capped(self):
        for _ in range(relay.MAX_PER_CALL):
            await self.connect("OE1AAA")
        ws = await self.connect(None)
        ticket = (await self.chat({"action": "ticket", "call": "OE1AAA"}))["ticket"]
        await ws.send(json.dumps({"t": "hello", "ticket": ticket}))
        with self.assertRaises(ConnectionClosed) as closed:
            await ws.recv()
        self.assertEqual(closed.exception.rcvd.code, 1013)

    # forwarding

    async def test_forwards_in_order_to_other_calls_only(self):
        clock = FakeClock()
        with mock.patch.object(relay, "clock", clock):
            await self.forwards_in_order(clock)

    async def forwards_in_order(self, clock):
        a, twin, b = await self.connect("OE1AAA"), await self.connect("OE1AAA"), await self.connect("OE1BBB")
        state, t = 0, 0
        for q in range(1, 401):
            clock.now += 0.015
            t += 7
            state = 1 - state
            await a.send(key(q, t, state, [[t, state]], f=q % 50))
            message = await self.recv(b)
            self.assertEqual((message["t"], message["q"], message["sid"], message["call"]), ("key", q, a.sid, "OE1AAA"))
            self.assertEqual(message["e"], [[q * 7, q % 2]])
            self.assertEqual(message["f"], q % 50)

        # the twin tab heard none of its own callsign: the first thing it gets is from OE1BBB
        await b.send(key(1, 0, 1, [[0, 1]]))
        self.assertEqual((await self.recv(twin))["call"], "OE1BBB")
        self.assertEqual((await self.recv(a))["call"], "OE1BBB")

    async def test_heartbeat_and_initial_key_down_need_no_duration(self):
        a, b = await self.connect("OE1AAA"), await self.connect("OE1BBB")
        await a.send(key(1, 0, 1, [[0, 1]]))
        self.assertEqual((await self.recv(b))["e"], [[0, 1]])
        await a.send(key(2, 250, 1, []))
        self.assertEqual((await self.recv(b))["k"], 1)

    async def test_end_is_sent_when_a_sender_leaves(self):
        a, b, quiet = await self.connect("OE1AAA"), await self.connect("OE1BBB"), await self.connect("OE1CCC")
        await a.send(key(1, 0, 1, [[0, 1]]))
        await self.recv(b)
        await a.close()
        self.assertEqual(await self.recv(b), {"t": "end", "sid": a.sid})
        await quiet.close()   # never sent: no end
        await b.send(key(1, 0, 1, [[0, 1]]))
        await asyncio.sleep(0.05)
        self.assertEqual(list(relay.stations), [b.sid])

    # validation

    async def test_invalid_packets_are_rejected(self):
        cases = [
            ("Out of sequence", key(2, 0, 1, [[0, 1]])),
            ("Invalid timing", key(1, -1, 0, [])),
            ("Invalid timing", key(1, 60000, 0, [])),
            ("Invalid key data", key(1, 10, 1, [[11, 1]])),          # event after the packet time
            ("Invalid key data", key(1, 10, 0, [[0, 1], [5, 1]])),  # does not alternate
            ("Invalid key data", key(1, 10, 0, [[0, 1]])),          # k disagrees with the events
            ("Invalid key data", key(1, 10, 1, [[0, 1]], f=20000)),
            ("Invalid key data", key(1, 10, 1, [[0.5, 1]])),
            ("Invalid key data", key(1, 10, 0, [[i % 10, (i + 1) % 2] for i in range(66)])),
            ("Invalid message", json.dumps({"t": "chat", "text": "hi"})),
            ("Invalid message", "not json"),
        ]
        b = await self.connect("OE1BBB")
        for reason, packet in cases:
            with self.subTest(reason=reason, packet=packet):
                ws = await self.connect("OE1AAA")
                await ws.send(packet)
                await self.expect_rejected(ws, reason)

        # a sender cut off mid-stream is announced as ended
        ws = await self.connect("OE1AAA")
        await ws.send(key(1, 0, 1, [[0, 1]]))
        await self.recv(b)
        await ws.send(key(2, 5, 1, [[3, 0]]))
        await self.expect_rejected(ws, "Invalid key data")
        self.assertEqual(await self.recv(b), {"t": "end", "sid": ws.sid})

        # time never runs backwards across packets
        ws = await self.connect("OE1AAA")
        await ws.send(key(1, 100, 1, [[100, 1]]))
        await ws.send(key(2, 90, 0, [[95, 0]]))
        await self.expect_rejected(ws, "Invalid timing")

    async def test_oversized_frame_is_refused(self):
        ws = await self.connect("OE1AAA")
        await ws.send("x" * (relay.MAX_FRAME + 1))
        with self.assertRaises(ConnectionClosed) as closed:
            await asyncio.wait_for(ws.recv(), 1)
        self.assertEqual(closed.exception.rcvd.code, 1009)

    # limits

    async def test_continuous_fast_keying_for_minutes_is_not_limited_but_a_flood_is(self):
        clock = FakeClock()
        with mock.patch.object(relay, "clock", clock):
            a, b = await self.connect("OE1AAA"), await self.connect("OE1BBB")
            # 40 WPM dits held for three minutes: a transition every 30 ms, each sent at once
            q, state = 0, 0
            for step in range(6000):
                clock.now += 0.030
                q += 1
                state = 1 - state
                await a.send(key(q, step * 30, state, [[step * 30, state]]))
                self.assertEqual((await self.recv(b))["q"], q)

            # far beyond any keyer: hundreds of packets with no time passing
            for _ in range(relay.PACKET_BURST + 10):
                q += 1
                await a.send(key(q, 6000 * 30, state, []))
            reasons = []
            try:
                while True:
                    message = await self.recv(a, relay_close_wait)
                    reasons.append(message.get("error"))
                    if len(reasons) > 1:
                        break
            except ConnectionClosed:
                pass
            self.assertEqual(reasons, ["Sending too fast"])
            self.assertEqual(list(relay.stations), [b.sid])

    async def test_tabs_of_one_call_share_a_limit(self):
        clock = FakeClock()
        with mock.patch.object(relay, "clock", clock):
            tabs = [await self.connect("OE1AAA") for _ in range(3)]
            for q in range(1, relay.PACKET_BURST):
                for ws in tabs:
                    try:
                        await ws.send(key(q, 0, 0, []))
                    except ConnectionClosed:
                        pass
            await asyncio.sleep(0.1)
            # each tab alone is under its own burst, together they exceed the callsign's
            self.assertLess(len(relay.stations), 3)

    def test_congested_receivers_are_skipped_then_dropped(self):
        clock = FakeClock()

        class Transport:
            def __init__(self, size):
                self.size, self.aborted = size, False

            def get_write_buffer_size(self):
                return self.size

            def abort(self):
                self.aborted = True

        class Conn:
            def __init__(self, size):
                self.transport = Transport(size)

        def station(call, size=0):
            item = mock.Mock(call=call, ws=Conn(size), congested_since=None)
            relay.stations[id(item)] = item
            return item

        sent = []
        with mock.patch.object(relay, "clock", clock), mock.patch.object(relay, "broadcast", lambda targets, data: sent.append(targets)):
            sender, fine, slow = station("A"), station("B"), station("C", relay.SEND_BUFFER_LIMIT + 1)
            relay.deliver(sender, {"t": "key"})
            self.assertEqual(sent[-1], [fine.ws])
            self.assertFalse(slow.ws.transport.aborted)
            clock.now += relay.CONGESTED_CLOSE_AFTER + 1
            relay.deliver(sender, {"t": "key"})
            self.assertTrue(slow.ws.transport.aborted)
            self.assertFalse(fine.ws.transport.aborted)
        relay.stations.clear()

    # chat stays as it was

    async def test_chat_protocol_is_unchanged_and_old_cw_is_gone(self):
        base = {"channel": "chat", "call": "OE1AAA", "view": "v1"}
        self.assertEqual(await self.chat({**base, "action": "join"}), {"ok": True})
        self.assertEqual(await self.chat({**base, "action": "send", "text": "hello"}), {"ok": True})
        self.assertEqual(await self.chat({**base, "action": "poll"}), {"messages": [{"text": "hello", "call": "OE1AAA"}]})
        self.assertEqual(await self.chat({**base, "action": "poll"}), {"messages": []})
        self.assertEqual((await self.chat({**base, "channel": "cw", "action": "join"}))["status"], 410)

    async def test_state_is_cleaned_up(self):
        a, b = await self.connect("OE1AAA"), await self.connect("OE1BBB")
        await a.send(key(1, 0, 1, [[0, 1]]))
        await self.recv(b)
        await a.close()
        await b.close()
        await asyncio.sleep(0.05)
        self.assertEqual(relay.stations, {})
        relay.expire()
        self.assertEqual(relay.call_buckets, {})

    async def test_forwarding_latency(self):
        clock = FakeClock()
        with mock.patch.object(relay, "clock", clock):
            await self.forwarding_latency(clock)

    async def forwarding_latency(self, clock):
        a, b = await self.connect("OE1AAA"), await self.connect("OE1BBB")
        delays = []
        for q in range(1, 501):
            clock.now += 0.015
            started = time.perf_counter()
            await a.send(key(q, q, q % 2, [[q, q % 2]]))
            await self.recv(b)
            delays.append((time.perf_counter() - started) * 1000)
        delays.sort()
        p50, p99 = statistics.median(delays), delays[int(len(delays) * 0.99)]
        print(f"\nrelay forwarding over unix sockets, 500 packets: median {p50:.2f} ms, p99 {p99:.2f} ms, max {delays[-1]:.2f} ms")
        self.assertLess(p50, 10)


if __name__ == "__main__":
    unittest.main()
