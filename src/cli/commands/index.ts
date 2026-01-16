import type { CLICommand } from "@/types";
import { features } from "@/features";
import { featureToCLICommand } from "@/cli/adapter";
import { serveCommand } from "./serve.command";
import { helpCommand } from "./help.command";
import { versionCommand } from "./version.command";

const systemCommands: CLICommand[] = [
  serveCommand,
  helpCommand,
  versionCommand,
];

const featureCommands: CLICommand[] = features.map(featureToCLICommand);

export const commands: CLICommand[] = [...systemCommands, ...featureCommands];

export function findCommand(name: string): CLICommand | undefined {
  return commands.find((cmd) => cmd.name === name);
}
