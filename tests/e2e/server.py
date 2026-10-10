"""Test server: real Flask templates + real rooms.Hub, fake long-poll transport."""
import os, sys, threading, time, uuid, queue, random
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
from flask import Flask, request, jsonify, render_template, send_from_directory
from rooms import Hub, Settings

app = Flask(__name__, static_folder=None, template_folder=os.path.join(ROOT, "templates"))
HERE = os.path.dirname(os.path.abspath(__file__))
queues, members = {}, {}

class T:
    def emit(self, event, payload, room=None, sid=None):
        for s in (list(members.get(room, ())) if room else [sid]):
            if s in queues: queues[s].put((event, payload))
    def join(self, sid, code): members.setdefault(code, set()).add(sid)
    def leave(self, sid, code): members.get(code, set()).discard(sid)

hub = Hub(T(), Settings(pregame_seconds=2.5, bot_delay=0.25, nomove_delay=0.35, turn_seconds=60), rng=random.Random(5))
ADS = {"client": "", "slots": {"pregame": "", "postgame": "", "banner": ""}, "placeholders": True}

@app.route("/")
def index(): return render_template("index.html", ads=ADS)
@app.route("/static/<path:filename>", endpoint="static")
def static_files(filename):
    if filename == "vendor/socket.io.min.js": return send_from_directory(HERE, "fake_io.js")
    return send_from_directory(os.path.join(ROOT, "static"), filename)

@app.post("/fio/connect")
def connect():
    sid = uuid.uuid4().hex; queues[sid] = queue.Queue(); return jsonify(sid=sid)
@app.get("/fio/poll")
def poll():
    q = queues.get(request.args["sid"]); out = []
    if q is None: return jsonify([])
    try:
        out.append(q.get(timeout=10))
        while True: out.append(q.get_nowait())
    except queue.Empty: pass
    return jsonify(out)
@app.post("/fio/disconnect")
def disc():
    hub.disconnect(request.args["sid"]); return ""
@app.post("/fio/emit")
def emit_():
    d = request.get_json(); sid, ev, data = d["sid"], d["event"], d["data"] or {}
    fn = {"create": hub.create, "join": hub.join, "rejoin": hub.rejoin, "config": hub.configure}.get(ev)
    if fn: fn(sid, data)
    elif ev == "add_bot": hub.add_bot(sid)
    elif ev == "kick": hub.kick(sid, str(data.get("uid", "")))
    elif ev == "start": hub.start(sid)
    elif ev == "roll": hub.roll(sid)
    elif ev == "move": hub.move(sid, data.get("token"))
    elif ev == "again": hub.again(sid)
    elif ev == "leave": hub.leave(sid)
    return ""

def loop():
    while True:
        time.sleep(0.1); hub.tick_all()
threading.Thread(target=loop, daemon=True).start()

if __name__ == "__main__":
    app.run(port=int(os.getenv("PORT", "5055")), threaded=True)
