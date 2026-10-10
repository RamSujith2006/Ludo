/* Test-only stand-in for the socket.io client (the real one can't be downloaded in this sandbox).
   Same surface the app uses: io() -> {on, emit}. Long-polls /fio/poll. */
window.io = function () {
  const handlers = {}; let sid = null;
  const sock = {
    on(e, f) { handlers[e] = f; return sock; },
    emit(e, d) { if (!sid) return; fetch('/fio/emit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, event: e, data: d === undefined ? null : d }) }); },
  };
  (async () => {
    const r = await fetch('/fio/connect', { method: 'POST' });
    sid = (await r.json()).sid;
    handlers.connect && handlers.connect();
    for (;;) {
      try {
        const m = await (await fetch('/fio/poll?sid=' + sid)).json();
        for (const [ev, pl] of m) handlers[ev] && handlers[ev](pl);
      } catch (e) { await new Promise((r) => setTimeout(r, 300)); }
    }
  })();
  addEventListener('pagehide', () => navigator.sendBeacon('/fio/disconnect?sid=' + sid));
  return sock;
};
