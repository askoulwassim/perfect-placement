// Browser stand-in for node:url. Only fixtures' FIXTURE_VAULT_DIR uses it; the UI never reads that path.
export const fileURLToPath = (u: string | URL): string => String(u);
export default { fileURLToPath };
