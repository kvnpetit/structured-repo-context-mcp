// Point d'entrée principal - démarre le serveur MCP directement
import { startServer } from "./server";

startServer().catch(console.error);
