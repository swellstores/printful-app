export interface PrintfulSettings {
  api_token?: string;
  live_fulfillment?: boolean;
  fallback_rate?: number;
  fallback_service_name?: string;
  quote_cache_ttl?: number;
  rate_timeout_ms?: number;
  webhook_secret?: string;
  webhook_public_key?: string;
  last_sync_at?: string;
  last_sync_result?: string;
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
