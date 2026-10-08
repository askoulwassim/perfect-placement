// Stand-in for `@openuidev/devtools` (aliased in apps/web/vite.config.ts). react-lang auto-mounts the
// Inspect widget in development and that widget loads from a CDN; we never ship or fetch it.
export const OpenUIDevtools = () => null;
export default { OpenUIDevtools };
