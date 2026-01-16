import type { CLICommand } from "@/types";
import { config } from "@/config";

export const versionCommand: CLICommand = {
  name: "version",
  description: "Affiche la version",

  action(): void {
    console.log(`${config.name} v${config.version}`);
  },
};
