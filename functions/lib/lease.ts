import { getSettings, putSettings, SyncLease } from "./settings";

/**
 * Keeps two product syncs from running at once, which could both create the
 * same Swell product. The lease names the sync that holds it and lives in the
 * app settings. It runs out on its own, so a sync that crashes or is stopped
 * never blocks the next one for long.
 */
// A function is killed at 10s. Its lease outlasts that, so a run killed
// before it lets go of the lease frees it within a minute.
export const FUNCTION_LEASE_SECONDS = 60;

export const ALREADY_RUNNING =
  "Another Printful sync is running; try again when it finishes.";

export function isLive(
  lease: SyncLease | null | undefined,
  now = Date.now(),
): lease is SyncLease {
  return Boolean(lease?.owner) && Date.parse(String(lease?.until)) > now;
}

export type LeaseResult =
  | { taken: true }
  | { taken: false; lease: SyncLease | null };

/**
 * Takes the lease for `owner` for `seconds`, or extends it when `owner` holds
 * it already. It is not taken while another owner's lease is live.
 *
 * Settings writes are not compare-and-set, so two syncs can both find the
 * lease free and both write it. Reading it back and carrying on only when it
 * still names `owner` narrows that race to the moment between the two writes;
 * it does not close it.
 */
export async function takeLease(
  req: SwellRequest,
  owner: string,
  seconds: number,
): Promise<LeaseResult> {
  const { sync_lease: held } = await getSettings(req);

  if (isLive(held) && held.owner !== owner) {
    return { taken: false, lease: held };
  }

  await putSettings(req, {
    sync_lease: {
      owner,
      until: new Date(Date.now() + seconds * 1000).toISOString(),
    },
  });

  const { sync_lease: written } = await getSettings(req);

  return written?.owner === owner
    ? { taken: true }
    : { taken: false, lease: written ?? null };
}

/** Gives the lease up, unless another owner has taken it since. */
export async function releaseLease(req: SwellRequest, owner: string) {
  const { sync_lease: held } = await getSettings(req);

  if (held?.owner === owner) {
    await putSettings(req, { sync_lease: null });
  }
}
