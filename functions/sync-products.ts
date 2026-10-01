import { planSync, retireRemoved, summarize, syncOne } from "./lib/products";
import {
  attempt,
  LEASE_LOST,
  leaseOwner,
  letGoOfLease,
  RATE_LIMIT_RETRIES,
  readSettings,
  renewLease,
  toSwellRequest,
  waitForLease,
} from "./lib/workflow";

export const config: SwellConfig = {
  kind: "workflow",
  description: "Sync products from Printful",
  action: {},
};

/**
 * The whole product sync as a background run, started by the "Sync products
 * now" action. Unlike the scheduled sync it is not cut short by the function
 * time limit: every new and changed product is synced, one step each, and
 * the step names are the progress merchants see.
 */
export default class SyncProducts {
  async run(workflowRequest: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const req = toSwellRequest(workflowRequest);
    const owner = leaseOwner(workflowRequest);
    const settings = await readSettings(step, workflowRequest);

    await waitForLease(step, req, owner);

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

        throw new Error(summarize(tally));
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
            if (!(await renewLease(req, owner))) {
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

      return { message: summarize(tally) };
    } finally {
      await letGoOfLease(step, req, owner);
    }
  }
}
