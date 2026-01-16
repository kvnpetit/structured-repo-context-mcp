import type { CLICommand } from "@/types";
import { config } from "@/config";
import { formatHelp } from "@/cli/parser";

let cachedCommands: CLICommand[] | null = null;

async function getCommands(): Promise<CLICommand[]> {
  if (cachedCommands === null) {
    const { commands } = await import("./index");
    cachedCommands = commands;
  }
  return cachedCommands;
}

export const helpCommand: CLICommand = {
  name: "help",
  description: "Affiche l'aide",

  action(): void {
    void getCommands().then((commands) => {
      const description = config.description ?? "";
      console.log(`
${config.name} v${config.version}
${description}

Usage: bun run cli <command> [options]

Commands:
${commands.map((cmd) => formatHelp(cmd.name, cmd.description, cmd.options)).join("\n")}
`);
    });
  },
};
