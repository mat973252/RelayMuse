/**
 * The ONLY module in the workspace permitted to read `process.env`.
 *
 * Contract enforced by the workspace boundary test:
 *   - `process.env` may appear ONLY in this file;
 *   - this file must never write, format, serialize, or log anything.
 *
 * Values retrieved here flow exclusively into outgoing HTTP headers for
 * capability probes; capability results carry status/detail strings that
 * never include env-derived values (verified by the secret-leak tests).
 */

/** Existence check used by `env-ref` capability checks. Booleans only. */
export function envNamePresent(name: string): boolean {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0;
}

/**
 * Header value for `http` capability checks. The value is used in-flight
 * only and must never be embedded in any probe result or output.
 */
export function envHeaderValue(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Numeric value for `RELAY_TEST_*` debug/test knobs only. Never used for
 * probe headers or persisted anywhere.
 */
export function envNumber(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
