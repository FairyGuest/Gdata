import type { Fixture } from "./ledger.ts";

/**
 * Deterministic synthetic fixture, generated from a fixed seed.
 * One session "S1" with seats A-1..A-3, per-user limit 2, and three users.
 */
export function fixedFixture(): Fixture {
  const seats = ["A-1", "A-2", "A-3"].map((seatCode) => ({
    seatCode,
    price: 100,
  }));
  return {
    sessions: [
      {
        sessionId: "S1",
        name: "Deterministic Opening Night",
        limit: 2,
        seats,
      },
    ],
    users: [
      { userId: "alice", balance: 1000 },
      { userId: "bob", balance: 1000 },
      { userId: "carol", balance: 50 },
    ],
  };
}
