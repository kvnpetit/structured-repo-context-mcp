import type { CLIOption } from "@/types";

interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const restArgs: string[] = [];
  const options: Record<string, string | boolean> = {};

  let i = 1;
  while (i < args.length) {
    const arg = args[i];

    if (arg === undefined) {
      i++;
      continue;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];

      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
    } else if (arg.startsWith("-")) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];

      if (nextArg !== undefined && !nextArg.startsWith("-")) {
        options[key] = nextArg;
        i += 2;
      } else {
        options[key] = true;
        i++;
      }
    } else {
      restArgs.push(arg);
      i++;
    }
  }

  return { command, args: restArgs, options };
}

export function formatHelp(
  commandName: string,
  description: string,
  options?: CLIOption[]
): string {
  let help = `\n  ${commandName.padEnd(15)} ${description}`;

  if (options !== undefined && options.length > 0) {
    help += "\n    Options:";
    for (const opt of options) {
      const required = opt.required === true ? " (required)" : "";
      const defaultVal =
        opt.defaultValue !== undefined ? ` [default: ${opt.defaultValue}]` : "";
      help += `\n      ${opt.flag.padEnd(20)} ${opt.description}${required}${defaultVal}`;
    }
  }

  return help;
}
