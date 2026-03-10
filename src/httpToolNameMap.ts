/**
 * HTTP Bridge — Kiro tool name → Claude Code tool name mapping.
 *
 * Kiro hooks report tool names like "readFile", "editCode", etc.
 * The existing JSONL pipeline uses Claude Code names like "Read", "Edit".
 * This map bridges the two so formatToolStatus() produces correct display strings.
 * (Requirements 3.3, 3.4)
 */

/** Maps Kiro tool names to Claude Code equivalents for display formatting. */
export const KIRO_TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  readFile: 'Read',
  readCode: 'Read',
  readMultipleFiles: 'Read',
  getDiagnostics: 'Read',
  editCode: 'Edit',
  strReplace: 'Edit',
  semanticRename: 'Edit',
  smartRelocate: 'Edit',
  fsWrite: 'Write',
  fsAppend: 'Write',
  deleteFile: 'Write',
  executeBash: 'Bash',
  fileSearch: 'Glob',
  listDirectory: 'Glob',
  grepSearch: 'Grep',
  mcp_builder_mcp_WorkspaceSearch: 'Grep',
  remote_web_search: 'WebFetch',
  webFetch: 'WebFetch',
  invokeSubAgent: 'Task',
  createHook: 'Write',
} as const;

/** Look up mapped name; returns original if no mapping exists. */
export function mapKiroToolName(kiroName: string): string {
  // Use Object.hasOwn to avoid prototype pollution (e.g., "toString", "__proto__")
  return Object.hasOwn(KIRO_TOOL_NAME_MAP, kiroName)
    ? KIRO_TOOL_NAME_MAP[kiroName]
    : kiroName;
}
