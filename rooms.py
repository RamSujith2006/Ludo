"""Rooms, lobby, turn timers and bots.

All multiplayer logic lives here, independent of Flask-SocketIO.  ``app.py``
wires socket events to :class:`Hub` methods and gives it a transport that
knows how to emit to clients, so the whole thing can be driven by a fake
transport and a fake clock in tests.

Transport interface::

    emit(event, payload, room=None, sid=None)
    join(sid, room_code)
    leave(sid, room_code)
"""
from __future__ import annotations

import os
import random
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

from game import LudoGame, RuleError, MIN_PLAYERS, MAX_PLAYERS

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"   # no I, O, 0, 1
BOT_NAMES = ["Ruby", "Jade", "Onyx", "Pixel", "Nova",
             "Echo", "Blaze", "Mango", "Zephyr", "Coco"]


@dataclass
class Settings:
    pregame_seconds: float = 6.0     # length of the "match starting" screen
    turn_seconds: float = 40.0       # idle limit for a connected human
    away_seconds: float = 8.0        # idle limit for a disconnected human
    bot_delay: float = 0.9           # pause before a bot rolls / moves
    nomove_delay: float = 1.3        # pause when a roll has no legal move
    max_rooms: int = 1000
    lobby_grace: float = 30.0        # keep a dropped player's seat this long
    idle_room_ttl: float = 300.0     # delete rooms nobody is connected to

    @classmethod
    def from_env(cls) -> "Settings":
        def f(name, default):
            try:
                return float(os.getenv(name, default))
            except ValueError:
                return default
        return cls(
            pregame_seconds=f("LUDO_PREGAME_SECONDS", cls.pregame_seconds),
            turn_seconds=f("LUDO_TURN_SECONDS", cls.turn_seconds),
            away_seconds=f("LUDO_AWAY_SECONDS", cls.away_seconds),
            bot_delay=f("LUDO_BOT_DELAY", cls.bot_delay),
            max_rooms=int(f("LUDO_MAX_ROOMS", cls.max_rooms)),
        )


@dataclass
class Player:
    uid: str                       # public id, safe to show other players
    pid: Optional[str]             # private id kept in the client's storage
    name: str
    bot: bool = False
    sid: Optional[str] = None
    connected: bool = True
    away: bool = False             # bot-controlled after missing turns
    left: bool = False             # left mid-match; seat is auto-played
    missed: int = 0
    last_seen: float = 0.0


@dataclass
class Room:
    code: str
    cfg: dict
    players: list = field(default_factory=list)
    host_uid: Optional[str] = None
    phase: str = "lobby"           # lobby | starting | playing | finished
    game: Optional[LudoGame] = None
    match_no: int = 0
    starts_at: float = 0.0
    input_since: float = 0.0
    pace_until: float = 0.0
    last_active: float = 0.0
    result: Optional[list] = None


# ---------------------------------------------------------------- helpers
def clean_name(raw, default: str) -> str:
    s = re.sub(r"[\x00-\x1f\x7f<>]", "", str(raw or "")).strip()[:16].strip()
    return s or default


def clean_code(raw) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(raw or "").upper())[:5]


def clean_pid(raw) -> Optional[str]:
    s = str(raw or "")
    return s if re.fullmatch(r"[A-Za-z0-9_-]{8,64}", s) else None


def _int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def clean_cfg(data: dict, base: Optional[dict] = None) -> dict:
    cfg = dict(base or {"max_players": 4, "tokens": 0, "mode": "first",
                        "quick": False, "auto_single": True})
    if "max_players" in data:
        cfg["max_players"] = min(MAX_PLAYERS, max(MIN_PLAYERS, _int(data["max_players"], cfg["max_players"])))
    if "tokens" in data:
        t = _int(data["tokens"], 0)
        cfg["tokens"] = t if 1 <= t <= 4 else 0          # 0 = automatic
    if data.get("mode") in ("first", "ranking"):
        cfg["mode"] = data["mode"]
    if "quick" in data:
        cfg["quick"] = bool(data["quick"])
    if "auto_single" in data:
        cfg["auto_single"] = bool(data["auto_single"])
    return cfg


