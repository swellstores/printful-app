import { PrintfulSettings } from "./lib/settings";
import { planSync, recordSyncResult, retireRemoved, syncOne } from "./lib/products";
import { PrintfulError } from "./lib/printful";
import { ALREADY_RUNNING, releaseLease, takeLease } from "./lib/lease";
import { toSwellRequest } from "./lib/workflow";

export const config: SwellConfig = {
  kind: "workflow",
  description: "Sync products from Printful",
  action: {},
};

// Printful allows 120 requests a minute; a step that hits the limit waits for
// the window to reset and runs again.
const RATE_LIMIT_RETRIES = {
  retries: { limit: 3, delay: "60 seconds", backoff: "constant" as const },
};

// Outlasts a slow step, rate-limited retries included, so a running sync keeps
// its lease; a sync that stops renewing it frees it within minutes.
const LEASE_SECONDS = 150;

// While another sync holds the lease, this one checks again every half minute
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
async function attempt<T>(fn: () => Promise<T>) {
  try {
    return { value: await fn() };
  } catch (err) {
    if (err instanceof PrintfulError && err.status === 429) {
      throw err;
    }
    return { error: message(err) };
  }
}

/**
 * The whole product sync as a background run, started by the "Sync products
 * now" action. Unlike the scheduled sync it is not cut short by the function
 * time limit: every new and changed product is synced, one step each, and
 * the step names are the progress merchants see.
 */
export default class SyncProducts {
  async run(workflowRequest: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const req = toSwellRequest(workflowRequest);
    const owner = workflowRequest.workflow?.workflow_instance_id || workflowRequest.id;

    // settings() answers every settings file of the app, keyed by its name
    const settings: PrintfulSettings = await step.do("Read the app settings", async () =>
      (await workflowRequest.swell.settings())?.printful ?? {},
    );

    if (!settings.api_token) {
      throw new Error("Add your Printful API token in the app settings first.");
    }

    // Two syncs at once could both create the same product, so this one waits
    // for any other to finish first
    for (let check = 1; ; check++) {
      const label = check === 1 ? "" : ` (${check})`;
      const lease = await step.do(`Check for another Printful sync${label}`, () =>
        takeLease(req, owner, LEASE_SECONDS),
      );

      if (lease.taken) {
        break;
      }

      if (check > WAIT_CHECKS) {
        throw new Error(ALREADY_RUNNING);
      }

      await step.sleep(`Wait for the other Printful sync${label}`, WAIT);
    }

    try {
      const tally = {
        products: 0,
        created: 0,
        updated: 0,
        retired: 0,
        complete: true,
        listed: true,
        errors: [] as string[],
      };

      const plan = await step.do("List Printful products", RATE_LIMIT_RETRIES, () =>
        attempt(() => planSync(req, settings)),
      );

      if (!plan.value) {
        tally.listed = false;
        tally.errors.push(plan.error as string);

        const summary = await step.do("Save the sync result", () =>
          recordSyncResult(req, tally),
        );

        throw new Error(summary);
      }

      const { listed, queue } = plan.value;
      tally.products = listed.length;

      for (const [index, product] of queue.entries()) {
        const name = product.summary.name ?? `Printful product ${product.summary.id}`;

        // Two products can share a name, and a step name must be unique in a
        // run. Each step renews the lease before it can create anything.
        const outcome = await step.do(
          `Sync ${name} (${index + 1} of ${queue.length})`,
          RATE_LIMIT_RETRIES,
          async () => {
            if (!(await takeLease(req, owner, LEASE_SECONDS)).taken) {
              return { lost: true };
            }
            return attempt(() => syncOne(req, settings, product));
          },
        );

        if ("lost" in outcome) {
          throw new Error(LEASE_LOST);
        }

        if (outcome.value === "created") tally.created++;
        if (outcome.value === "updated") tally.updated++;
        if (outcome.value === "retired") tally.retired++;
        if (outcome.error) tally.errors.push(`${name}: ${outcome.error}`);
      }

      tally.retired += await step.do("Take removed products off sale", () =>
        retireRemoved(req, listed),
      );

      const summary = await step.do("Save the sync result", () =>
        recordSyncResult(req, tally),
      );

      return { message: summary };
    } finally {
      // After a failure too. A run stopped outright leaves the lease to run out.
      await step
        .do("Release the sync lease", () => releaseLease(req, owner))
        .catch(() => undefined);
    }
  }
}
