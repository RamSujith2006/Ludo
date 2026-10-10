"""Ludo rules engine for 2-10 players.

Pure Python, no web dependencies, so it can be unit-tested and simulated
without a server.

Board model
-----------
The board is a ring of ``L = seg * n`` cells.  Seat ``i`` starts at ring cell
``i * seg``.  The segment size shrinks as the player count grows so the ring
stays a playable length (48-60 cells) for every match size instead of simply
stretching the 4-player board:

    2-4 players -> 13 cells per seat   (4 players = the classic 52-cell ring)
    5-6 players ->  8 cells per seat
    7-8 players ->  7 cells per seat
    9-10 players -> 6 cells per seat

A token's *progress* ``p`` describes where it is on its own journey:

    -1                 in the yard
    0 .. L-1           on the ring (ring cell = (seat * seg + p) % L)
    L .. L+3           in the player's private home lane (4 cells)
    L+4 (== HOME)      finished

Rules (house rules chosen for a long ring and many players)
-----------------------------------------------------------
* A 6 brings a token out of the yard (``quick=True``: any roll does).
* Rolling a 6, capturing, or bringing a token home earns an extra roll.
* Three 6s in a row forfeit the turn.
* Landing on an opponent on a non-safe ring cell sends it back to the yard.
* Start cells and one star cell per segment are safe: pieces share them.
* Exact roll needed to finish.
* ``mode="first"``: the match ends when one player gets every token home.
  ``mode="ranking"``: play on until all but one player have finished.
"""
from __future__ import annotations

import random
from typing import Optional

LANE_LEN = 4
MIN_PLAYERS = 2
MAX_PLAYERS = 10
COLOR_NAMES = ["Red", "Blue", "Green", "Yellow", "Purple",
               "Orange", "Cyan", "Pink", "Brown", "Slate"]


class RuleError(Exception):
    """Raised when an action is not allowed in the current game state."""


def segment_size(n: int) -> int:
    if n <= 4:
        return 13
    if n <= 6:
        return 8
    if n <= 8:
        return 7
    return 6


def default_tokens(n: int) -> int:
    """Tokens per player; fewer for big tables so matches stay a sane length."""
    if n <= 4:
        return 4
    if n <= 6:
        return 3
    return 2


