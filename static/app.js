/* Ludo Party - browser client.
 * Talks to the server over Socket.IO. The server is authoritative: this file
 * only sends intents (create / join / roll / move) and renders the state it gets back.
 */
(() => {
  'use strict';

  const LB = window.LudoBoard;
  const ADS = window.LUDO_ADS || {};
  const SVGNS = 'http://www.w3.org/2000/svg';
  const $ = (sel, root = document) => root.querySelector(sel);

  // ------------------------------------------------------------ utilities
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem('ludo.' + key);
      if (val === null) localStorage.removeItem('ludo.' + key);
      else localStorage.setItem('ludo.' + key, val);
    } catch (e) { /* storage blocked: the game still works, just no auto-reconnect */ }
    return null;
  }
  function randomId() {
    const a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) el.append(kid);
    return el;
  }
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    return el;
  }
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 3200);
  }
  const swatch = (seat, label) => {
    const s = h('span', { class: 'swatch', text: label == null ? String(seat + 1) : label });
    s.style.background = LB.COLORS[seat];
    s.style.color = LB.INK[seat];
    return s;
  };

  // ---------------------------------------------------------------- state
  const S = {
    pid: store('pid') || randomId(),
    uid: null, code: store('room') || null,
    st: null, me: -1,
    count: parseInt(store('count'), 10) || 4,
    B: null, boardKey: null, tok: new Map(),
    rollSeen: null, dieBusy: false, dieTimer: null,
    startEnd: 0, turnEnd: 0,
    adStart: null, adResult: null, adBanner: null, adLobby: null,
    resultTimer: null, resultFor: null, resultDismissed: null,
    wasMyTurn: false,
  };
  store('pid', S.pid);

  // ------------------------------------------------------------------ ads
  /* Ad slots are plain containers. If AdSense is configured the slot gets an
   * <ins class="adsbygoogle">; otherwise an optional labelled placeholder.
   * To swap networks, replace the body of mountAd() only. */
  function mountAd(container, slotKey) {
    container.replaceChildren();
    const slot = ADS.slots && ADS.slots[slotKey];
    if (ADS.client && slot) {
      const ins = h('ins', { class: 'adsbygoogle', style: 'display:block' });
      ins.dataset.adClient = ADS.client;
      ins.dataset.adSlot = slot;
      ins.dataset.adFormat = 'auto';
      ins.dataset.fullWidthResponsive = 'true';
      container.append(ins);
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); }
      catch (e) { console.warn('ad failed to load', e); }
    } else if (ADS.placeholders) {
      container.append(h('div', { class: 'ad-placeholder', text: 'Ad space (' + slotKey + ')' }));
    }
  }

  // --------------------------------------------------------------- socket
  const sock = io({ transports: ['websocket', 'polling'] });
  const setConn = (on) => {
    const c = $('#conn');
    c.classList.toggle('on', on);
    $('span', c).textContent = on ? 'Online' : 'Reconnecting...';
  };
  sock.on('connect', () => {
    setConn(true);
    if (S.code) sock.emit('rejoin', { code: S.code, pid: S.pid });
  });
  sock.on('disconnect', () => setConn(false));
  sock.on('joined', (d) => { S.uid = d.uid; S.code = d.code; store('room', d.code); });
  sock.on('state', onState);
  sock.on('error_msg', (d) => toast(d.message, true));
  sock.on('rejoin_failed', () => resetToHome());
  sock.on('kicked', () => { toast('You were removed from the room', true); resetToHome(); });
  sock.on('left', () => resetToHome());

  function resetToHome() {
    S.code = null; S.uid = null; S.st = null; S.me = -1; S.boardKey = null;
    store('room', null);
    clearTimeout(S.resultTimer);
    S.resultFor = null; S.resultDismissed = null;
    S.adStart = S.adResult = S.adBanner = S.adLobby = null;
    $('#ov-start').hidden = true;
    $('#ov-result').hidden = true;
    document.title = BASE_TITLE;
    showScreen('home');
  }

  function showScreen(name) {
    for (const el of document.querySelectorAll('.screen')) el.classList.toggle('active', el.id === 'screen-' + name);
  }

  // ----------------------------------------------------------------- home
  const chips = $('#count-chips');
  for (let n = 2; n <= 10; n++) {
    chips.append(h('button', {
      class: 'chip', role: 'radio', type: 'button', 'aria-checked': String(n === S.count), 'data-n': String(n), text: String(n),
      onclick: () => {
        S.count = n; store('count', String(n));
        for (const c of chips.children) c.setAttribute('aria-checked', String(c.dataset.n === String(n)));
      },
    }));
  }
  const nameInput = $('#name');
  nameInput.value = store('name') || '';
  const codeInput = $('#join-code');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });

  function requireName() {
    const name = nameInput.value.trim();
    if (!name) { toast('Please enter your name first'); nameInput.focus(); return null; }
    store('name', name);
    return name;
  }
  $('#btn-create').addEventListener('click', () => {
    const name = requireName();
    if (!name) return;
    sock.emit('create', {
      name, pid: S.pid, max_players: S.count,
      tokens: parseInt($('#opt-tokens').value, 10), quick: $('#opt-quick').value === '1', mode: $('#opt-mode').value,
    });
  });
  $('#btn-join').addEventListener('click', () => {
    const name = requireName();
    if (!name) return;
    const code = codeInput.value.trim();
    if (code.length < 4) { toast('Enter the 5-letter room code'); codeInput.focus(); return; }
    sock.emit('join', { code, name, pid: S.pid });
  });
  const invite = new URLSearchParams(location.search).get('room');
  if (invite) {
    codeInput.value = invite.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    toast('Enter your name and press Join room');
    (nameInput.value ? $('#btn-join') : nameInput).focus();
  }

  // ---------------------------------------------------------------- lobby
  const lrMax = $('#lr-max');
  for (let n = 2; n <= 10; n++) lrMax.append(h('option', { value: String(n), text: n + ' players' }));
  const sendConfig = () => sock.emit('config', {
    max_players: parseInt(lrMax.value, 10), tokens: parseInt($('#lr-tokens').value, 10),
    quick: $('#lr-quick').value === '1', mode: $('#lr-mode').value,
  });
  for (const id of ['#lr-max', '#lr-tokens', '#lr-quick', '#lr-mode']) $(id).addEventListener('change', sendConfig);

  $('#btn-bot').addEventListener('click', () => sock.emit('add_bot'));
  $('#btn-start').addEventListener('click', () => sock.emit('start'));
  $('#btn-leave-lobby').addEventListener('click', () => sock.emit('leave'));
  $('#btn-leave-game').addEventListener('click', () => { if (confirm('Leave this match? A bot will take over your seat.')) sock.emit('leave'); });
  $('#btn-leave-result').addEventListener('click', () => sock.emit('leave'));
  $('#btn-again').addEventListener('click', () => sock.emit('again'));
  $('#btn-review').addEventListener('click', () => { S.resultDismissed = S.st && S.st.match_no; $('#ov-result').hidden = true; updatePanels(S.st); });

  async function copyText(text, okMsg) {
    try { await navigator.clipboard.writeText(text); toast(okMsg); }
    catch (e) { window.prompt('Copy this:', text); }
  }
  $('#btn-copy-code').addEventListener('click', () => copyText(S.code, 'Room code copied'));
  const inviteUrl = () => location.origin + '/?room=' + S.code;
  $('#btn-copy-link').addEventListener('click', () => copyText(inviteUrl(), 'Invite link copied'));
  if (navigator.share) {
    $('#btn-share').hidden = false;
    $('#btn-share').addEventListener('click', () => navigator.share({ title: 'Play Ludo with me', text: 'Join my Ludo room ' + S.code, url: inviteUrl() }).catch(() => {}));
  }

  function rulesText(cfg, game) {
    const tokens = game ? game.k : (cfg.tokens || 'auto');
    return [
      (game ? game.n : cfg.max_players) + (game ? ' players' : ' seats'),
      tokens + (tokens === 1 ? ' token each' : ' tokens each'),
      cfg.quick ? 'any roll leaves the yard' : 'roll a 6 to leave the yard',
      cfg.mode === 'ranking' ? 'play on until the full ranking is known' : 'ends when someone wins',
    ].join(' · ');
  }

  function renderLobby(st) {
    const isHost = st.host === S.uid;
    $('#lobby-code').textContent = st.code;
    const n = st.players.length, max = st.cfg.max_players;
    $('#seat-count').textContent = n + ' / ' + max;

    const ul = $('#seats');
    ul.replaceChildren();
    st.players.forEach((p, i) => {
      const li = h('li', { class: 'seat' }, swatch(i), h('span', { class: 'nm', text: p.name + (p.uid === S.uid ? ' (you)' : '') }));
      if (p.uid === st.host) li.append(h('span', { class: 'tag host', text: 'HOST' }));
      if (p.bot) li.append(h('span', { class: 'tag', text: 'BOT' }));
      if (!p.connected) li.append(h('span', { class: 'tag off', text: 'OFFLINE' }));
      if (isHost && p.uid !== S.uid) {
        li.append(h('button', { class: 'x', title: 'Remove', 'aria-label': 'Remove ' + p.name, onclick: () => sock.emit('kick', { uid: p.uid }), text: '✕' }));
      }
      ul.append(li);
    });
    for (let i = n; i < max; i++) ul.append(h('li', { class: 'seat empty' }, h('span', { class: 'nm', text: 'Waiting for player ' + (i + 1) + '…' })));

    $('#host-tools').hidden = !isHost;
    $('#btn-bot').disabled = n >= max;
    $('#lobby-rules-host').hidden = !isHost;
    $('#lobby-rules-text').hidden = isHost;
    if (isHost) {
      lrMax.value = String(max);
      $('#lr-tokens').value = String(st.cfg.tokens || 0);
      $('#lr-quick').value = st.cfg.quick ? '1' : '0';
      $('#lr-mode').value = st.cfg.mode;
    } else {
      $('#lobby-rules-text').textContent = rulesText(st.cfg, null);
    }
    const start = $('#btn-start');
    start.hidden = !isHost;
    start.disabled = n < 2;
    start.textContent = n < 2 ? 'Add a player or bot to start' : 'Start match (' + n + ' players)';
    $('#wait-host').hidden = isHost;
    if (S.adLobby !== 'lobby') { S.adLobby = 'lobby'; mountAd($('#ad-lobby'), 'banner'); }
  }

  // ---------------------------------------------------------------- board
  function makeToken(seat, t) {
    const B = S.B;
    const g = svgEl('g', { class: 'token' });
    g.append(
      svgEl('circle', { class: 'hit-area', r: B.tr + 9, fill: 'transparent' }),
      svgEl('circle', { class: 'body', r: B.tr, fill: LB.COLORS[seat], stroke: '#fff', 'stroke-width': 3 }),
    );
    const label = svgEl('text', {
      class: 'lbl', 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-size': (B.tr * 1.05).toFixed(1), fill: LB.INK[seat],
    });
    label.textContent = String(t + 1);
    g.append(label);
    g.addEventListener('click', () => {
      if (g.classList.contains('movable')) sock.emit('move', { token: t });
    });
    return g;
  }

  function ensureBoard(st) {
    const g = st.game;
    const key = [st.match_no, g.n, g.seg, g.k].join(':');
    if (S.boardKey === key) return;
    S.boardKey = key;
    const B = LB.layout(g.n, g.seg, g.k);
    B.safe = g.safe;
    S.B = B;
    const svg = $('#board');
    svg.innerHTML = LB.staticSvg(B, st.players);
    const layer = svgEl('g', { id: 'tokens' });
    S.tok = new Map();
    for (let s = 0; s < g.n; s++) {
      for (let t = 0; t < g.k; t++) {
        const el = makeToken(s, t);
        const p = st.players[s].tokens[t];
        S.tok.set(s + ':' + t, { el, seat: s, t, shown: p, target: p, off: [0, 0], scale: 1 });
        layer.append(el);
      }
    }
    svg.append(layer);
    renderTokens();
    S.rollSeen = null;
    S.adBanner = null;
    S.dieBusy = false;
  }

  function renderTokens() {
    const B = S.B;
    const groups = new Map();
    for (const e of S.tok.values()) {
      e.off = [0, 0]; e.scale = 1;
      const p = e.shown;
      if (p >= 0 && p < B.HOME) {
        const key = p < B.L ? 'r' + ((e.seat * B.seg + p) % B.L) : 'l' + e.seat + ':' + (p - B.L);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
      }
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const sl = LB.stackLayout(list.length, B.tr);
      list.forEach((e, i) => { e.off = sl.offsets[i]; e.scale = sl.scale; });
    }
    for (const e of S.tok.values()) {
      const q = B.tokenXY(e.seat, e.shown, e.t);
      e.el.style.transform = 'translate(' + (q.x + e.off[0]).toFixed(1) + 'px,' + (q.y + e.off[1]).toFixed(1) + 'px) scale(' + e.scale + ')';
    }
  }

  // Walk tokens one cell at a time so moves read clearly.
  function stepTokens() {
    if (!S.B) return;
    let changed = false;
    for (const e of S.tok.values()) {
      if (e.shown === e.target) continue;
      changed = true;
      if (e.shown >= 0 && e.target > e.shown && e.target - e.shown <= 8) {
        e.shown += 1;
      } else {
        if (e.target === -1 && e.shown >= 0) {
          e.el.classList.remove('hit'); void e.el.getBoundingClientRect(); e.el.classList.add('hit');
        }
        e.shown = e.target;
      }
    }
    if (changed) renderTokens();
  }
  setInterval(stepTokens, 130);

  // ----------------------------------------------------------------- dice
  const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
  const die = $('#die');
  function setDie(v) {
    const pips = die.querySelectorAll('i');
    const on = new Set(PIPS[v] || []);
    pips.forEach((p, i) => p.classList.toggle('on', on.has(i)));
  }
  function animateDie(final, done) {
    clearInterval(S.dieTimer);
    S.dieBusy = true;
    die.classList.remove('rolling'); void die.offsetWidth; die.classList.add('rolling');
    let n = 0;
    S.dieTimer = setInterval(() => {
      if (++n >= 6) {
        clearInterval(S.dieTimer);
        setDie(final);
        die.classList.remove('rolling');
        S.dieBusy = false;
        done();
      } else {
        setDie(1 + Math.floor(Math.random() * 6));
      }
    }, 70);
  }
  const doRoll = () => { if (!$('#btn-roll').disabled) sock.emit('roll'); };
  $('#btn-roll').addEventListener('click', doRoll);
  die.addEventListener('click', doRoll);
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || /^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(document.activeElement.tagName)) return;
    if (!$('#screen-game').classList.contains('active')) return;
    e.preventDefault();
    doRoll();
  });

  // ---------------------------------------------------------------- panels
  const BASE_TITLE = document.title;

  function updatePanels(st) {
    if (!st || !st.game) return;
    const g = st.game;
    const playing = st.phase === 'playing' && !g.over;
    const cur = st.players[g.turn];
    const mine = g.turn === S.me;
    const myRoll = playing && mine && g.phase === 'roll';
    const myMove = playing && mine && g.phase === 'move' && g.moves.length > 0;

    // banner
    let main = '', sub = '';
    if (st.phase === 'starting') { main = 'Get ready…'; }
    else if (st.phase === 'finished' || g.over) { main = 'Match over'; sub = 'Tap to see the results'; }
    else if (g.phase === 'roll') { main = mine ? 'Your turn — roll the dice!' : cur.name + ' is rolling…'; }
    else if (S.dieBusy) { main = (mine ? 'You are' : cur.name + ' is') + ' rolling…'; }
    else if (!g.moves.length) { main = cur.name + ' rolled a ' + g.dice; sub = 'No move available'; }
    else if (mine) {
      const forced = st.cfg.auto_single && new Set(g.moves.map((m) => m.from)).size === 1;
      main = forced ? 'Moving…' : 'Pick a token to move';
      sub = 'You rolled a ' + g.dice;
    } else { main = cur.name + ' rolled a ' + g.dice; sub = 'choosing a token…'; }
    $('#turn-main').textContent = main;
    $('#turn-sub').textContent = sub;
    $('#turn-dot').style.background = LB.COLORS[g.turn];
    const banner = $('#turn-banner');
    banner.classList.toggle('mine', playing && mine);
    banner.style.cursor = g.over ? 'pointer' : '';
    banner.onclick = g.over ? () => { S.resultDismissed = null; showResults(true); } : null;
    const timer = $('#turn-timer');
    if (st.turn_left != null && playing) {
      timer.hidden = false;
      S.turnEnd = performance.now() + st.turn_left * 1000;
    } else timer.hidden = true;

    // dice + buttons
    $('#btn-roll').disabled = !myRoll;
    die.disabled = !myRoll;

    // choices
    const choices = $('#choices');
    choices.replaceChildren();
    const seen = new Set();
    const forcedAuto = st.cfg.auto_single && new Set(g.moves.map((m) => m.from)).size === 1;
    if (myMove && !forcedAuto) {
      for (const m of g.moves) {
        if (seen.has(m.from)) continue;
        seen.add(m.from);
        const hint = m.capture ? 'Capture!' : m.home ? 'Home!' : m.lane ? 'Home lane' : m.enter ? 'Leave yard' : '+' + g.dice;
        choices.append(h('button', { class: 'choice', type: 'button', onclick: () => sock.emit('move', { token: m.token }) },
          swatch(S.me, String(m.token + 1)), h('span', { text: 'Move token ' + (m.token + 1) }), h('small', { text: hint })));
      }
    }
    choices.hidden = choices.children.length === 0;

    // tokens: movable highlight + targets
    const legal = new Set(myMove ? g.legal : []);
    for (const e of S.tok.values()) {
      const movable = e.seat === S.me && legal.has(e.t);
      e.el.classList.toggle('movable', movable);
      if (movable) e.el.parentNode.append(e.el);       // raise above its neighbours
      e.target = st.players[e.seat].tokens[e.t];
    }
    for (let s = 0; s < g.n; s++) {
      const y = document.getElementById('yard-' + s);
      if (y) y.classList.toggle('turn', playing && s === g.turn);
    }

    // players
    const ul = $('#players');
    ul.replaceChildren();
    st.players.forEach((p, i) => {
      const li = h('li', { class: 'prow' + (playing && i === g.turn ? ' turn' : '') + (p.away && !p.bot ? ' gone' : '') },
        swatch(i), h('span', { class: 'nm', text: p.name + (p.uid === S.uid ? ' (you)' : '') }));
      if (p.bot) li.append(h('span', { class: 'tag', text: 'BOT' }));
      else if (!p.connected) li.append(h('span', { class: 'tag off', text: 'OFFLINE' }));
      else if (p.away) li.append(h('span', { class: 'tag off', text: 'AWAY' }));
      const medal = p.rank === 1 ? '🥇 ' : p.rank === 2 ? '🥈 ' : p.rank === 3 ? '🥉 ' : '';
      li.append(h('span', { class: 'sc', text: medal + p.home + '/' + g.k + ' home' }));
      ul.append(li);
    });

    // log
    const log = $('#log');
    log.replaceChildren();
    for (const e of g.log.slice().reverse().slice(0, 7)) {
      const dot = h('i');
      dot.style.background = LB.COLORS[e.seat];
      log.append(h('li', {}, dot, h('span', { text: e.text })));
    }

    // attention cue when it becomes your turn in a background tab
    const nowMine = myRoll || myMove;
    if (nowMine && !S.wasMyTurn) {
      if (document.hidden) document.title = '🎲 Your turn! – Ludo Party';
      if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* ignore */ } }
    }
    S.wasMyTurn = nowMine;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) document.title = BASE_TITLE; });

  setInterval(() => {
    const timer = $('#turn-timer');
    if (timer.hidden) return;
    const left = Math.max(0, Math.ceil((S.turnEnd - performance.now()) / 1000));
    timer.textContent = left + 's';
    timer.classList.toggle('low', left <= 8);
  }, 250);

  // -------------------------------------------------------------- overlays
  function renderStartOverlay(st) {
    const ov = $('#ov-start');
    const wasHidden = ov.hidden;
    ov.hidden = false;
    S.startEnd = performance.now() + st.starts_in * 1000;
    $('#countdown').textContent = String(Math.ceil(st.starts_in));
    const row = $('#ov-start-players');
    row.replaceChildren();
    st.players.forEach((p, i) => row.append(h('span', { class: 'seat' }, swatch(i), h('span', { class: 'nm', text: p.name }))));
    $('#ov-start-rules').textContent = rulesText(st.cfg, st.game);
    if (S.adStart !== st.match_no) { S.adStart = st.match_no; mountAd($('#ad-start'), 'pregame'); }
    if (wasHidden) $('#ov-start').scrollTop = 0;
  }
  setInterval(() => {
    if ($('#ov-start').hidden) return;
    $('#countdown').textContent = String(Math.max(0, Math.ceil((S.startEnd - performance.now()) / 1000)));
  }, 200);

  function showResults(force) {
    const st = S.st;
    if (!st || st.phase !== 'finished' || !st.result) return;
    const ov = $('#ov-result');
    const first = st.result[0];
    const iWon = first.uid === S.uid;
    $('#res-title').textContent = iWon ? 'You win!' : first.name + ' wins!';
    $('#res-sub').textContent = rulesText(st.cfg, st.game);
    const body = $('#res-body');
    body.replaceChildren();
    for (const r of st.result) {
      const tr = h('tr', { class: r.rank === 1 ? 'win' : '' },
        h('td', { text: String(r.rank) }),
        h('td', {}, h('span', { class: 'who' }, swatch(r.color), h('span', { text: r.name + (r.uid === S.uid ? ' (you)' : '') }))),
        h('td', { text: r.home + '/' + st.game.k }),
        h('td', { text: String(r.stats.captures) }),
        h('td', { text: String(r.stats.sixes) }),
        h('td', { text: String(r.stats.rolls) }));
      body.append(tr);
    }
    const isHost = st.host === S.uid;
    $('#btn-again').hidden = !isHost;
    $('#wait-again').hidden = isHost;
    ov.hidden = false;
    if (S.adResult !== st.match_no) { S.adResult = st.match_no; mountAd($('#ad-result'), 'postgame'); }
    if (force) ov.scrollTop = 0;
  }

  function handleOverlays(st) {
    $('#ov-start').hidden = st.phase !== 'starting';
    if (st.phase === 'starting') renderStartOverlay(st);

    if (st.phase === 'finished') {
      if (S.resultDismissed === st.match_no) return;
      if (S.resultFor === st.match_no) { if (!$('#ov-result').hidden) showResults(false); return; }
      S.resultFor = st.match_no;
      clearTimeout(S.resultTimer);
      // let the final move play out before covering the board
      S.resultTimer = setTimeout(() => showResults(true), S.firstState ? 0 : 1800);
    } else {
      clearTimeout(S.resultTimer);
      $('#ov-result').hidden = true;
      S.resultFor = null; S.resultDismissed = null;
      S.adResult = null;
    }
  }

  // -------------------------------------------------------------- dispatch
  function renderGame(st) {
    showScreen('game');
    ensureBoard(st);
    const g = st.game;
    if (S.rollSeen !== g.roll_id) {
      const first = S.rollSeen === null;
      S.rollSeen = g.roll_id;
      if (!first && g.dice) animateDie(g.dice, () => updatePanels(S.st));
      else if (g.dice) setDie(g.dice);
    }
    updatePanels(st);
    if (st.phase !== 'starting' && S.adBanner !== st.match_no) {   // banner sits beside the board, never over it
      S.adBanner = st.match_no;
      mountAd($('#ad-banner'), 'banner');
    }
    handleOverlays(st);
  }

  function onState(st) {
    S.firstState = S.st === null;
    S.st = st;
    S.me = st.players.findIndex((p) => p.uid === S.uid);
    if (S.me < 0) { if (S.uid) resetToHome(); return; }
    if (st.phase === 'lobby') {
      $('#ov-start').hidden = true;
      $('#ov-result').hidden = true;
      S.boardKey = null; S.adBanner = null; S.wasMyTurn = false;
      showScreen('lobby');
      renderLobby(st);
    } else {
      S.adLobby = null;
      renderGame(st);
    }
  }

  setConn(false);
})();
