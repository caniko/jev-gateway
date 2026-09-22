/** The same allowlist applies to clients, stubs, gateways, and package bootstrap processes. */
export function hermeticEnv(iso, extra = {}) {
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "TZ", "TERM", "NO_COLOR"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, HOME: iso.home, XDG_CONFIG_HOME: iso.config, XDG_DATA_HOME: iso.data,
    XDG_CACHE_HOME: iso.cache, XDG_STATE_HOME: iso.state, OPENAI_API_KEY: "stub-key", ...extra };
}
