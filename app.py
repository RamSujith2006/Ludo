"""Ludo Party - Flask + Flask-SocketIO web server.

Run locally:      python app.py
Run in production: gunicorn --worker-class gthread --threads 100 --workers 1 app:app

Game state lives in memory, so run exactly ONE worker process (see README for
how to scale out with a message queue + shared store).
"""
import os
import re

from flask import Flask, Response, abort, jsonify, render_template, request
from flask_socketio import SocketIO

from rooms import Hub, Settings

app = Flask(__name__)
app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev-only-change-me")

origins = [o.strip() for o in os.getenv("LUDO_ALLOWED_ORIGINS", "").split(",") if o.strip()]
socketio = SocketIO(app, async_mode="threading",
                    cors_allowed_origins=origins or None,
                    ping_interval=20, ping_timeout=30)


# ----------------------------------------------------------------- ads
def _slot(name: str) -> str:
    v = os.getenv(name, "").strip()
    return v if re.fullmatch(r"\d{6,20}", v) else ""


_client = os.getenv("ADSENSE_CLIENT", "").strip()
ADS = {
    # Publisher id looks like ca-pub-1234567890123456
    "client": _client if re.fullmatch(r"ca-pub-\d{10,20}", _client) else "",
    "slots": {
        "pregame": _slot("ADSENSE_SLOT_PREGAME"),     # lobby / match-starting screen
        "postgame": _slot("ADSENSE_SLOT_POSTGAME"),   # results screen
        "banner": _slot("ADSENSE_SLOT_BANNER"),       # optional banner beside the board
    },
    # Show a labelled empty box where ads will go while no network is configured.
    "placeholders": os.getenv("LUDO_AD_PLACEHOLDERS", "1") != "0",
}


# -------------------------------------------------------------- sockets
class SocketTransport:
    def __init__(self, sio):
        self.sio = sio

    def emit(self, event, payload, room=None, sid=None):
        self.sio.emit(event, payload, to=room or sid)

    def join(self, sid, code):
        self.sio.server.enter_room(sid, code, namespace="/")

    def leave(self, sid, code):
        self.sio.server.leave_room(sid, code, namespace="/")


hub = Hub(SocketTransport(socketio), Settings.from_env())


@socketio.on("create")
def _create(data=None):
    hub.create(request.sid, data or {})


@socketio.on("join")
def _join(data=None):
    hub.join(request.sid, data or {})


@socketio.on("rejoin")
def _rejoin(data=None):
    hub.rejoin(request.sid, data or {})


@socketio.on("config")
def _config(data=None):
    hub.configure(request.sid, data or {})


@socketio.on("add_bot")
def _add_bot(data=None):
    hub.add_bot(request.sid)


@socketio.on("kick")
def _kick(data=None):
    hub.kick(request.sid, str((data or {}).get("uid", "")))


@socketio.on("start")
def _start(data=None):
    hub.start(request.sid)


@socketio.on("roll")
def _roll(data=None):
    hub.roll(request.sid)


@socketio.on("move")
def _move(data=None):
    hub.move(request.sid, (data or {}).get("token"))


@socketio.on("again")
def _again(data=None):
    hub.again(request.sid)


@socketio.on("leave")
def _leave(data=None):
    hub.leave(request.sid)


@socketio.on("disconnect")
def _disconnect(*_args):
    hub.disconnect(request.sid)


def _scheduler():
    """Drives bots, turn timers, the pre-game countdown and room cleanup."""
    while True:
        socketio.sleep(0.25)
        try:
            hub.tick_all()
        except Exception:                      # never let the loop die
            app.logger.exception("scheduler tick failed")


socketio.start_background_task(_scheduler)


# --------------------------------------------------------------- routes
@app.route("/")
def index():
    return render_template("index.html", ads=ADS)


@app.route("/privacy")
def privacy():
    return render_template("privacy.html", ads=ADS)


@app.route("/ads.txt")
def ads_txt():
    """Served automatically once ADSENSE_CLIENT is set (required by AdSense)."""
    if not ADS["client"]:
        abort(404)
    pub = ADS["client"].replace("ca-", "", 1)
    return Response(f"google.com, {pub}, DIRECT, f08c47fec0942fa0\n", mimetype="text/plain")


@app.route("/healthz")
def healthz():
    return jsonify(status="ok", **hub.health())


@app.after_request
def _headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


if __name__ == "__main__":
    socketio.run(app, host=os.getenv("HOST", "0.0.0.0"),
                 port=int(os.getenv("PORT", "5000")),
                 allow_unsafe_werkzeug=True, use_reloader=False)
