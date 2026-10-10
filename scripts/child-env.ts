/**
 * The environment the smokes start pi with: an allowlist, so no API key, git or Node setting of the person running
 * it reaches the child. HOME (and USERPROFILE, where Windows uses it) point at the smoke's temporary directory.
 */
const PASSED = ["PATH", "Path", "LANG", "LC_ALL", "TZ", "TMPDIR", "TEMP", "TMP", "SystemRoot", "windir", "ComSpec", "PATHEXT"];

export function childEnv(parent: NodeJS.ProcessEnv, root: string, agentDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED) if (parent[name] !== undefined) env[name] = parent[name];
  env.HOME = root;
  if (parent.USERPROFILE !== undefined) env.USERPROFILE = root;
  env.PI_CODING_AGENT_DIR = agentDir;
  return env;
}
