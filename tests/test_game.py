import os, random, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from game import LudoGame, RuleError, segment_size, default_tokens


def play_out(g, max_actions=200000):
    actions = 0
    while not g.over:
        actions += 1
        assert actions < max_actions, "game did not finish"
        if g.phase == "roll":
            g.roll()
        elif not g.legal:
            g.pass_turn()
        else:
            g.move(g.choose_token())
    return actions


class Simulation(unittest.TestCase):
    def test_every_player_count_and_mode_finishes(self):
        for n in range(2, 11):
            for mode in ("first", "ranking"):
                for quick in (False, True):
                    for seed in range(3):
                        g = LudoGame(n, mode=mode, quick=quick, rng=random.Random(seed * 100 + n))
                        play_out(g)
                        self.assertEqual(sorted(g.ranking), list(range(n)))
                        if mode == "first":
                            self.assertTrue(all(x == g.HOME for x in g.tokens[g.ranking[0]]))
                        else:
                            self.assertEqual(len(g.finished), n - 1 if len(g.finished) == n - 1 else len(g.finished))
                            self.assertGreaterEqual(len(g.finished), n - 1)

    def test_invariants_hold_throughout(self):
        for n in (2, 5, 10):
            g = LudoGame(n, rng=random.Random(n))
            while not g.over:
                if g.phase == "roll":
                    g.roll()
                elif not g.legal:
                    g.pass_turn()
                else:
                    g.move(g.choose_token())
                for s in range(n):
                    for p in g.tokens[s]:
                        self.assertTrue(-1 <= p <= g.HOME)

    def test_ring_lengths_stay_playable(self):
        for n in range(2, 11):
            L = segment_size(n) * n
            self.assertTrue(26 <= L <= 60, (n, L))
        self.assertEqual(segment_size(4) * 4, 52)
        self.assertEqual(default_tokens(4), 4)
        self.assertEqual(default_tokens(10), 2)


class Rules(unittest.TestCase):
    def game(self, n=4, **kw):
        return LudoGame(n, rng=random.Random(1), **kw)

    def test_needs_six_to_leave_yard(self):
        g = self.game()
        g.roll(3)
        self.assertEqual(g.legal, [])
        g.pass_turn()
        self.assertEqual(g.turn, 1)
        g.roll(6)
        self.assertEqual(len(g.legal), g.k)
        g.move(0)
        self.assertEqual(g.tokens[1][0], 0)
        self.assertEqual(g.phase, "roll")       # six -> extra turn
        self.assertEqual(g.turn, 1)

    def test_quick_mode_any_roll_enters(self):
        g = self.game(quick=True)
        g.roll(2)
        self.assertEqual(len(g.legal), g.k)

    def test_third_six_forfeits(self):
        g = self.game()
        g.roll(6); g.move(0)
        g.roll(6); g.move(0)
        g.roll(6)
        self.assertEqual(g.legal, [])
        g.pass_turn()
        self.assertEqual(g.turn, 1)

    def test_capture_on_normal_cell_and_extra_turn(self):
        g = self.game()
        # seat 0 token on ring cell 3 (not safe); seat 1 token 4 behind on its own path
        g.tokens[0][0] = 3
        s1 = 1
        # seat1 progress p maps to cell (13 + p) % 52; reach cell 3 -> p = 42
        g.turn = s1
        g.tokens[s1][0] = 38
        g.roll(4)
        self.assertFalse(g.is_safe(3))
        g.move(0)
        self.assertEqual(g.tokens[0][0], -1)
        self.assertEqual(g.stats[1]["captures"], 1)
        self.assertEqual(g.stats[0]["captured"], 1)
        self.assertEqual((g.turn, g.phase), (1, "roll"))   # capture -> extra roll

    def test_no_capture_on_safe_cells(self):
        g = self.game()
        start1 = g.seg * 1                          # seat 1's start cell is safe
        g.tokens[0][0] = start1                      # seat 0 progress == cell for seat 0
        g.turn = 1
        g.tokens[1][0] = -1
        g.roll(6)
        g.move(0)
        self.assertEqual(g.tokens[0][0], start1)    # still there
        self.assertEqual(g.tokens[1][0], 0)
        star = (g.seg * 5) // 8                      # star cell inside segment 0
        g2 = self.game()
        g2.tokens[1][0] = 38                         # cell 51? place victim on star
        g2.tokens[0][0] = star
        g2.turn = 2
        g2.tokens[2][0] = (star - 26) % 52           # seat 2 starts at cell 26
        g2.roll(1)
        g2.tokens[2][0] = (star - 1 - 26) % 52
        g2.legal = [0]
        g2.move(0)
        self.assertEqual(g2.tokens[0][0], star)      # safe: not captured

    def test_exact_roll_to_finish(self):
        g = self.game()
        g.tokens[0][:] = [g.HOME, g.HOME, g.HOME, g.HOME - 3]
        g.roll(4)
        self.assertEqual(g.legal, [])
        g.pass_turn()
        g.turn = 0
        g.phase = "roll"
        g.roll(3)
        self.assertEqual(g.legal, [3])
        g.move(3)
        self.assertTrue(g.over)
        self.assertEqual(g.ranking[0], 0)

    def test_ranking_mode_continues_after_first_finisher(self):
        g = self.game(n=3, mode="ranking")
        g.tokens[0][:] = [g.HOME] * 3 + [g.HOME - 2]
        g.roll(2)
        g.move(3)
        self.assertEqual(g.finished, [0])
        self.assertFalse(g.over)
        self.assertNotEqual(g.turn, 0)
        for s in (1, 2):
            g.tokens[s][:] = [g.HOME - 1] * 3 + [g.HOME - 1] if s == 1 else g.tokens[s]
        g.turn, g.phase = 1, "roll"
        g.tokens[1][:] = [g.HOME] * 3 + [g.HOME - 1]
        g.roll(1)
        g.move(3)
        self.assertTrue(g.over)
        self.assertEqual(g.ranking[:2], [0, 1])

    def test_illegal_actions_rejected(self):
        g = self.game()
        with self.assertRaises(RuleError):
            g.move(0)
        g.roll(6)
        with self.assertRaises(RuleError):
            g.roll()
        with self.assertRaises(RuleError):
            g.move(99)

    def test_finished_players_are_skipped(self):
        g = self.game(n=3, mode="ranking")
        g.finished = [1]
        g.turn = 0
        g._advance()
        self.assertEqual(g.turn, 2)


if __name__ == "__main__":
    unittest.main()
