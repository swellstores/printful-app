import { getSettings, putSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";
import { releaseLease, takeLease } from "./lib/lease";

export const config: SwellConfig = {
  description: "Create and update Swell products from the products designed in Printful",
  // Hourly catches up on changes; the "Sync products now" action pulls new
  // designs right away.
  cron: {
    schedule: "0 * * * *",
  },
};

// The function is killed at 10s. The lease outlasts that, so a run killed
// before it lets go of the lease frees it within a minute.
const LEASE_SECONDS = 60;

export const SKIPPED = "Skipped: another Printful sync was already running.";

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    return;
  }

  // A sync started from the admin may still be running; two at once could
  // both create the same product
  const owner = `cron:${new Date().toISOString()}`;

  if (!(await takeLease(req, owner, LEASE_SECONDS)).taken) {
    await putSettings(req, {
      last_sync_at: new Date().toISOString(),
      last_sync_result: SKIPPED,
    });
    return;
  }

  try {
    // Each run stops at its request budget, handling new products first, so a
    // large store fills in over several runs rather than exhausting Printful's
    // per-minute limit in one pass.
    console.log("Printful product sync", await runProductSync(req, settings));
  } finally {
    // The lease runs out on its own, so failing to let go of it must not fail
    // the run
    await releaseLease(req, owner).catch((err) =>
      console.log("Could not release the Printful sync lease", err),
    );
  }
}
