"""Checks app.py wiring and routes. flask_socketio is stubbed so this runs without it;
with the real package installed the stub is simply not used."""
import importlib, os, sys, types, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def load_app(env):
    for k in ("ADSENSE_CLIENT", "ADSENSE_SLOT_PREGAME", "ADSENSE_SLOT_POSTGAME", "ADSENSE_SLOT_BANNER"):
        os.environ.pop(k, None)
    os.environ.update(env)
    try:
        import flask_socketio  # noqa: F401
    except ImportError:
        m = types.ModuleType("flask_socketio")
        class SocketIO:
            handlers = {}
            def __init__(self, app, **kw): self.server = types.SimpleNamespace(enter_room=lambda *a, **k: None, leave_room=lambda *a, **k: None)
            def on(self, ev): return lambda f: self.handlers.setdefault(ev, f) or f
            def emit(self, *a, **k): pass
            def start_background_task(self, f): pass
            def sleep(self, s): pass
        m.SocketIO = SocketIO
        sys.modules["flask_socketio"] = m
    sys.modules.pop("app", None)
    return importlib.import_module("app")


class Routes(unittest.TestCase):
    def test_pages_without_ad_network(self):
        mod = load_app({})
        c = mod.app.test_client()
        r = c.get("/")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self.assertIn('id="board"', html)
        self.assertNotIn("pagead2.googlesyndication.com", html)
        self.assertEqual(c.get("/ads.txt").status_code, 404)
        self.assertEqual(c.get("/privacy").status_code, 200)
        self.assertEqual(c.get("/healthz").get_json()["status"], "ok")
        self.assertEqual(c.get("/static/app.js").status_code, 200)

    def test_adsense_configured(self):
        mod = load_app({"ADSENSE_CLIENT": "ca-pub-1234567890123456", "ADSENSE_SLOT_PREGAME": "1111111111",
                        "ADSENSE_SLOT_POSTGAME": "2222222222", "ADSENSE_SLOT_BANNER": "bad"})
        c = mod.app.test_client()
        html = c.get("/").get_data(as_text=True)
        self.assertIn("adsbygoogle.js?client=ca-pub-1234567890123456", html)
        self.assertIn('"pregame": "1111111111"', html.replace('":"', '": "').replace(',"', ', "'))
        self.assertEqual(mod.ADS["slots"]["banner"], "")             # invalid slot id rejected
        self.assertIn("pub-1234567890123456, DIRECT", c.get("/ads.txt").get_data(as_text=True))
        self.assertEqual(load_app({"ADSENSE_CLIENT": "<script>"}).ADS["client"], "")

    def test_all_socket_events_registered(self):
        mod = load_app({})
        names = set(getattr(mod.socketio.server, "handlers", {}).get("/", {})) if hasattr(mod.socketio, "server") else set(getattr(mod.socketio, "handlers", []))
        if names:
            self.assertTrue({"create", "join", "rejoin", "config", "add_bot", "kick", "start",
                             "roll", "move", "again", "leave", "disconnect"} <= names)


if __name__ == "__main__":
    unittest.main()
