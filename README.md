# Ludo Party — online multiplayer Ludo for 2–10 players

Python (Flask + Flask-SocketIO) backend, plain HTML/CSS/JS front end, ad slots before and after every match.

## Run it

```bash
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py                                        # http://localhost:5000
```

Open the site in two browser windows to try it, or add bots from the lobby to play alone.

Production: `gunicorn --worker-class gthread --threads 100 --workers 1 app:app` (see `Procfile`).
**Use exactly one worker** — rooms live in that process's memory. Scaling past one process means moving room state to Redis and using a Socket.IO message queue (not included).

## How it plays

| Step | What happens |
|---|---|
| Home | Pick 2–10 players and options, **Create room** (5-letter code) or **Join** with a code / invite link |
| Lobby | Host adds bots, kicks players, changes rules, starts when ≥ 2 are seated |
| Pre-game | "Match starting" screen with a short countdown and an **ad slot** |
| Match | Server rolls dice, validates every move, runs turns; tap a glowing token or use the buttons |
| Results | Winner, ranking, stats, an **ad slot**, then *Play again* (back to the same lobby) |

Rules (tuned so big tables stay playable) are documented at the top of `game.py`: the ring is ~48–60 cells at every size (13 cells/seat for 2–4 players, down to 6 for 9–10), with a private 4-cell home lane per colour; 6 to leave the yard (or "Quick": any roll); 6 / capture / getting home = extra roll; three 6s lose the turn; stars and start cells are safe; exact roll to finish. Tokens per player default to 4 / 3 / 2 for ≤4 / ≤6 / ≥7 players. Match ends when one player finishes, or after a full ranking.

Robustness: server-authoritative state; refresh/reconnect keeps your seat; idle players are auto-played, then replaced by a bot until they return; empty or abandoned rooms are cleaned up.

## Layout

```
app.py          Flask routes + Socket.IO wiring + ad config (thin)
rooms.py        Rooms, lobby, timers, bots, reconnects  (no web dependencies)
game.py         Rules engine                              (no web dependencies)
templates/      index.html, privacy.html
static/         app.js (client), board.js (board geometry), style.css
tests/          engine + hub unit tests, route tests, tests/e2e browser test
```

## Advertising

Set the env vars in `.env.example`. With nothing set, labelled placeholder boxes show where ads go. Slots: `pregame` (match-starting screen), `postgame` (results), `banner` (lobby + beside the board, never over the board). `/ads.txt` is generated automatically from `ADSENSE_CLIENT`, and `/privacy` is a template policy page (review it and add contact details).

Things to know before relying on it:
- **Revenue isn't guaranteed**, and AdSense needs site approval first.
- AdSense restricts ads on screens with little publisher content (loading/transition screens). The pre-game and results screens include real content (players, rules, tips, results table) for that reason, but check current policy. For true game interstitials look at Google's **H5 Games Ads** (separate approval); only `mountAd()` in `static/app.js` would need changing.
- Never encourage clicks, and keep ads away from buttons (the layout keeps them apart). Invalid traffic can get an account banned.
- Depending on your audience's region you may need a consent banner (e.g. Google's consent management) — add one before launch.

## Tests

```bash
python -m unittest discover -s tests -p "test_*.py"     # engine, hub, routes
python tests/e2e/server.py &  python tests/e2e/run.py /tmp   # real-browser run (needs playwright + chromium)
```
The e2e harness swaps the Socket.IO client for a tiny long-poll stand-in so it can run offline; production uses the real `socket.io-client` (`static/vendor/socket.io.min.js` if you add it, otherwise loaded from jsDelivr automatically).

## Ideas for next

Accounts / Google login, match history (SQLite/Postgres), public matchmaking, chat, sound, themes, translations, Redis-backed rooms for multiple workers.
