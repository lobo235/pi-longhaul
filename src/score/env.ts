/** Environment knobs for the offline scorer CLIs. */

/** A positive integer from the environment, or a loud exit: a typo must not silently replay everything or nothing (security.md T7). */
export function positiveIntEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  return value;
}
