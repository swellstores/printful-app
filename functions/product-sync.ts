import { getSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";

export const config: SwellConfig = {
  description: "Create and update Swell products from the products designed in Printful",
  cron: {
    schedule: "*/5 * * * *",
  },
};

export default async function (req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    return;
  }

  // Each run stops at its request budget, handling new products first, so a
  // large store fills in over several runs rather than exhausting Printful's
  // per-minute limit in one pass.
  console.log("Printful product sync", await runProductSync(req, settings));
}
