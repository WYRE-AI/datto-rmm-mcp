/**
 * Alert-card payload builder for the MCP Apps (SEP-1865) UI surface.
 *
 * datto_get_alert results get a normalized `_card` object attached (see
 * mcp-server.ts) that the ui:// alert card renders from. The card is
 * progressive enhancement: normalization is best-effort, and a null return
 * simply means the host renders no card while the JSON payload is unchanged.
 */

import { ALERT_CONTEXT_TYPES, type Alert } from "@wyre-ai/node-datto-rmm";

export const ALERT_CARD_RESOURCE_URI = "ui://datto-rmm/alert-card.html";

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = "text/html;profile=mcp-app";

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const ALERT_CARD_META = {
  "ui/resourceUri": ALERT_CARD_RESOURCE_URI,
  ui: { resourceUri: ALERT_CARD_RESOURCE_URI },
} as const;

/** Mirror of AlertCard in ui/alert-card.ts — keep in sync. */
export interface AlertCard {
  alertUid: string;
  title: string;
  message?: string;
  priority?: string;
  status?: string;
  device?: string;
  site?: string;
  category?: string;
  createdAt?: string;
  resolvedBy?: string;
  /** True while the alert is unresolved — drives the "Resolve alert" button. */
  canResolve: boolean;
}

/** Brand overrides injected into the card as `window.__BRAND__`. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

/** The comment marker in ui/index.html that serve-time injection replaces. */
const BRAND_INJECT_MARKER = /<!-- BRAND_INJECT:[\s\S]*?-->/;

/**
 * Replace the card's BRAND_INJECT comment with a `window.__BRAND__` script.
 * The card ships neutral; this is the customization mechanism. An empty
 * brand returns the HTML unchanged. `<` is escaped so brand values can
 * never break out of the injected script tag.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  const entries = Object.entries(brand).filter(
    ([, value]) => typeof value === "string" && value !== ""
  );
  if (entries.length === 0) return html;
  const json = JSON.stringify(Object.fromEntries(entries)).replace(/</g, "\\u003c");
  return html.replace(BRAND_INJECT_MARKER, `<script>window.__BRAND__=${json}</script>`);
}

/**
 * Resolve brand overrides from MCP_BRAND_* environment variables. Returns
 * an empty brand (HTML served unchanged) when none are set, or on runtimes
 * without `process.env` (e.g. Cloudflare Workers without nodejs_compat).
 */
export function brandFromEnv(): CardBrand {
  if (typeof process === "undefined" || !process.env) return {};
  const env = process.env;
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

const CARD_MESSAGE_MAX_LENGTH = 500;

/**
 * Normalize an SDK Alert into the flat, label-resolved payload the ui://
 * alert card renders from. Datto priorities are already human-readable
 * strings; the alert type is resolved from the context `@class` via the
 * SDK's ALERT_CONTEXT_TYPES mapping when no explicit type is present.
 */
export function buildAlertCard(alert: Partial<Alert> | null | undefined): AlertCard | null {
  if (!alert || typeof alert.alertUid !== "string" || alert.alertUid === "") {
    return null;
  }

  const contextClass = alert.alertContext?.["@class"];
  const contextLabel =
    typeof contextClass === "string" ? ALERT_CONTEXT_TYPES[contextClass] : undefined;

  const card: AlertCard = {
    alertUid: alert.alertUid,
    title: alert.alertType ?? contextLabel ?? alert.alertCategory ?? "Alert",
    canResolve: alert.status !== "resolved" && alert.resolvedAt == null,
  };

  if (typeof alert.message === "string" && alert.message) {
    card.message = alert.message.slice(0, CARD_MESSAGE_MAX_LENGTH);
  }
  if (typeof alert.priority === "string") card.priority = alert.priority;
  if (typeof alert.status === "string" && alert.status) {
    card.status = alert.status.charAt(0).toUpperCase() + alert.status.slice(1);
  }
  if (typeof alert.hostname === "string" && alert.hostname) card.device = alert.hostname;
  if (typeof alert.siteName === "string" && alert.siteName) card.site = alert.siteName;
  if (typeof alert.alertCategory === "string" && alert.alertCategory) {
    card.category = alert.alertCategory;
  }
  if (typeof alert.createdAt === "number") {
    const created = new Date(alert.createdAt);
    if (!Number.isNaN(created.getTime())) card.createdAt = created.toISOString();
  }
  if (typeof alert.resolvedBy === "string" && alert.resolvedBy) {
    card.resolvedBy = alert.resolvedBy;
  }

  return card;
}
