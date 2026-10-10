import * as fs from "node:fs";
import * as path from "node:path";

const repo = path.join(import.meta.dirname, "..");

/**
 * The bubblewrap argv: system dirs read-only, node and the vendored pi read-only, the rest private. The network is
 * NOT private: `--share-net` shares the host's, so loopback and the LAN are reachable from inside, and pi's tools
 * can reach whatever the host can. The key stays outside: the proxy on loopback forwards only pi's two calls
 * (chat completions and the model list) and refuses everything else.
 *
 * `--as-pid-1` makes pi the sandbox's PID 1. Without it bwrap is, and its argv -- every host path it mounts,
 * the repository's included -- is one `ps` away from the model and from there in the transcript. The mount
 * table still names those paths (/proc/self/mountinfo); eval/check-session.ts catches what a model reads there.
 */
export function sandboxArgs(root: string, scenario: string): string[] {
  const node = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  const ro = (from: string, to = from) => (fs.existsSync(from) ? ["--ro-bind", from, to] : []);
  return [
    "--unshare-all", "--share-net", "--die-with-parent", "--new-session", "--clearenv", "--as-pid-1",
    ...ro("/usr"), "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
    ...ro("/etc/ssl"), ...ro("/etc/ca-certificates"), ...ro("/etc/localtime"), ...ro("/etc/nsswitch.conf"),
    ...ro(node, "/opt/node"), ...ro(path.join(repo, "node_modules"), "/opt/pi/node_modules"),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/home", "--dir", "/home/user",
    "--bind", path.join(root, "agent"), "/home/user/.pi/agent", "--bind", path.join(root, "project"), `/work/${scenario}`,
    "--chdir", `/work/${scenario}`,
    "--setenv", "HOME", "/home/user", "--setenv", "PATH", "/opt/node/bin:/usr/bin", "--setenv", "LANG", "C.UTF-8",
    "--setenv", "TERM", "dumb", "--setenv", "USER", "user", "--setenv", "PI_CODING_AGENT_DIR", "/home/user/.pi/agent", "--setenv", "TZ", "UTC",
    "--setenv", "GIT_AUTHOR_NAME", "dev", "--setenv", "GIT_AUTHOR_EMAIL", "dev@example.com",
    "--setenv", "GIT_COMMITTER_NAME", "dev", "--setenv", "GIT_COMMITTER_EMAIL", "dev@example.com",
    "--hostname", "sandbox",
  ];
}

