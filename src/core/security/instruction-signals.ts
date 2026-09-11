/**
 * Bounded prompt-injection/instruction-signal detection for untrusted local
 * source. This is intentionally a signal, never a policy decision: callers
 * must not execute or follow text returned by a project.
 */

import { truncateUtf8 } from "@core/utils/utf8";

export type InstructionSignalKind =
  | "instruction_override"
  | "authority_spoofing"
  | "tool_execution_request"
  | "secret_exfiltration_request"
  | "delimiter_spoofing"
  | "hidden_unicode"
  | "encoded_instruction";

export interface InstructionSignal {
  kind: InstructionSignalKind;
  source?: string;
  line: number;
  column: number;
  offset: number;
  confidence: number;
  reason: string;
}

export interface InstructionSignals {
  detected: boolean;
  count: number;
  kinds: InstructionSignalKind[];
  signals: InstructionSignal[];
  scanned_bytes: number;
  scan_truncated: boolean;
}

export interface InstructionSignalOptions {
  source?: string;
  maxBytes?: number;
  maxSignals?: number;
}

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_SIGNALS = 50;

const detectors: {
  kind: InstructionSignalKind;
  confidence: number;
  reason: string;
  pattern: RegExp;
}[] = [
  {
    kind: "instruction_override",
    confidence: 0.99,
    reason: "Text attempts to override earlier, system, developer, or safety instructions.",
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass|follow only)\b[\s\S]{0,140}\b(?:previous|prior|above|system|developer|assistant|safety|instruction|rule)s?\b/giu,
  },
  {
    kind: "authority_spoofing",
    confidence: 0.96,
    reason: "Text presents itself as a system, developer, or assistant message.",
    pattern:
      /(?:^|[\r\n])\s*(?:system|developer|assistant)\s*(?:message|prompt|instruction)\s*[:>]/gimu,
  },
  {
    kind: "tool_execution_request",
    confidence: 0.82,
    reason: "Text asks an agent to invoke a tool, shell, terminal, or command.",
    pattern:
      /\b(?:call|invoke|use|run|execute)\b[\s\S]{0,100}\b(?:tool|function|command|shell|powershell|bash|terminal|script)\b/giu,
  },
  {
    kind: "secret_exfiltration_request",
    confidence: 0.94,
    reason: "Text asks to reveal, send, or collect secrets or credentials.",
    pattern:
      /\b(?:send|upload|exfiltrate|reveal|print|dump|share|post|collect)\b[\s\S]{0,120}\b(?:secret|token|api[_ -]?key|password|credential|private\s+key|environment|\.env)\b/giu,
  },
  {
    kind: "delimiter_spoofing",
    confidence: 0.91,
    reason: "Text contains a prompt/tool delimiter that can impersonate protocol data.",
    pattern:
      /<\s*\/?\s*(?:system|tool_call|function_call|assistant|developer)\s*>|\[\s*(?:system|assistant|developer)\s*\]|```\s*(?:system|tool_call|function_call)\b/giu,
  },
  {
    kind: "hidden_unicode",
    confidence: 0.9,
    reason:
      "Text contains bidirectional or isolate Unicode controls that can hide displayed instructions.",
    pattern: /[\u202A-\u202E\u2066-\u2069]/gu,
  },
  {
    kind: "encoded_instruction",
    confidence: 0.78,
    reason: "Text mentions decoding an encoded payload into an instruction, command, or secret.",
    pattern:
      /\b(?:base64|atob|frombase64|decode|decode64)\b[\s\S]{0,100}\b(?:instruction|prompt|command|secret|token)\b/giu,
  },
];

function positionAt(
  value: string,
  offset: number,
): {
  line: number;
  column: number;
  byteOffset: number;
} {
  const prefix = value.slice(0, offset);
  const lineStart = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  return {
    line: (prefix.match(/\n/gu) ?? []).length + 1,
    column: Array.from(prefix.slice(lineStart + 1)).length,
    byteOffset: Buffer.byteLength(prefix, "utf8"),
  };
}

export function scanInstructionSignals(
  value: string,
  options: InstructionSignalOptions = {},
): InstructionSignals {
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, 2_000_000));
  const maxSignals = Math.max(1, Math.min(options.maxSignals ?? DEFAULT_MAX_SIGNALS, 500));
  const scanned = truncateUtf8(value, maxBytes);
  const scanTruncated = scanned.length < value.length;
  const signals: InstructionSignal[] = [];
  const seen = new Set<string>();
  let signalLimitReached = false;

  for (const detector of detectors) {
    detector.pattern.lastIndex = 0;
    for (const match of scanned.matchAll(detector.pattern)) {
      const index = match.index;
      const position = positionAt(scanned, index);
      const key = `${detector.kind}:${String(index)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      signals.push({
        kind: detector.kind,
        ...(options.source === undefined ? {} : { source: options.source }),
        line: position.line,
        column: position.column,
        offset: position.byteOffset,
        confidence: detector.confidence,
        reason: detector.reason,
      });
      if (signals.length >= maxSignals) {
        signalLimitReached = true;
        break;
      }
    }
    if (signals.length >= maxSignals) {
      break;
    }
  }

  signals.sort((left, right) => left.offset - right.offset || left.kind.localeCompare(right.kind));
  const boundedSignals = signals.slice(0, maxSignals);
  const kinds = [...new Set(boundedSignals.map((signal) => signal.kind))].sort();
  return {
    detected: boundedSignals.length > 0,
    count: boundedSignals.length,
    kinds,
    signals: boundedSignals,
    scanned_bytes: Buffer.byteLength(scanned, "utf8"),
    scan_truncated: scanTruncated || signalLimitReached,
  };
}

export function mergeInstructionSignals(
  scans: readonly InstructionSignals[],
  maxSignals = DEFAULT_MAX_SIGNALS,
): InstructionSignals {
  const boundedMax = Math.max(1, Math.min(maxSignals, 500));
  const signals = scans
    .flatMap((scan) => scan.signals)
    .sort(
      (left, right) =>
        (left.source ?? "").localeCompare(right.source ?? "") ||
        left.offset - right.offset ||
        left.kind.localeCompare(right.kind),
    );
  const boundedSignals = signals.slice(0, boundedMax);
  return {
    detected: boundedSignals.length > 0,
    count: boundedSignals.length,
    kinds: [...new Set(boundedSignals.map((signal) => signal.kind))].sort(),
    signals: boundedSignals,
    scanned_bytes: scans.reduce((total, scan) => total + scan.scanned_bytes, 0),
    scan_truncated:
      scans.some((scan) => scan.scan_truncated) || signals.length > boundedSignals.length,
  };
}
