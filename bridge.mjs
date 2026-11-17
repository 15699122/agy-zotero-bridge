/**
 * Standalone agy headless bridge for llm-for-zotero's 'Use my own bridge'.
 * Node 20+, zero third-party runtime dependencies.
 */
import { pathToFileURL } from 'node:url';
import { createConfig } from './src/config.mjs';
import { startBridgeServer } from './src/http/server.mjs';

export { createConfig, startBridgeServer };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = createConfig(process.env);
  const { server } = await startBridgeServer(config);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  console.log(
    `[agy-bridge] listening on http://${config.host}:${port}${config.token ? '/[REDACTED_TOKEN]' : ''}`
  );
}
