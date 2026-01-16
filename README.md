# my-mcp-server

Serveur MCP (Model Context Protocol) personnalisé avec CLI.

## Prérequis

- [Bun](https://bun.sh/) >= 1.0.0

## Installation

```bash
bun install
```

## Utilisation

### Serveur MCP

```bash
# Démarrer le serveur
bun start

# Mode développement (watch)
bun run dev
```

### CLI

```bash
# Afficher l'aide
bun run cli help

# Afficher la version
bun run cli version

# Afficher les infos du serveur
bun run cli info --format json

# Utiliser une feature
bun run cli echo --message "Hello World"
```

### Configuration MCP

Pour utiliser ce serveur avec un client MCP :

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "bun",
      "args": ["run", "/chemin/vers/mcp/src/index.ts"]
    }
  }
}
```

## Développement

### Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Mode développement avec watch |
| `bun test` | Lancer les tests |
| `bun test --watch` | Tests en mode watch |
| `bun run check` | Typecheck + lint + format |
| `bun run lint:fix` | Corriger les erreurs ESLint |
| `bun run format` | Formater le code |
| `bun run build` | Build pour production |

### Ajouter une feature

1. Créer `src/features/ma-feature/index.ts` :

```typescript
import { z } from "zod";
import type { Feature, FeatureResult } from "@/features/types";

export const mySchema = z.object({
  param: z.string().describe("Description"),
});

export function execute(input: z.infer<typeof mySchema>): FeatureResult {
  return {
    success: true,
    message: `Résultat: ${input.param}`,
  };
}

export const myFeature: Feature<typeof mySchema> = {
  name: "my-feature",
  description: "Ma feature",
  schema: mySchema,
  execute,
};
```

2. L'ajouter dans `src/features/index.ts` :

```typescript
import { myFeature } from "./ma-feature";

export const features: Feature[] = [
  // ...
  myFeature,
];
```

La feature sera automatiquement disponible comme **outil MCP** et **commande CLI**.

## Structure

```
src/
├── bin.ts              # Point d'entrée CLI
├── index.ts            # Point d'entrée serveur MCP
├── server.ts           # Configuration serveur
├── features/           # Logique métier partagée
├── tools/              # Adaptateur MCP
├── cli/                # Adaptateur CLI
├── resources/          # Ressources MCP
├── prompts/            # Prompts MCP
├── config/             # Configuration
├── types/              # Types TypeScript
└── utils/              # Utilitaires
```

## License

MIT
