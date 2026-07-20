/** Shape every tool handler returns; matches what `server.registerTool`'s callback expects. */
export interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: true;
}
