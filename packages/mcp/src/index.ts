// Lane C. MCP server generated from the ops registry, served from the engine's runOp.
export const OWNER_LANE = 'C' as const;
export { type FixtureDemo, type OpenedEngine, offlineServices, openFixtureDemo } from './engine.js';
export { createPpMcpServer, type PpMcpServerOptions, SERVER_NAME, SERVER_VERSION } from './server.js';
export {
  buildTool,
  buildTools,
  CONFIDENCE_ARG,
  DEFAULT_TOOL_NAME_STYLE,
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