class LudoGame:
    def __init__(self, n: int, tokens: Optional[int] = None, mode: str = "first",
                 quick: bool = False, start: int = 0,
                 names: Optional[list[str]] = None,
                 rng: Optional[random.Random] = None):
        if not MIN_PLAYERS <= n <= MAX_PLAYERS:
            raise ValueError(f"players must be {MIN_PLAYERS}-{MAX_PLAYERS}")
        if mode not in ("first", "ranking"):
            raise ValueError("mode must be 'first' or 'ranking'")
        self.n = n
        self.k = tokens if tokens and 1 <= tokens <= 4 else default_tokens(n)
        self.mode = mode
        self.quick = bool(quick)
        self.rng = rng or random.SystemRandom()
        self.names = list(names) if names else [f"Player {i + 1}" for i in range(n)]

        self.seg = segment_size(n)
        self.L = self.seg * n
        self.HOME = self.L + LANE_LEN
        self.safe_offsets = (0, (self.seg * 5) // 8)

        self.tokens = [[-1] * self.k for _ in range(n)]
        self.turn = start % n
        self.phase = "roll"          # "roll" | "move" | "over"
        self.dice: Optional[int] = None
        self.roll_id = 0
        self.move_id = 0
        self.sixes_row = 0
        self.legal: list[int] = []
        self.finished: list[int] = []
        self.ranking: list[int] = []
        self.over = False
        self.last_move: Optional[dict] = None
        self.log: list[dict] = []
        self.stats = [{"rolls": 0, "sixes": 0, "captures": 0,
                       "captured": 0, "moves": 0} for _ in range(n)]

    # ------------------------------------------------------------ geometry
    def cell(self, seat: int, p: int) -> Optional[int]:
        """Ring cell index for a token with progress p (None off the ring)."""
        if 0 <= p < self.L:
            return (seat * self.seg + p) % self.L
        return None

    def is_safe(self, cell: int) -> bool:
        return (cell % self.seg) in self.safe_offsets

    # --------------------------------------------------------------- moves
    def _target(self, seat: int, token: int, roll: int) -> Optional[int]:
        p = self.tokens[seat][token]
        if p == -1:
            return 0 if (roll == 6 or self.quick) else None
        if p >= self.HOME:
            return None
        t = p + roll
        return t if t <= self.HOME else None

    def _victims(self, seat: int, target: int) -> list[tuple[int, int]]:
        if target >= self.L:
            return []
        c = self.cell(seat, target)
        if self.is_safe(c):
            return []
        out = []
        for s in range(self.n):
            if s == seat:
                continue
            for t, p in enumerate(self.tokens[s]):
                if 0 <= p < self.L and self.cell(s, p) == c:
                    out.append((s, t))
        return out

    def legal_info(self) -> list[dict]:
        """Describe each legal move so clients can label their choices."""
        seat, roll = self.turn, self.dice
        info = []
        for t in self.legal:
            to = self._target(seat, t, roll)
            info.append({
                "token": t,
                "from": self.tokens[seat][t],
                "to": to,
                "capture": len(self._victims(seat, to)),
                "home": to == self.HOME,
                "lane": self.L <= to < self.HOME,
                "enter": self.tokens[seat][t] == -1,
            })
        return info

    def forced_token(self) -> Optional[int]:
        """The token to move when every legal move is effectively the same."""
        if not self.legal:
            return None
        seat = self.turn
        if len({self.tokens[seat][t] for t in self.legal}) == 1:
            return self.legal[0]
        return None

    def _say(self, seat: int, text: str) -> None:
        self.log.append({"seat": seat, "text": text})
        if len(self.log) > 40:
            del self.log[:-40]

    # ----------------------------------------------------------- actions
    def roll(self, value: Optional[int] = None) -> int:
        if self.over or self.phase != "roll":
            raise RuleError("not time to roll")
        v = value if value else self.rng.randint(1, 6)
        seat = self.turn
        name = self.names[seat]
        st = self.stats[seat]
        self.dice = v
        self.roll_id += 1
        st["rolls"] += 1
        if v == 6:
            st["sixes"] += 1
            self.sixes_row += 1
        else:
            self.sixes_row = 0
        self.phase = "move"
        if v == 6 and self.sixes_row >= 3:
            self.legal = []
            self.sixes_row = 0
            self._say(seat, f"{name} rolled a third 6 in a row and loses the turn")
            return v
        self.legal = [t for t in range(self.k) if self._target(seat, t, v) is not None]
        if self.legal:
            self._say(seat, f"{name} rolled a {v}")
        else:
            self._say(seat, f"{name} rolled a {v} - no move")
        return v

    def pass_turn(self) -> None:
        if self.over or self.phase != "move" or self.legal:
            raise RuleError("cannot pass")
        self._advance()

    def move(self, token: int) -> dict:
        if self.over or self.phase != "move" or token not in self.legal:
            raise RuleError("illegal move")
        seat, roll = self.turn, self.dice
        name = self.names[seat]
        p = self.tokens[seat][token]
        target = self._target(seat, token, roll)
        victims = self._victims(seat, target)

        self.tokens[seat][token] = target
        for s, t in victims:
            self.tokens[s][t] = -1
            self.stats[s]["captured"] += 1
        self.stats[seat]["captures"] += len(victims)
        self.stats[seat]["moves"] += 1
        self.move_id += 1
        self.last_move = {"id": self.move_id, "seat": seat, "token": token,
                          "from": p, "to": target, "roll": roll,
                          "captured": [[s, t] for s, t in victims]}

        if victims:
            who = ", ".join(sorted({self.names[s] for s, _ in victims}))
            self._say(seat, f"{name} captured a token of {who}!")
        elif p == -1:
            self._say(seat, f"{name} brought a token onto the board")
        elif target == self.HOME:
            self._say(seat, f"{name} got a token home")

        self.legal = []
        done = all(x == self.HOME for x in self.tokens[seat])
        if done:
            self.finished.append(seat)
            self._say(seat, f"{name} has all tokens home - finished #{len(self.finished)}")
            self._check_over()
        if self.over:
            self.phase = "over"
            return self.last_move
        extra = roll == 6 or bool(victims) or target == self.HOME
        if extra and not done:
            self.phase = "roll"
        else:
            self._advance()
        return self.last_move

    def _advance(self) -> None:
        self.sixes_row = 0
        self.legal = []
        for i in range(1, self.n + 1):
            s = (self.turn + i) % self.n
            if s not in self.finished:
                self.turn = s
                break
        self.phase = "roll"

    def _progress(self, seat: int) -> int:
        return sum(max(p, 0) for p in self.tokens[seat])

    def _check_over(self) -> None:
        if self.mode == "first":
            self.over = bool(self.finished)
        else:
            self.over = self.n - len(self.finished) <= 1
        if self.over:
            rest = [s for s in range(self.n) if s not in self.finished]
            rest.sort(key=lambda s: -self._progress(s))
            self.ranking = list(self.finished) + rest
            self.phase = "over"

    # ------------------------------------------------------------- bots
    def _threat(self, seat: int, c: int) -> int:
        """Opponent tokens 1-6 cells behind ring cell c (could hit us there)."""
        hits = 0
        for d in range(1, 7):
            behind = (c - d) % self.L
            for s in range(self.n):
                if s == seat:
                    continue
                for p in self.tokens[s]:
                    if 0 <= p < self.L and self.cell(s, p) == behind:
                        hits += 1
        return hits

    def choose_token(self) -> int:
        """Simple heuristic used by bots and by the AFK auto-player."""
        seat = self.turn
        best, best_score = self.legal[0], float("-inf")
        for t in self.legal:
            p = self.tokens[seat][t]
            target = self._target(seat, t, self.dice)
            score = 0.0
            if target == self.HOME:
                score += 90
            elif target >= self.L:
                score += 45
            else:
                c = self.cell(seat, target)
                if self.is_safe(c):
                    score += 25
                else:
                    score += 100 * len(self._victims(seat, target))
                    score -= 18 * self._threat(seat, c)
            if p == -1:
                score += 40
            elif 0 <= p < self.L:
                c0 = self.cell(seat, p)
                if not self.is_safe(c0) and self._threat(seat, c0):
                    score += 20
            score += target * 0.2 + self.rng.random() * 0.5
            if score > best_score:
                best, best_score = t, score
        return best

    # --------------------------------------------------------- snapshot
    def snapshot(self) -> dict:
        return {
            "n": self.n, "k": self.k, "seg": self.seg, "L": self.L,
            "home": self.HOME, "lane": LANE_LEN,
            "safe": list(self.safe_offsets),
            "mode": self.mode, "quick": self.quick,
            "turn": self.turn, "phase": self.phase,
            "dice": self.dice, "roll_id": self.roll_id,
            "legal": list(self.legal), "moves": self.legal_info() if self.phase == "move" else [],
            "last_move": self.last_move,
            "log": self.log[-12:],
            "over": self.over,
        }
