/**
 * Standalone & managed agy headless bridge for llm-for-zotero.
 * Node 20+, zero third-party runtime dependencies.
 */
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConfig } from './src/config.mjs';
import { startBridgeServer } from './src/http/server.mjs';

export { createConfig, startBridgeServer };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const config = createConfig(process.env, process.argv.slice(2));
  delete process.env.ADAPTER_AUTH_TOKEN;

  const { server } = await startBridgeServer(config);
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  console.log(
    `[agy-bridge] listening on http://${config.host}:${port}${config.token ? '/[REDACTED_TOKEN]' : ''}`
  );
  console.log(
    `CLAUDE_BRIDGE_READY ${JSON.stringify({
      host: config.host,
      port,
      version: config.bridgeVersion,
      runtimeCwd: config.root,
      stateDir: dirname(config.stateFile)
    })}`
  );

  if (config.exitOnStdinClose) {
    let shuttingDown = false;
    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      const forceExit = setTimeout(() => process.exit(0), 3000);
      forceExit.unref();
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
  }
}
