import { PrintfulError } from "./printful";
import { ALREADY_RUNNING, releaseLease, takeLease } from "./lease";
import { PrintfulSettings } from "./settings";

/**
 * Lets the product sync, written for functions, run inside a workflow, whose
 * request has no `appValues`.
 */
export function toSwellRequest(req: SwellWorkflowRequest): SwellRequest {
  return {
    appId: req.appId,
    store: req.store,
    data: req.data,
    isLocalDev: false,
    appValues: (values: object) => ({ $app: { [req.appId]: values } }),
    swell: req.swell,
  } as unknown as SwellRequest;
}

// Printful allows 120 requests a minute; a step that hits the limit waits for
// the window to reset and runs again.
export const RATE_LIMIT_RETRIES = {
  retries: { limit: 3, delay: "60 seconds", backoff: "constant" as const },
};

// Outlasts a slow step, rate-limited retries included, so a running sync keeps
// its lease; a sync that stops renewing it frees it within minutes.
export const LEASE_SECONDS = 150;

// While another sync holds the lease, a run checks again every half minute
// for a few minutes before giving up.
const WAIT_CHECKS = 6;
const WAIT = "30 seconds";

export const LEASE_LOST =
  "Another Printful sync took over while this one was held up, so this one stopped.";

function message(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs `fn` inside a step, retrying only when Printful is rate limiting.
 * Other errors are returned instead of thrown: retrying a bad token or a
 * product that cannot be matched only fails again, minutes later.
 */
export async function attempt<T>(fn: () => Promise<T>) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof PrintfulError && err.status === 429) {
      throw err;
    }
    return { error: message(err) };
  }
}

/** Reads the Printful settings, and stops the run when there is no token. */
export async function readSettings(
  step: SwellWorkflowStep,
  req: SwellWorkflowRequest,
): Promise<PrintfulSettings> {
  // settings() answers every settings file of the app, keyed by its name
  const settings: PrintfulSettings = await step.do("Read the app settings", async () =>
    (await req.swell.settings())?.printful ?? {},
  );

  if (!settings.api_token) {
    throw new Error("Add your Printful API token in the app settings first.");
  }

  return settings;
}

/** The name a run holds the sync lease under. */
export function leaseOwner(req: SwellWorkflowRequest) {
  return req.workflow?.workflow_instance_id || req.id;
}

/**
 * Takes the sync lease, waiting for another sync to finish first: two syncs
 * at once could both create the same product.
 */
export async function waitForLease(
  step: SwellWorkflowStep,
  req: SwellRequest,
  owner: string,
) {
  for (let check = 1; ; check++) {
    const label = check === 1 ? "" : ` (${check})`;
    const lease = await step.do(`Check for another Printful sync${label}`, () =>
      takeLease(req, owner, LEASE_SECONDS),
    );

    if (lease.taken) {
      return;
    }

    if (check > WAIT_CHECKS) {
      throw new Error(ALREADY_RUNNING);
    }

    await step.sleep(`Wait for the other Printful sync${label}`, WAIT);
  }
}

/** Renews the lease inside a step; false when another sync has taken it. */
export async function renewLease(req: SwellRequest, owner: string) {
  return (await takeLease(req, owner, LEASE_SECONDS)).taken;
}

/** Lets go of the lease. A run stopped outright leaves it to run out. */
export async function letGoOfLease(
  step: SwellWorkflowStep,
  req: SwellRequest,
  owner: string,
) {
  await step
    .do("Release the sync lease", () => releaseLease(req, owner))
    .catch(() => undefined);
}
