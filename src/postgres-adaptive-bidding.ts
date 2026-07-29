import { Pool } from "pg";

import type {
  AdaptiveBidPersistence,
  AdaptiveBidPolicy,
  AdaptiveBidState,
} from "./adaptive-bidding.js";

const BID_SCOPE = "standing_order";

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function clampBid(
  value: bigint,
  policy: AdaptiveBidPolicy,
): bigint {
  return minimum(
    policy.maximumBidBps,
    maximum(policy.minimumBidBps, value),
  );
}

interface BidStateRow {
  readonly target_address: string;
  readonly current_bid_bps: number;
  readonly consecutive_full_wins: number;
  readonly consecutive_contradicting_wins: number;
  readonly last_observed_winning_bid_bps: number | null;
  readonly last_observed_winning_block: string | null;
  readonly lowest_winning_bid_bps: number | null;
  readonly highest_losing_bid_bps: number | null;
  readonly highest_losing_bid_block: string | null;
  readonly active_probe_bid_bps: number | null;
  readonly last_updated_block: string | null;
}

export class PostgresAdaptiveBidPersistence
  implements AdaptiveBidPersistence
{
  readonly #pool: Pool;
  #closePromise: Promise<void> | undefined;

  constructor(connectionString: string) {
    this.#pool = new Pool({
      connectionString,
      application_name: "pull-pool-keeper:adaptive-bids",
      max: 1,
      allowExitOnIdle: true,
      connectionTimeoutMillis: 1_000,
      idleTimeoutMillis: 10_000,
      query_timeout: 3_000,
      statement_timeout: 2_000,
    });
  }

  async load(
    policy: AdaptiveBidPolicy,
  ): Promise<Map<string, AdaptiveBidState>> {
    const result = await this.#pool.query<BidStateRow>(
      `
        SELECT
          target_address,
          current_bid_bps,
          consecutive_full_wins,
          consecutive_contradicting_wins,
          last_observed_winning_bid_bps,
          last_observed_winning_block,
          lowest_winning_bid_bps,
          highest_losing_bid_bps,
          highest_losing_bid_block,
          active_probe_bid_bps,
          last_updated_block
        FROM adaptive_bid_state
        WHERE scope = $1
      `,
      [BID_SCOPE],
    );
    return new Map(
      result.rows.map((row) => [
        row.target_address.toLowerCase(),
        {
          currentBidBps: clampBid(
            BigInt(row.current_bid_bps),
            policy,
          ),
          consecutiveFullWins: row.consecutive_full_wins,
          ...(row.consecutive_contradicting_wins <= 0
            ? {}
            : {
                consecutiveContradictingWins:
                  row.consecutive_contradicting_wins,
              }),
          ...(row.last_observed_winning_bid_bps === null
            ? {}
            : {
                lastObservedWinningBidBps: BigInt(
                  row.last_observed_winning_bid_bps,
                ),
                lastObservedWinningBlock: BigInt(
                  row.last_observed_winning_block ??
                    row.last_updated_block ??
                    "0",
                ),
              }),
          ...(row.lowest_winning_bid_bps === null
            ? {}
            : {
                lowestWinningBidBps: clampBid(
                  BigInt(row.lowest_winning_bid_bps),
                  policy,
                ),
              }),
          ...(row.highest_losing_bid_bps === null
            ? {}
            : {
                highestLosingBidBps: clampBid(
                  BigInt(row.highest_losing_bid_bps),
                  policy,
                ),
                ...(row.highest_losing_bid_block === null
                  ? {}
                  : {
                      highestLosingBidBlock: BigInt(
                        row.highest_losing_bid_block,
                      ),
                    }),
              }),
          ...(row.active_probe_bid_bps === null
            ? {}
            : {
                activeProbeBidBps: clampBid(
                  BigInt(row.active_probe_bid_bps),
                  policy,
                ),
              }),
          ...(row.last_updated_block === null
            ? {}
            : {
                lastUpdatedBlock: BigInt(row.last_updated_block),
              }),
        },
      ]),
    );
  }

  async save(
    states: ReadonlyMap<string, AdaptiveBidState>,
  ): Promise<void> {
    if (states.size === 0) return;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      for (const [targetAddress, state] of states) {
        await client.query(
          `
            INSERT INTO adaptive_bid_state (
              scope,
              target_address,
              current_bid_bps,
              consecutive_full_wins,
              consecutive_contradicting_wins,
              last_observed_winning_bid_bps,
              last_observed_winning_block,
              lowest_winning_bid_bps,
              highest_losing_bid_bps,
              highest_losing_bid_block,
              active_probe_bid_bps,
              last_updated_block,
              updated_at
            )
            VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
              $12,
              now()
            )
            ON CONFLICT (scope, target_address) DO UPDATE
            SET
              current_bid_bps = EXCLUDED.current_bid_bps,
              consecutive_full_wins =
                EXCLUDED.consecutive_full_wins,
              consecutive_contradicting_wins =
                EXCLUDED.consecutive_contradicting_wins,
              last_observed_winning_bid_bps =
                EXCLUDED.last_observed_winning_bid_bps,
              last_observed_winning_block =
                EXCLUDED.last_observed_winning_block,
              lowest_winning_bid_bps =
                EXCLUDED.lowest_winning_bid_bps,
              highest_losing_bid_bps =
                EXCLUDED.highest_losing_bid_bps,
              highest_losing_bid_block =
                EXCLUDED.highest_losing_bid_block,
              active_probe_bid_bps =
                EXCLUDED.active_probe_bid_bps,
              last_updated_block = EXCLUDED.last_updated_block,
              updated_at = now()
          `,
          [
            BID_SCOPE,
            targetAddress.toLowerCase(),
            Number(state.currentBidBps),
            state.consecutiveFullWins,
            state.consecutiveContradictingWins ?? 0,
            state.lastObservedWinningBidBps === undefined
              ? null
              : Number(state.lastObservedWinningBidBps),
            state.lastObservedWinningBlock?.toString() ?? null,
            state.lowestWinningBidBps === undefined
              ? null
              : Number(state.lowestWinningBidBps),
            state.highestLosingBidBps === undefined
              ? null
              : Number(state.highestLosingBidBps),
            state.highestLosingBidBlock?.toString() ?? null,
            state.activeProbeBidBps === undefined
              ? null
              : Number(state.activeProbeBidBps),
            state.lastUpdatedBlock?.toString() ?? null,
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original persistence failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#pool.end();
    return this.#closePromise;
  }
}
