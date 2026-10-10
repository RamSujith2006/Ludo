import sys, time, os
from playwright.sync_api import sync_playwright
BASE = "http://localhost:5055"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp"
errors = []

def watch(page, tag):
    page.on("pageerror", lambda e: errors.append(f"{tag} pageerror: {e}"))
    page.on("console", lambda m: errors.append(f"{tag} console.{m.type}: {m.text}") if m.type in ("error",) else None)

def create(page, name, count, tokens="0", quick="0", mode="first"):
    page.goto(BASE); page.fill("#name", name)
    page.click(f"#count-chips .chip[data-n='{count}']")
    page.select_option("#opt-tokens", tokens); page.select_option("#opt-quick", quick); page.select_option("#opt-mode", mode)
    page.click("#btn-create"); page.wait_for_selector("#screen-lobby.active")
    return page.inner_text("#lobby-code")

def drive(page):
    """Act for the human if it's their turn."""
    if page.locator("#btn-roll").is_enabled():
        page.click("#btn-roll"); return True
    ch = page.locator("#choices .choice")
    if ch.count():
        ch.first.click(); return True
    return False

with sync_playwright() as p:
    b = p.chromium.launch(args=["--no-sandbox"])
    # ---------- full match: 2 humans + 2 bots, quick rules, 1 token each
    c1 = b.new_context(viewport={"width": 1280, "height": 860}); A = c1.new_page(); watch(A, "A")
    c2 = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True); B = c2.new_page(); watch(B, "B")
    code = create(A, "Asha", 4, tokens="1", quick="1")
    assert len(code) == 5, code
    B.goto(f"{BASE}/?room={code}")
    assert B.input_value("#join-code") == code
    B.fill("#name", "Ravi"); B.click("#btn-join"); B.wait_for_selector("#screen-lobby.active")
    A.click("#btn-bot"); A.click("#btn-bot")
    A.wait_for_function("document.querySelectorAll('#seats .seat:not(.empty)').length === 4")
    A.screenshot(path=f"{OUT}/01_lobby_desktop.png")
    B.screenshot(path=f"{OUT}/02_lobby_mobile.png")
    assert A.is_enabled("#btn-start") and B.is_hidden("#btn-start")
    A.click("#btn-start")
    A.wait_for_selector("#ov-start:not([hidden])"); B.wait_for_selector("#ov-start:not([hidden])")
    A.screenshot(path=f"{OUT}/03_pregame_ad_desktop.png")
    assert A.locator("#ad-start .ad-placeholder").count() == 1       # pre-game ad slot present
    A.wait_for_selector("#ov-start", state="hidden", timeout=10000)
    assert B.locator("#ad-banner .ad-placeholder").count() == 1      # banner outside the board
    shots = 0; t0 = time.time()
    while time.time() - t0 < 170:
        if A.is_visible("#ov-result") and B.is_visible("#ov-result"): break
        acted = drive(A) | drive(B)
        if acted and shots < 2 and time.time() - t0 > 12 * (shots + 1):
            A.screenshot(path=f"{OUT}/04_game_desktop_{shots}.png"); B.screenshot(path=f"{OUT}/05_game_mobile_{shots}.png"); shots += 1
        time.sleep(0.15)
    else:
        raise SystemExit("match did not finish in time")
    time.sleep(0.5)
    A.screenshot(path=f"{OUT}/06_results_desktop.png"); B.screenshot(path=f"{OUT}/07_results_mobile.png")
    assert A.locator("#ad-result .ad-placeholder").count() == 1       # post-game ad slot present
    rows = A.locator("#res-body tr").count(); assert rows == 4, rows
    title = A.inner_text("#res-title"); print("result:", title)
    assert A.is_visible("#btn-again") and B.is_hidden("#btn-again")
    A.click("#btn-again"); A.wait_for_selector("#screen-lobby.active"); B.wait_for_selector("#screen-lobby.active")
    # reload mid-lobby: rejoin keeps the seat
    B.reload(); B.wait_for_selector("#screen-lobby.active"); assert B.locator("#seats .seat:not(.empty)").count() == 4
    c1.close(); c2.close()

    # ---------- board shapes for 2 and 10 players
    for n in (2, 10):
        c = b.new_context(viewport={"width": 1100, "height": 900}); P = c.new_page(); watch(P, f"P{n}")
        create(P, "Host", n, quick="1")
        for _ in range(n - 1): P.click("#btn-bot")
        P.wait_for_function(f"document.querySelectorAll('#seats .seat:not(.empty)').length === {n}")
        P.click("#btn-start"); P.wait_for_selector("#ov-start", state="hidden", timeout=10000)
        t0 = time.time()
        while time.time() - t0 < 25: drive(P); time.sleep(0.2)
        P.screenshot(path=f"{OUT}/08_board_{n}p.png")
        assert P.locator("#board .token").count() == n * (4 if n <= 4 else 2)
        c.close()
    b.close()

print("ERRORS:", errors if errors else "none")
sys.exit(1 if errors else 0)
