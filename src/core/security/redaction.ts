const SECRET_KEY_SOURCE =
  "(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?token|authorization|client[_-]?secret|password|passwd|private[_-]?key|secret|token)";
const SECRET_KEY_PATTERN = new RegExp(`^${SECRET_KEY_SOURCE}$`, "iu");
const QUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:["']?\\b${SECRET_KEY_SOURCE}\\b["']?)[ \\t]*[:=][ \\t]*)(["'\\x60])((?:\\\\.|[^\\\\\\r\\n])*?)\\2`,
  "giu",
);
const UNQUOTED_SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:["']?\\b${SECRET_KEY_SOURCE}\\b["']?)[ \\t]*[:=][ \\t]*)([^\\s"'\\x60,;}\\r\\n)]+)`,
  "giu",
);
const PEM_BLOCK_PATTERN = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gu;
const TOKEN_PATTERN =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/gu;
const BEARER_PATTERN = /\bBearer[ \t]+[A-Za-z0-9._~+/-]{8,}={0,2}/giu;
const LANGUAGE_TYPE_ANNOTATION =
  /^(?:any|bigint|boolean|never|null|number|object|string|symbol|undefined|unknown|void)(?:\[\])?[?]?$/iu;

export interface RedactedSource {
  text: string;
  redacted: boolean;
}

export interface RedactedValue {
  value: unknown;
  redacted: boolean;
}

/**
 * Remove common inline credentials before source is placed in an agent
 * context. This is intentionally conservative and never mutates files or
 * changes the exact-navigation tools unless their caller opts in.
 */
export function redactSourceText(source: string): RedactedSource {
  let text = source;
  text = text.replace(PEM_BLOCK_PATTERN, "[REDACTED PEM BLOCK]");
  text = text.replace(BEARER_PATTERN, "Bearer [REDACTED TOKEN]");
  text = text.replace(
    QUOTED_SECRET_ASSIGNMENT_PATTERN,
    (_match, prefix: string, quote: string) =>
      `${prefix}${quote}[REDACTED]${quote}`,
  );
  text = text.replace(
    UNQUOTED_SECRET_ASSIGNMENT_PATTERN,
    (match, prefix: string, value: string) =>
      LANGUAGE_TYPE_ANNOTATION.test(value) ? match : `${prefix}[REDACTED]`,
  );
  text = text.replace(TOKEN_PATTERN, "[REDACTED TOKEN]");
  return { text, redacted: text !== source };
}

/**
 * Redact strings nested in a plain structured result while preserving its
 * shape. Tool outputs are JSON-like, so this deliberately does not traverse
 * class instances, Maps, or arbitrary prototypes.
 */
export function redactStructuredValue(
  value: unknown,
  containingKey?: string,
): RedactedValue {
  if (typeof value === "string") {
    if (
      containingKey !== undefined &&
      SECRET_KEY_PATTERN.test(containingKey) &&
      !value.includes("[REDACTED")
    ) {
      return { value: "[REDACTED]", redacted: true };
    }
    const result = redactSourceText(value);
    return { value: result.text, redacted: result.redacted };
  }
  if (Array.isArray(value)) {
    let redacted = false;
    const items = value.map((item) => {
      const result = redactStructuredValue(item, containingKey);
      redacted ||= result.redacted;
      return result.value;
    });
    return { value: items, redacted };
  }
  if (value !== null && typeof value === "object") {
    let redacted = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const result = redactStructuredValue(item, key);
      redacted ||= result.redacted;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries), redacted };
  }
  return { value, redacted: false };
}