class Hub:
    def __init__(self, transport, settings: Optional[Settings] = None,
                 clock: Callable[[], float] = time.time,
                 rng: Optional[random.Random] = None):
        self.t = transport
        self.s = settings or Settings()
        self.clock = clock
        self.rng = rng or random.SystemRandom()
        self.rooms: dict[str, Room] = {}
        self.sessions: dict[str, tuple[str, str]] = {}   # sid -> (code, uid)
        self.lock = threading.RLock()
        self._last_house = 0.0

    # ------------------------------------------------------------ plumbing
    def _err(self, sid, message: str) -> None:
        self.t.emit("error_msg", {"message": message}, sid=sid)

    def _ctx(self, sid):
        info = self.sessions.get(sid)
        if not info:
            return None, None
        room = self.rooms.get(info[0])
        if not room:
            return None, None
        for p in room.players:
            if p.uid == info[1]:
                return room, p
        return None, None

    def _new_code(self) -> str:
        while True:
            code = "".join(self.rng.choice(CODE_ALPHABET) for _ in range(5))
            if code not in self.rooms:
                return code

    def _unique_name(self, room: Room, name: str) -> str:
        taken = {p.name.lower() for p in room.players}
        if name.lower() not in taken:
            return name
        for i in range(2, 100):
            cand = f"{name[:13]} {i}"
            if cand.lower() not in taken:
                return cand
        return name

    def _is_auto(self, p: Player) -> bool:
        return p.bot or p.away or p.left

    def _limit(self, p: Player) -> float:
        return self.s.turn_seconds if p.connected else self.s.away_seconds

    def _humans(self, room: Room):
        return [p for p in room.players if not p.bot and not p.left]

    # ----------------------------------------------------- public payload
    def public_state(self, room: Room) -> dict:
        now = self.clock()
        g = room.game
        in_match = room.phase in ("starting", "playing", "finished") and g is not None
        ranks = {}
        if in_match:
            order = g.ranking if g.over else g.finished
            ranks = {seat: i + 1 for i, seat in enumerate(order)}
        players = []
        for i, p in enumerate(room.players):
            d = {"uid": p.uid, "name": p.name, "bot": p.bot, "color": i,
                 "connected": p.connected or p.bot, "away": p.away or p.left}
            if in_match:
                d["tokens"] = list(g.tokens[i])
                d["home"] = sum(1 for x in g.tokens[i] if x == g.HOME)
                d["rank"] = ranks.get(i)
                d["stats"] = dict(g.stats[i])
            players.append(d)
        state = {
            "code": room.code, "phase": room.phase, "cfg": dict(room.cfg),
            "host": room.host_uid, "match_no": room.match_no,
            "players": players, "game": None, "result": room.result,
            "starts_in": max(0.0, room.starts_at - now) if room.phase == "starting" else 0,
            "turn_left": None,
        }
        if in_match:
            state["game"] = g.snapshot()
            if room.phase == "playing" and not g.over:
                p = room.players[g.turn]
                if not self._is_auto(p):
                    left = self._limit(p) - (now - room.input_since)
                    state["turn_left"] = round(max(0.0, left), 1)
        return state

    def _broadcast(self, room: Room) -> None:
        self.t.emit("state", self.public_state(room), room=room.code)

    # --------------------------------------------------- joining / leaving
    def _add_human(self, room: Room, sid: str, pid: str, name: str) -> Player:
        p = Player(uid=secrets.token_hex(4), pid=pid,
                   name=self._unique_name(room, name), sid=sid,
                   last_seen=self.clock())
        room.players.append(p)
        self.sessions[sid] = (room.code, p.uid)
        self.t.join(sid, room.code)
        return p

    def _joined(self, room: Room, p: Player) -> None:
        self.t.emit("joined", {"code": room.code, "uid": p.uid}, sid=p.sid)

    def _attach(self, room: Room, p: Player, sid: str) -> None:
        """(Re)connect an existing seat to a socket."""
        if self.sessions.get(sid, (None, None)) != (room.code, p.uid):
            self._drop_session(sid)           # sid was sitting in another seat
        if p.sid and p.sid != sid:
            self.sessions.pop(p.sid, None)
            self.t.leave(p.sid, room.code)
        p.sid = sid
        p.connected = True
        p.away = False
        p.left = False
        p.missed = 0
        self.sessions[sid] = (room.code, p.uid)
        self.t.join(sid, room.code)
        self._joined(room, p)
        self._broadcast(room)

    def _drop_session(self, sid: str) -> None:
        room, p = self._ctx(sid)
        if room:
            self._leave(room, p)
        self.sessions.pop(sid, None)

    def create(self, sid: str, data: dict) -> None:
        with self.lock:
            pid = clean_pid(data.get("pid"))
            if not pid:
                return self._err(sid, "Missing player id - please reload the page.")
            if len(self.rooms) >= self.s.max_rooms:
                return self._err(sid, "The server is full right now. Try again soon.")
            self._drop_session(sid)
            room = Room(code=self._new_code(), cfg=clean_cfg(data),
                        last_active=self.clock())
            self.rooms[room.code] = room
            p = self._add_human(room, sid, pid, clean_name(data.get("name"), "Host"))
            room.host_uid = p.uid
            self._joined(room, p)
            self._broadcast(room)

    def join(self, sid: str, data: dict) -> None:
        with self.lock:
            pid = clean_pid(data.get("pid"))
            if not pid:
                return self._err(sid, "Missing player id - please reload the page.")
            room = self.rooms.get(clean_code(data.get("code")))
            if not room:
                return self._err(sid, "Room not found. Check the code and try again.")
            for p in room.players:
                if p.pid == pid:
                    return self._attach(room, p, sid)
            if room.phase != "lobby":
                return self._err(sid, "That match has already started.")
            if len(room.players) >= room.cfg["max_players"]:
                return self._err(sid, "That room is full.")
            self._drop_session(sid)
            p = self._add_human(room, sid, pid, clean_name(data.get("name"), f"Player {len(room.players) + 1}"))
            self._joined(room, p)
            self._broadcast(room)

    def rejoin(self, sid: str, data: dict) -> None:
        with self.lock:
            pid = clean_pid(data.get("pid"))
            room = self.rooms.get(clean_code(data.get("code")))
            if room and pid:
                for p in room.players:
                    if p.pid == pid:
                        return self._attach(room, p, sid)
            self.t.emit("rejoin_failed", {}, sid=sid)

    def _remove_from_room(self, room: Room, p: Player) -> None:
        if p.sid:
            self.sessions.pop(p.sid, None)
            self.t.leave(p.sid, room.code)
        p.sid = None
        p.connected = False

    def _leave(self, room: Room, p: Player) -> None:
        self._remove_from_room(room, p)
        if room.phase == "lobby":
            room.players.remove(p)
        else:
            p.left = True
            p.away = True
        self._after_membership(room)

    def _delete_room(self, room: Room) -> None:
        for p in room.players:
            if p.sid:
                self.sessions.pop(p.sid, None)
                self.t.leave(p.sid, room.code)
        self.rooms.pop(room.code, None)

    def _ensure_host(self, room: Room, strict: bool = False) -> None:
        now = self.clock()
        host = next((p for p in room.players if p.uid == room.host_uid), None)
        ok = host and not host.left and (
            host.connected or (not strict and now - host.last_seen <= self.s.lobby_grace))
        if ok:
            return
        for p in room.players:
            if not p.bot and not p.left and p.connected:
                room.host_uid = p.uid
                return

    def _after_membership(self, room: Room) -> None:
        if not self._humans(room):
            return self._delete_room(room)
        self._ensure_host(room, strict=True)
        self._broadcast(room)

    def leave(self, sid: str) -> None:
        with self.lock:
            room, p = self._ctx(sid)
            if room:
                self._leave(room, p)
            self.t.emit("left", {}, sid=sid)

    def disconnect(self, sid: str) -> None:
        with self.lock:
            room, p = self._ctx(sid)
            self.sessions.pop(sid, None)
            if not room:
                return
            p.sid = None
            p.connected = False
            p.last_seen = self.clock()
            self._broadcast(room)

    # -------------------------------------------------------- lobby control
    def _host_ctx(self, sid, phase="lobby"):
        room, p = self._ctx(sid)
        if not room:
            return None, None
        if room.host_uid != p.uid:
            self._err(sid, "Only the room host can do that.")
            return None, None
        if room.phase != phase:
            return None, None
        return room, p

    def configure(self, sid: str, data: dict) -> None:
        with self.lock:
            room, _ = self._host_ctx(sid)
            if not room:
                return
            room.cfg = clean_cfg(data, room.cfg)
            room.cfg["max_players"] = max(room.cfg["max_players"], len(room.players))
            self._broadcast(room)

    def add_bot(self, sid: str) -> None:
        with self.lock:
            room, _ = self._host_ctx(sid)
            if not room:
                return
            if len(room.players) >= room.cfg["max_players"]:
                return self._err(sid, "The room is full.")
            used = {p.name for p in room.players}
            pool = [n for n in BOT_NAMES if f"{n} (bot)" not in used] or BOT_NAMES
            name = f"{self.rng.choice(pool)} (bot)"
            room.players.append(Player(uid=secrets.token_hex(4), pid=None,
                                       name=self._unique_name(room, name), bot=True,
                                       last_seen=self.clock()))
            self._broadcast(room)

    def kick(self, sid: str, uid: str) -> None:
        with self.lock:
            room, me = self._host_ctx(sid)
            if not room or uid == me.uid:
                return
            target = next((p for p in room.players if p.uid == uid), None)
            if not target:
                return
            sid_t = target.sid
            self._remove_from_room(room, target)
            room.players.remove(target)
            if sid_t:
                self.t.emit("kicked", {}, sid=sid_t)
            self._broadcast(room)

    def start(self, sid: str) -> None:
        with self.lock:
            room, _ = self._host_ctx(sid)
            if not room:
                return
            for p in list(room.players):          # drop people who vanished
                if not p.bot and not p.connected:
                    room.players.remove(p)
            n = len(room.players)
            if n < MIN_PLAYERS:
                self._broadcast(room)
                return self._err(sid, "Add at least one more player (or a bot) to start.")
            for p in room.players:
                p.away = False
                p.left = False
                p.missed = 0
            room.game = LudoGame(
                n, tokens=room.cfg["tokens"] or None, mode=room.cfg["mode"],
                quick=room.cfg["quick"], start=self.rng.randrange(n),
                names=[p.name for p in room.players], rng=self.rng)
            room.match_no += 1
            room.result = None
            room.phase = "starting"
            now = self.clock()
            room.starts_at = now + self.s.pregame_seconds
            room.last_active = now
            self._broadcast(room)
            if self.s.pregame_seconds <= 0:
                self._begin(room, now)

    def again(self, sid: str) -> None:
        with self.lock:
            room, _ = self._host_ctx(sid, phase="finished")
            if not room:
                return
            for p in list(room.players):
                if p.left or (not p.bot and not p.connected):
                    room.players.remove(p)
                else:
                    p.away = False
                    p.missed = 0
            room.phase = "lobby"
            room.game = None
            room.result = None
            self._broadcast(room)

    # ------------------------------------------------------------ gameplay
    def _begin(self, room: Room, now: float) -> None:
        room.phase = "playing"
        room.input_since = now
        room.pace_until = now + 1.0
        self._broadcast(room)

    def roll(self, sid: str) -> None:
        with self.lock:
            room, p = self._ctx(sid)
            if not room or room.phase != "playing":
                return
            g = room.game
            if room.players[g.turn] is not p or g.phase != "roll":
                return
            p.away, p.missed = False, 0
            self._do_roll(room, self.clock())

    def move(self, sid: str, token) -> None:
        with self.lock:
            room, p = self._ctx(sid)
            if not room or room.phase != "playing":
                return
            g = room.game
            if room.players[g.turn] is not p or g.phase != "move":
                return
            token = _int(token, -1)
            if token not in g.legal:
                return
            p.away, p.missed = False, 0
            self._do_move(room, token, self.clock())

    def _do_roll(self, room: Room, now: float) -> None:
        g = room.game
        g.roll()
        room.input_since = now
        room.pace_until = now + (self.s.bot_delay if g.legal else self.s.nomove_delay)
        self._broadcast(room)

    def _do_move(self, room: Room, token: int, now: float) -> None:
        g = room.game
        g.move(token)
        room.input_since = now
        room.pace_until = now + self.s.bot_delay
        if g.over:
            self._finish(room)
        self._broadcast(room)

    def _do_pass(self, room: Room, now: float) -> None:
        room.game.pass_turn()
        room.input_since = now
        room.pace_until = now + self.s.bot_delay * 0.6
        self._broadcast(room)

    def _finish(self, room: Room) -> None:
        g = room.game
        room.phase = "finished"
        room.result = [{
            "rank": i + 1, "uid": room.players[s].uid, "name": room.players[s].name,
            "color": s, "bot": room.players[s].bot,
            "home": sum(1 for x in g.tokens[s] if x == g.HOME),
            "finished": s in g.finished, "stats": dict(g.stats[s]),
        } for i, s in enumerate(g.ranking)]

    def _timeout(self, room: Room, p: Player) -> None:
        p.missed += 1
        if p.missed >= 2 and not p.away:
            p.away = True
            seat = room.players.index(p)
            room.game._say(seat, f"{p.name} is away - a bot will play for them")

    def _tick_game(self, room: Room, now: float) -> None:
        g = room.game
        p = room.players[g.turn]
        auto = self._is_auto(p)
        waited = now - room.input_since
        if g.phase == "roll":
            if auto:
                if now >= room.pace_until:
                    self._do_roll(room, now)
            elif waited >= self._limit(p):
                self._timeout(room, p)
                self._do_roll(room, now)
        elif g.phase == "move":
            if now < room.pace_until:
                return                       # let the dice / animation play
            if not g.legal:
                return self._do_pass(room, now)
            forced = g.forced_token()
            if forced is not None and (auto or room.cfg["auto_single"]):
                self._do_move(room, forced, now)
            elif auto:
                self._do_move(room, g.choose_token(), now)
            elif waited >= self._limit(p):
                self._timeout(room, p)
                self._do_move(room, g.choose_token(), now)

    # ------------------------------------------------------------ scheduler
    def tick_all(self) -> None:
        """Advance timers and bots.  Call roughly every 0.25 seconds."""
        with self.lock:
            now = self.clock()
            for room in list(self.rooms.values()):
                try:
                    if room.phase == "starting" and now >= room.starts_at:
                        self._begin(room, now)
                    elif room.phase == "playing":
                        self._tick_game(room, now)
                except RuleError:
                    pass
            if now - self._last_house >= 5:
                self._last_house = now
                self._housekeeping(now)

    def _housekeeping(self, now: float) -> None:
        for room in list(self.rooms.values()):
            changed = False
            if room.phase == "lobby":
                for p in list(room.players):
                    if not p.bot and not p.connected and now - p.last_seen > self.s.lobby_grace:
                        room.players.remove(p)
                        changed = True
            humans = self._humans(room)
            if not humans:
                self._delete_room(room)
                continue
            before = room.host_uid
            self._ensure_host(room)
            changed = changed or room.host_uid != before
            if any(p.connected for p in humans):
                room.last_active = now
            elif now - room.last_active > self.s.idle_room_ttl:
                self._delete_room(room)
                continue
            if changed:
                self._broadcast(room)

    def health(self) -> dict:
        with self.lock:
            return {"rooms": len(self.rooms),
                    "players": sum(1 for r in self.rooms.values()
                                   for p in r.players if not p.bot and p.connected)}
