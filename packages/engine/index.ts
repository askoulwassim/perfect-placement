// Engine public surface. Each area is owned by one lane (see its README); ops/ wires them together.
export * as db from './db/index.js';
export * as freshness from './freshness/index.js';
export * as ats from './integrations/ats/index.js';
export * as gmail from './integrations/gmail/index.js';
export * as linkedin from './integrations/linkedin/index.js';
export * as ops from './ops/index.js';
/** The engine factory every surface calls (pp CLI, `pp up`, MCP, schedules). */
export { createEngine, type Engine, type EngineServices, type OpenEngineOptions, openEngine } from './ops/index.js';
export * as people from './people/index.js';
export * as profile from './profile/index.js';
export * as scoring from './scoring/index.js';
export * as status from './status/index.js';
