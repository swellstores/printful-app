import { getSettings } from "./lib/settings";
import { runCatalogSync } from "./lib/catalog";

export const config: SwellConfig = {
  description: "Pull the Printful catalog nightly, resuming from the last cursor",
  cron: {
    schedule: "0 3 * * *",
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    return;
  }

  // Each run stops at its request budget and parks its cursor, so a large
  // catalog fills in over several nights rather than exhausting Printful's
  // per-minute limit in one pass.
  console.log("Printful catalog sync", await runCatalogSync(req, settings));
}
