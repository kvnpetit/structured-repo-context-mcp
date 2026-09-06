/**
 * Core utilities barrel export
 */

// Asset directory utilities
export {
  assetExists,
  clearAssetsDirCache,
  getAssetPath,
  getAssetsDir,
  loadJsonConfig,
} from "./assets";

// Cache management
export {
  clearAllCaches,
  clearCache,
  getRegisteredCaches,
  registerCache,
  unregisterCache,
  type CacheClearFn,
} from "./cache";

// Small local state files
export { writeJsonAtomically, writeTextAtomically } from "./atomic";
export { withProcessFileLock, type ProcessLockOptions } from "./process-lock";
export { truncateUtf8, truncateUtf8WithStatus } from "./utf8";

// TSConfig utilities
export {
  clearPathAliasCache,
  readPathAliases,
  readPathAliasesCached,
  type PathAliases,
} from "./tsconfig";
