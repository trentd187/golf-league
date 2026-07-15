// __tests__/utils/leaderboard.test.ts
// Tests for utils/leaderboard.ts — the code that decides WHO WINS.
//
// This math previously lived inside the component bodies of app/rounds/[id].tsx and
// app/events/[id].tsx, both excluded from the Jest coverage set. So the most consequential
// derivation in the app had ZERO tests and was invisible to the coverage ratchet. These are its
// first ever tests.

import {
  buildRoundLeaderboard,
  buildEventLeaderboard,
  formatThru,
} from "@/utils/leaderboard";
import type { Scorecard } from "@/types/scorecard";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// par4s builds N par-4 holes.
const par4s = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ hole_number: i + 1, par: 4, stroke_index: i + 1 }));

// player builds one scorecard player who scored `gross` on each of `holes` holes.
// `net` defaults to gross (scratch).
function player(
  id: string,
  name: string,
  holes: number,
  gross: number,
  net = gross,
) {
  return {
    round_player_id: `rp-${id}`,
    user_id: `u-${id}`,
    display_name: name,
    scores: Array.from({ length: holes }, (_, i) => ({
      hole_number: i + 1,
      gross_score: gross,
      net_score: net,
    })),
  };
}

// card builds a scorecard with one group holding the given players.
function card(players: ReturnType<typeof player>[], holes = 18): Scorecard {
  return {
    holes: par4s(holes),
    groups: [{ players }],
  } as unknown as Scorecard;
}

// ─── Round leaderboard ────────────────────────────────────────────────────────

describe("buildRoundLeaderboard", () => {
  it("ranks by net-to-par, lowest first", () => {
    // 18 holes of par 4 = par 72. Ann is -18, Bob is even, Cid is +18.
    const sc = card([
      player("b", "Bob", 18, 4),
      player("c", "Cid", 18, 5),
      player("a", "Ann", 18, 3),
    ]);

    const board = buildRoundLeaderboard(sc);

    expect(board.map((e) => e.display_name)).toEqual(["Ann", "Bob", "Cid"]);
    expect(board.map((e) => e.rank)).toEqual(["1", "2", "3"]);
    expect(board[0].netToPar).toBe(-18);
    expect(board[1].netToPar).toBe(0);
    expect(board[2].netToPar).toBe(18);
  });

  it("marks ties with a T prefix and resumes numbering after them (1, T2, T2, 4)", () => {
    const sc = card([
      player("a", "Ann", 18, 3), // -18
      player("b", "Bob", 18, 4), // E
      player("c", "Cid", 18, 4), // E — tied with Bob
      player("d", "Dee", 18, 5), // +18
    ]);

    const board = buildRoundLeaderboard(sc);

    expect(board.map((e) => `${e.display_name}:${e.rank}`)).toEqual([
      "Ann:1",
      "Bob:T2",
      "Cid:T2",
      "Dee:4",
    ]);
  });

  // The whole reason 0-hole players are special-cased. Without it they'd score 0 = "even par"
  // with no holes played, and a player who hasn't teed off would sit at the TOP of the board.
  it("sinks players who have not started to the bottom and ranks them '—'", () => {
    const sc = card([
      player("z", "Zed", 0, 0), // hasn't teed off
      player("a", "Ann", 18, 5), // +18, but actually playing
    ]);

    const board = buildRoundLeaderboard(sc);

    expect(board.map((e) => e.display_name)).toEqual(["Ann", "Zed"]);
    expect(board.map((e) => e.rank)).toEqual(["1", "—"]);
  });

  it("compares partial rounds against the par of holes actually played, not the full 18", () => {
    // Ann: 9 holes at 3 (par 36 → -9). Bob: 18 holes at 4 (par 72 → E).
    // Ann leads on to-par even though her raw total (27) is far lower than Bob's (72) —
    // the point is that par is accumulated per SCORED hole.
    const sc = card([player("b", "Bob", 18, 4), player("a", "Ann", 9, 3)]);

    const board = buildRoundLeaderboard(sc);

    expect(board[0].display_name).toBe("Ann");
    expect(board[0].netToPar).toBe(-9);
    expect(board[1].netToPar).toBe(0);
  });

  it("breaks a tie in favour of the player further through the round", () => {
    // Both at even par, but Bob has played more holes, so more of his score is known.
    const sc = card([player("a", "Ann", 9, 4), player("b", "Bob", 18, 4)]);

    const board = buildRoundLeaderboard(sc);

    expect(board[0].display_name).toBe("Bob");
    expect(board[0].holesPlayed).toBe(18);
  });

  it("falls back to raw net totals when the round has no hole/par data", () => {
    const sc = card([player("a", "Ann", 3, 5), player("b", "Bob", 3, 4)], 0);

    const board = buildRoundLeaderboard(sc);

    expect(board[0].display_name).toBe("Bob");
    expect(board[0].netToPar).toBeNull();
    expect(board[0].grossToPar).toBeNull();
    expect(board[0].netTotal).toBe(12);
  });

  it("ranks on NET, not gross — the whole point of a handicap round", () => {
    // Ann shoots worse gross (5s) but has strokes: net 3s. Bob is scratch at 4s.
    const sc = card([player("b", "Bob", 18, 4, 4), player("a", "Ann", 18, 5, 3)]);

    const board = buildRoundLeaderboard(sc);

    expect(board[0].display_name).toBe("Ann");
    expect(board[0].grossToPar).toBe(18); // gross: worst
    expect(board[0].netToPar).toBe(-18); // net: best
  });

  it("returns an empty board for a round with no players", () => {
    expect(buildRoundLeaderboard(card([]))).toEqual([]);
  });
});

