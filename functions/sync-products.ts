import { getSettings } from "./lib/settings";
import { planSync, recordSyncResult, retireRemoved, syncOne } from "./lib/products";
import { PrintfulError } from "./lib/printful";
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

    const settings = await step.do("Read the app settings", () => getSettings(req));

    if (!settings.api_token) {
      throw new Error("Add your Printful API token in the app settings first.");
    }

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

      // Two products can share a name, and a step name must be unique in a run
      const outcome = await step.do(
        `Sync ${name} (${index + 1} of ${queue.length})`,
        RATE_LIMIT_RETRIES,
        () => attempt(() => syncOne(req, settings, product)),
      );

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
  }
}
