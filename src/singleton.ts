import { Client } from "pg";

const SIGNER_LOCK_NAMESPACE = 0x50504b;
const ETHEREUM_MAINNET_LOCK_KEY = 1;

interface LeaseClient {
  connect(): Promise<void>;
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface SignerLease {
  readonly waitedMs: number;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
}

export interface SignerLeaseOptions {
  readonly connectionString: string;
  readonly pollIntervalMs?: number;
  readonly onWaiting?: () => void;
  readonly clientFactory?: () => LeaseClient;
}

function createClient(connectionString: string): LeaseClient {
  const client = new Client({
    connectionString,
    application_name: "pull-pool-keeper:signer-lease",
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
    keepAlive: true,
  });
  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text, values = []) => {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as readonly Record<string, unknown>[],
      };
    },
    end: async () => client.end(),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

export async function acquireSignerLease(
  options: SignerLeaseOptions,
): Promise<SignerLease> {
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new Error("signer lease poll interval must be positive");
  }
  const client =
    options.clientFactory?.() ??
    createClient(options.connectionString);
  await client.connect();
  const startedAt = Date.now();
  let waitingReported = false;
  try {
    while (true) {
      const result = await client.query(
        `
          SELECT pg_try_advisory_lock(
            $1::integer,
            $2::integer
          ) AS locked
        `,
        [SIGNER_LOCK_NAMESPACE, ETHEREUM_MAINNET_LOCK_KEY],
      );
      if (result.rows[0]?.locked === true) {
        let released = false;
        return {
          waitedMs: Date.now() - startedAt,
          assertHeld: async (): Promise<void> => {
            if (released) {
              throw new Error("signer lease has already been released");
            }
            const held = await client.query(
              `
                SELECT EXISTS (
                  SELECT 1
                  FROM pg_locks
                  WHERE locktype = 'advisory'
                    AND pid = pg_backend_pid()
                    AND classid = $1::integer::oid
                    AND objid = $2::integer::oid
                    AND objsubid = 2
                    AND granted
                ) AS held
              `,
              [SIGNER_LOCK_NAMESPACE, ETHEREUM_MAINNET_LOCK_KEY],
            );
            if (held.rows[0]?.held !== true) {
              throw new Error(
                "signer advisory lock is no longer held by this session",
              );
            }
          },
          release: async (): Promise<void> => {
            if (released) return;
            released = true;
            try {
              await client.query(
                `
                  SELECT pg_advisory_unlock(
                    $1::integer,
                    $2::integer
                  )
                `,
                [SIGNER_LOCK_NAMESPACE, ETHEREUM_MAINNET_LOCK_KEY],
              );
            } finally {
              await client.end();
            }
          },
        };
      }
      if (!waitingReported) {
        waitingReported = true;
        options.onWaiting?.();
      }
      await delay(pollIntervalMs);
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