// ─── Event leaderboard ────────────────────────────────────────────────────────

describe("buildEventLeaderboard", () => {
  it("aggregates a player's totals across every round", () => {
    const r1 = card([player("a", "Ann", 18, 4)]); // E
    const r2 = card([player("a", "Ann", 18, 3)]); // -18

    const board = buildEventLeaderboard([r1, r2]);

    expect(board).toHaveLength(1);
    expect(board[0].roundsPlayed).toBe(2);
    expect(board[0].grossTotal).toBe(72 + 54);
    expect(board[0].netToPar).toBe(-18);
  });

  it("ranks by aggregate net-to-par and marks ties", () => {
    const r1 = card([
      player("a", "Ann", 18, 3), // -18
      player("b", "Bob", 18, 5), // +18
      player("c", "Cid", 18, 5), // +18
    ]);

    const board = buildEventLeaderboard([r1]);

    expect(board.map((e) => `${e.display_name}:${e.rank}`)).toEqual([
      "Ann:1",
      "Bob:T2",
      "Cid:T2",
    ]);
  });

  // Unlike the round board, a player with no scores is ABSENT from the event standings
  // entirely, rather than sitting at the bottom.
  it("omits a player who has no scores at all", () => {
    const sc = card([player("a", "Ann", 18, 4), player("z", "Zed", 0, 0)]);

    const board = buildEventLeaderboard([sc]);

    expect(board.map((e) => e.display_name)).toEqual(["Ann"]);
  });

  // The poison rule. If ANY counted round lacks hole/par data, the aggregate to-par is
  // meaningless — summing only the rounds that DO have pars would quietly flatter whoever
  // happened to play the round with missing data.
  it("nulls the aggregate to-par when ANY counted round lacks hole data", () => {
    const withPars = card([player("a", "Ann", 18, 4)]);
    const noPars = card([player("a", "Ann", 18, 4)], 0);

    const board = buildEventLeaderboard([withPars, noPars]);

    expect(board[0].roundsPlayed).toBe(2);
    expect(board[0].grossToPar).toBeNull();
    expect(board[0].netToPar).toBeNull();
    // Raw totals still aggregate — they're always meaningful.
    expect(board[0].grossTotal).toBe(144);
  });

  it("returns an empty board when there are no scorecards", () => {
    expect(buildEventLeaderboard([])).toEqual([]);
  });
});

// ─── formatThru ───────────────────────────────────────────────────────────────

describe("formatThru", () => {
  it("shows F when finished, the hole count while playing, and — before starting", () => {
    expect(formatThru(18, 18)).toBe("F");
    expect(formatThru(19, 18)).toBe("F"); // defensive: never render "19"
    expect(formatThru(7, 18)).toBe("7");
    expect(formatThru(0, 18)).toBe("—");
  });

  it("treats a 9-hole round as finished at 9", () => {
    expect(formatThru(9, 9)).toBe("F");
    expect(formatThru(8, 9)).toBe("8");
  });
});
