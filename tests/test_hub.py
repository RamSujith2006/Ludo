import os, random, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from rooms import Hub, Settings


class FakeTransport:
    def __init__(self):
        self.members = {}            # code -> set(sid)
        self.inbox = {}              # sid -> list of (event, payload)

    def emit(self, event, payload, room=None, sid=None):
        targets = self.members.get(room, set()) if room else {sid}
        for s in targets:
            self.inbox.setdefault(s, []).append((event, payload))

    def join(self, sid, code):
        self.members.setdefault(code, set()).add(sid)

    def leave(self, sid, code):
        self.members.get(code, set()).discard(sid)

    def last(self, sid, event):
        for e, p in reversed(self.inbox.get(sid, [])):
            if e == event:
                return p

    def events(self, sid, event):
        return [p for e, p in self.inbox.get(sid, []) if e == event]


class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t


class HubTest(unittest.TestCase):
    def setUp(self):
        self.tr, self.clock = FakeTransport(), Clock()
        self.s = Settings(pregame_seconds=2, turn_seconds=10, away_seconds=3,
                          bot_delay=0.5, nomove_delay=0.5, lobby_grace=10, idle_room_ttl=60)
        self.hub = Hub(self.tr, self.s, self.clock, random.Random(7))

    def advance(self, seconds, step=0.25):
        end = self.clock.t + seconds
        while self.clock.t < end:
            self.clock.t += step
            self.hub.tick_all()

    def state(self, sid): return self.tr.last(sid, "state")

    def make_room(self, n_humans=1, bots=0, **cfg):
        pids = [f"pid-{i:08d}" for i in range(n_humans)]
        self.hub.create("s0", {"name": "Host", "pid": pids[0], "max_players": 10, **cfg})
        code = self.tr.last("s0", "joined")["code"]
        for i in range(1, n_humans):
            self.hub.join(f"s{i}", {"code": code, "name": f"P{i}", "pid": pids[i]})
        for _ in range(bots):
            self.hub.add_bot("s0")
        return code, pids

    def test_create_join_and_code_errors(self):
        code, _ = self.make_room(2)
        st = self.state("s0")
        self.assertEqual(st["phase"], "lobby")
        self.assertEqual([p["name"] for p in st["players"]], ["Host", "P1"])
        self.hub.join("x", {"code": "ZZZZZ", "pid": "pid-99999999"})
        self.assertIn("not found", self.tr.last("x", "error_msg")["message"])
        self.hub.join("y", {"code": code.lower(), "name": "Host", "pid": "pid-77777777"})
        names = [p["name"] for p in self.state("y")["players"]]
        self.assertEqual(names, ["Host", "P1", "Host 2"])      # duplicate name made unique

    def test_only_host_controls_and_needs_two_players(self):
        code, _ = self.make_room(2)
        self.hub.start("s1")
        self.assertIn("host", self.tr.last("s1", "error_msg")["message"])
        self.hub.create("solo", {"name": "A", "pid": "pid-55555555"})
        self.hub.start("solo")
        self.assertIn("at least one more", self.tr.last("solo", "error_msg")["message"])

    def test_room_full(self):
        code, _ = self.make_room(1, max_players=2)
        self.hub.join("a", {"code": code, "pid": "pid-aaaaaaaa"})
        self.hub.join("b", {"code": code, "pid": "pid-bbbbbbbb"})
        self.assertIn("full", self.tr.last("b", "error_msg")["message"])

    def test_every_size_plays_to_a_winner_with_ads_phases(self):
        for n in range(2, 11):
            hub = Hub(self.tr, self.s, self.clock, random.Random(n))
            sid = f"g{n}"
            hub.create(sid, {"name": "Host", "pid": f"pid-host{n:04d}", "max_players": n, "mode": "first"})
            for _ in range(n - 1):
                hub.add_bot(sid)
            hub.start(sid)
            self.assertEqual(self.tr.last(sid, "state")["phase"], "starting")   # pre-game ad window
            phases = {"starting"}
            for _ in range(60000):
                self.clock.t += 0.25
                hub.tick_all()
                st = self.tr.last(sid, "state")
                # host is human: play their moves instantly so the test is quick
                g = st["game"]
                if st["phase"] == "playing" and st["players"][g["turn"]]["uid"] == self.tr.last(sid, "joined")["uid"]:
                    if g["phase"] == "roll":
                        hub.roll(sid)
                    elif g["legal"]:
                        hub.move(sid, g["legal"][0])
                phases.add(st["phase"])
                if st["phase"] == "finished":
                    break
            st = self.tr.last(sid, "state")
            self.assertEqual(st["phase"], "finished", f"{n} players never finished")
            self.assertEqual(len(st["result"]), n)
            self.assertEqual(st["result"][0]["rank"], 1)
            self.assertEqual(phases, {"starting", "playing", "finished"})

    def test_afk_human_gets_auto_played_then_marked_away(self):
        code, _ = self.make_room(1, bots=1, mode="first")
        self.hub.start("s0")
        self.advance(self.s.pregame_seconds + 1)
        self.assertEqual(self.state("s0")["phase"], "playing")
        me = self.tr.last("s0", "joined")["uid"]
        # never act: the match must still progress and finish, and the human goes 'away'
        self.advance(20000, step=0.5)
        st = self.state("s0")
        self.assertEqual(st["phase"], "finished")
        self.assertTrue(next(p for p in st["players"] if p["uid"] == me)["away"])

    def test_turn_timer_reported_for_humans_only(self):
        self.make_room(1, bots=1)
        self.hub.start("s0")
        self.advance(self.s.pregame_seconds + 0.5)
        for _ in range(400):
            st = self.state("s0")
            g = st["game"]
            cur = st["players"][g["turn"]]
            if st["phase"] == "playing":
                if cur["bot"]:
                    self.assertIsNone(st["turn_left"])
                else:
                    self.assertIsNotNone(st["turn_left"])
                    break
            self.advance(0.25)
        else:
            self.fail("never reached a human turn")

    def test_disconnect_reconnect_keeps_seat(self):
        code, pids = self.make_room(2, bots=1)
        self.hub.start("s0")
        self.advance(self.s.pregame_seconds + 0.5)
        self.hub.disconnect("s1")
        st = self.state("s0")
        self.assertFalse(next(p for p in st["players"] if p["name"] == "P1")["connected"])
        self.hub.rejoin("s1b", {"code": code, "pid": pids[1]})
        st = self.state("s1b")
        me = self.tr.last("s1b", "joined")["uid"]
        self.assertTrue(next(p for p in st["players"] if p["uid"] == me)["connected"])
        self.hub.rejoin("zz", {"code": code, "pid": "pid-unknown1"})
        self.assertIsNotNone(self.tr.last("zz", "rejoin_failed"))

    def test_late_join_rejected_but_known_player_can_return(self):
        code, pids = self.make_room(2)
        self.hub.start("s0")
        self.hub.join("late", {"code": code, "pid": "pid-lateeeee"})
        self.assertIn("already started", self.tr.last("late", "error_msg")["message"])
        self.hub.join("s1c", {"code": code, "pid": pids[1]})
        self.assertIsNotNone(self.tr.last("s1c", "joined"))

    def test_host_transfer_kick_and_play_again(self):
        code, pids = self.make_room(3)
        host_uid = self.tr.last("s0", "joined")["uid"]
        self.hub.kick("s0", self.tr.last("s2", "joined")["uid"])
        self.assertIsNotNone(self.tr.last("s2", "kicked"))
        self.assertEqual(len(self.state("s0")["players"]), 2)
        self.hub.leave("s0")                           # host leaves the lobby
        st = self.state("s1")
        self.assertEqual(st["host"], self.tr.last("s1", "joined")["uid"])
        self.assertNotEqual(st["host"], host_uid)
        # play again flow
        hub, tr = self.hub, self.tr
        hub.add_bot("s1")
        hub.configure("s1", {"quick": True, "tokens": 1, "mode": "first"})
        hub.start("s1")
        me = tr.last("s1", "joined")["uid"]
        for _ in range(40000):
            self.advance(0.25)
            st = self.state("s1")
            if st["phase"] == "finished":
                break
            g = st["game"]
            if st["phase"] == "playing" and st["players"][g["turn"]]["uid"] == me:
                if g["phase"] == "roll":
                    hub.roll("s1")
                elif g["legal"]:
                    hub.move("s1", g["legal"][0])
        self.assertEqual(self.state("s1")["phase"], "finished")
        hub.again("s1")
        st = self.state("s1")
        self.assertEqual((st["phase"], st["game"], st["result"]), ("lobby", None, None))
        self.assertEqual(len(st["players"]), 2)

    def test_everyone_leaves_deletes_room_and_idle_cleanup(self):
        code, _ = self.make_room(1)
        self.hub.leave("s0")
        self.assertNotIn(code, self.hub.rooms)
        code, _ = self.make_room(1, bots=1)
        self.hub.disconnect("s0")
        self.advance(self.s.idle_room_ttl + 20, step=1)
        self.assertNotIn(code, self.hub.rooms)

    def test_cannot_act_out_of_turn_or_with_bad_token(self):
        code, pids = self.make_room(2)
        self.hub.start("s0")
        self.advance(self.s.pregame_seconds + 0.5)
        st = self.state("s0")
        g = st["game"]
        uids = {"s0": self.tr.last("s0", "joined")["uid"], "s1": self.tr.last("s1", "joined")["uid"]}
        cur = st["players"][g["turn"]]["uid"]
        other = "s1" if uids["s0"] == cur else "s0"
        before = self.state("s0")["game"]["roll_id"]
        self.hub.roll(other)                           # not your turn
        self.assertEqual(self.state("s0")["game"]["roll_id"], before)
        mine = "s0" if other == "s1" else "s1"
        self.hub.move(mine, 3)                         # not in move phase
        self.hub.move(mine, "garbage")
        self.assertEqual(self.state("s0")["game"]["roll_id"], before)

    def test_config_clamped(self):
        code, _ = self.make_room(1)
        self.hub.configure("s0", {"max_players": 99, "tokens": 9, "mode": "bogus"})
        cfg = self.state("s0")["cfg"]
        self.assertEqual((cfg["max_players"], cfg["tokens"], cfg["mode"]), (10, 0, "first"))


if __name__ == "__main__":
    unittest.main()
