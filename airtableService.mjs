// airtableService.mjs

const FALLBACK_BLACKLIST = [
  "WHITEWHALE", "DASH", "RIVER", "GRIFFAIN",
  "SCR", "BREV", "MAGMA"
];

/**
 * Fetch the dynamic blacklist of tokens to avoid.
 * Currently returns hardcoded fallback list.
 * TODO: Integrate with Airtable API when credentials are available.
 * @returns {Promise<string[]>} Array of blacklisted token base names (e.g. "DASH", not "DASHUSDT")
 */
export async function fetchBlacklist() {
  return FALLBACK_BLACKLIST;
}
