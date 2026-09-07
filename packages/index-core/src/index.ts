export { CodeIndex, normalizeRelativePath } from "./code-index.js";
export {
  CodeIndexValidationError,
  createIndexSchemaSql,
  createSymbolGraphSchemaSql,
  indexApplicationId,
  indexSchemaVersion,
  symbolGraphSchemaVersion,
  validateIndexDatabase
} from "./schema.js";
export type {
  IndexHover,
  IndexLocation,
  IndexPosition,
  IndexRange,
  IndexStatistics,
  SqlDatabase,
  SqlRow,
  SqlValue
} from "./types.js";
