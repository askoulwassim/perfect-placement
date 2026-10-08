// Lane C. MCP server generated from the ops registry; inject `runOp` (lane B) to use it.
export const OWNER_LANE = 'C' as const;
export { createPpMcpServer, type PpMcpServerOptions, SERVER_NAME, SERVER_VERSION } from './server.js';
export {
  buildTool,
  buildTools,
  META_KEY,
  type OpToolMeta,
  outcomeToToolResult,
  policyNotes,
  type ToolNameStyle,
  toolInputSchema,
  toolMeta,
  toolNameFor,
  toolNameMap,
} from './tools.js';
export { createMcpHttpHandler, type HttpOptions, type StartedHttpServer, serveStdio, startMcpHttpServer } from './transports.js';
