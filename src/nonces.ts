export interface NonceSnapshot {
  readonly latest: number;
  readonly pending: number;
}

export interface NoncePlan extends NonceSnapshot {
  readonly blocked: boolean;
  readonly nonces: readonly number[];
}

export function buildNoncePlan(
  snapshot: NonceSnapshot,
  transactionCount: number,
): NoncePlan {
  if (!Number.isSafeInteger(snapshot.latest) || snapshot.latest < 0) {
    throw new Error("latest nonce must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(snapshot.pending) || snapshot.pending < 0) {
    throw new Error("pending nonce must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(transactionCount) || transactionCount < 0) {
    throw new Error("transaction count must be a non-negative safe integer");
  }
  if (snapshot.pending < snapshot.latest) {
    throw new Error("pending nonce cannot be below latest nonce");
  }

  const blocked = snapshot.pending > snapshot.latest;
  const nonces = blocked
    ? []
    : Array.from(
        { length: transactionCount },
        (_, index) => snapshot.pending + index,
      );

  if (
    nonces.some(
      (nonce) => !Number.isSafeInteger(nonce) || nonce < snapshot.pending,
    )
  ) {
    throw new Error("planned nonce exceeds the safe integer range");
  }

  return {
    ...snapshot,
    blocked,
    nonces,
  };
}
