export interface PrintfulSettings {
  api_token?: string;
  live_fulfillment?: boolean;
  product_source?: "printful" | "swell";
  fallback_rate?: number;
  fallback_service_name?: string;
  sync_lease?: SyncLease | null;
}

/** The product sync that is running, if any; see lib/lease. */
export interface SyncLease {
  owner: string;
  until: string;
}

/**
 * `query` carries `$currency` when a localized field is being read — without it
 * `fallback_rate` comes back in the store's base currency.
 */
export function getSettings(
  req: SwellRequest,
  query?: Record<string, any>,
): Promise<PrintfulSettings> {
  return req.swell.get(`/settings/${req.appId}/printful`, query);
}

export function putSettings(
  req: SwellRequest,
  values: Partial<PrintfulSettings>,
): Promise<any> {
  return req.swell.put(`/settings/${req.appId}/printful`, values);
}
