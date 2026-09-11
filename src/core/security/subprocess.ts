const SAFE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CI",
  "COLORTERM",
  "ComSpec",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LANG",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "Path",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SystemRoot",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "windir",
  "WINDIR",
]);

const SAFE_ENVIRONMENT_PREFIXES = ["LC_", "LANG", "TZ"] as const;
const SENSITIVE_ENVIRONMENT_KEY =
  /(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/iu;

/**
 * Build a minimal environment for an explicitly enabled local helper.
 *
 * Language servers and static analyzers do not need the host process' complete
 * environment. In particular, forwarding arbitrary API keys or credentials to
 * a project-local executable would turn a read-only analysis into a secret
 * disclosure boundary. Keep only runtime/path/locale settings and reject
 * sensitive names even when a caller uses an otherwise harmless prefix.
 */
export function createSafeLocalToolEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined || SENSITIVE_ENVIRONMENT_KEY.test(key)) {
      continue;
    }
    const upperKey = key.toUpperCase();
    if (
      SAFE_ENVIRONMENT_KEYS.has(key) ||
      upperKey === "PATH" ||
      SAFE_ENVIRONMENT_PREFIXES.some((prefix) => upperKey.startsWith(prefix))
    ) {
      safe[key] = value;
    }
  }
  return safe;
}
