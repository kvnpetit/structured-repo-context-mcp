import { parseArgs } from "./parser";
import { findCommand } from "./commands";
import { helpCommand } from "./commands/help.command";

export function runCLI(): void {
  const { command, args, options } = parseArgs(process.argv);

  const cmd = findCommand(command);

  if (cmd === undefined) {
    console.error(`Commande inconnue: ${command}\n`);
    helpCommand.action([], {});
    process.exit(1);
  }

  try {
    cmd.action(args, options);
  } catch (error) {
    console.error(`Erreur lors de l'exécution de la commande:`, error);
    process.exit(1);
  }
}
