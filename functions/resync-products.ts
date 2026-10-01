import { describeResync, findSelectedProducts, resyncOne } from "./lib/products";
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
  description: "Resync the products selected in the Swell admin from Printful",
  action: {},
};

export const NONE_FROM_PRINTFUL = "None of these products came from Printful.";

/**
 * Re-reads the products selected in the Products list from Printful, one step
 * each, whether or not Printful's list shows a change. A background run, so a
 * large selection is finished in one go rather than a few products at a time.
 */
export default class ResyncProducts {
  async run(workflowRequest: SwellWorkflowRequest, step: SwellWorkflowStep) {
    const req = toSwellRequest(workflowRequest);
    const owner = leaseOwner(workflowRequest);
    const data = (workflowRequest.data ?? {}) as Record<string, any>;
    const settings = await readSettings(step, workflowRequest);

    // A resync writes the same links a sync does
    await waitForLease(step, req, owner);

    try {
      const found = await step.do("Find the selected Printful products", () =>
        findSelectedProducts(req, data.$action?.selection ?? {}),
      );

      if (found.products.length === 0) {
        throw new Error(NONE_FROM_PRINTFUL);
      }

      const tally = {
        resynced: 0,
        retired: 0,
        remaining: 0,
        skipped: Math.max(0, found.selected - found.products.length),
        errors: [] as string[],
      };

      for (const [index, product] of found.products.entries()) {
        // Two products can share a name, and a step name must be unique in a run
        const outcome = await step.do(
          `Resync ${product.name} (${index + 1} of ${found.products.length})`,
          RATE_LIMIT_RETRIES,
          async () => {
            if (!(await renewLease(req, owner))) {
              return { lost: true };
            }
            return attempt(() =>
              resyncOne(req, settings, product.id, {
                replaceImages: Boolean(data.replace_images),
              }),
            );
          },
        );

        if ("lost" in outcome) {
          throw new Error(LEASE_LOST);
        }

        if (outcome.value === "retired") tally.retired++;
        else if (outcome.value === "skipped") tally.skipped++;
        else if (outcome.value) tally.resynced++;
        if (outcome.error) tally.errors.push(`${product.name}: ${outcome.error}`);
      }

      return { message: describeResync(tally) };
    } finally {
      await letGoOfLease(step, req, owner);
    }
  }
}
