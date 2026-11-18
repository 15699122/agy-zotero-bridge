import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const MODULE_FILES = [
  'src/security/redact.mjs',
  'src/config.mjs',
  'src/protocol/event-mapper.mjs',
  'src/context/prompt-builder.mjs',
  'src/mcp/stdio-http-proxy.mjs',
  'src/mcp/zotero-mcp.mjs',
  'src/agy/cli-probe.mjs',
  'src/agy/process-pool.mjs',
  'src/agy/process-runner.mjs',
  'src/embedding/embedding-service.mjs',
  'src/session/session-store.mjs',
  'src/http/server.mjs',
  'src/claude-sdk/cli-shim.mjs'
];

function build() {
  const nodeImports = new Map();
  const moduleBodies = [];

  for (const relPath of MODULE_FILES) {
    const fullPath = resolve(REPO_ROOT, relPath);
    let content = readFileSync(fullPath, 'utf8');

    // Strip inner shebangs if any
    content = content.replace(/^#!\/usr\/bin\/env node\r?\n/, '');

    // Replace module-specific import.meta.url assumptions
    if (relPath === 'src/mcp/zotero-mcp.mjs') {
      content = content.replace(
        /const PROXY_SCRIPT_PATH = fileURLToPath\(new URL\('\.\/stdio-http-proxy\.mjs', import\.meta\.url\)\);/,
        '// PROXY_SCRIPT_PATH replaced in bundle\nconst PROXY_SCRIPT_PATH = process.argv[1] || fileURLToPath(import.meta.url);'
      );
      content = content.replace(
        /args: \[PROXY_SCRIPT_PATH, '--server', name, '--headers-file', headersFile\],/,
        "args: [PROXY_SCRIPT_PATH, '--proxy-mcp', '--server', name, '--headers-file', headersFile],"
      );
    }
    if (relPath === 'src/claude-sdk/cli-shim.mjs') {
      content = content.replace(
        /const REPO_ROOT = resolve\(fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)\);/,
        '// REPO_ROOT replaced in bundle\nconst REPO_ROOT = dirname(process.argv[1] || fileURLToPath(import.meta.url));'
      );
    }
    if (relPath === 'src/mcp/stdio-http-proxy.mjs') {
      // Remove trailing standalone runner in stdio-http-proxy because it will be dispatched via --proxy-mcp
      content = content.replace(/const isMain = process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href;\s*if\s*\(isMain\)\s*\{\s*await runProxy\(\);\s*\}/, '// Standalone proxy runner dispatched in bundle entry');
    }

    const lines = content.split(/\r?\n/);
    const bodyLines = [];
    let inImport = false;
    let importBuffer = '';

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();

      if (trimmed.startsWith('import ') || inImport) {
        inImport = true;
        importBuffer += ' ' + trimmed;
        if (line.includes(';')) {
          inImport = false;
          const fullImport = importBuffer.trim();
          importBuffer = '';

          // Check if this is a node: import
          const nodeMatch = fullImport.match(/import\s+(?:\{([^}]+)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"]node:([^'"]+)['"]/);
          if (nodeMatch) {
            const mod = nodeMatch[4];
            if (!nodeImports.has(mod)) nodeImports.set(mod, new Set());
            if (nodeMatch[1]) {
              for (const sym of nodeMatch[1].split(',')) {
                const s = sym.trim();
                if (s) nodeImports.get(mod).add(s);
              }
            }
          }
        }
        continue;
      }

      // De-duplicate top-level helper functions across files
      if (trimmed === 'const str = (v) => (typeof v === \'string\' ? v : \'\');' && relPath !== 'src/protocol/event-mapper.mjs') {
        bodyLines.push('// Duplicate helper omitted: str');
        continue;
      }
      if (trimmed === 'const record = (v) => (v && typeof v === \'object\' && !Array.isArray(v) ? v : {});' && relPath !== 'src/protocol/event-mapper.mjs') {
        bodyLines.push('// Duplicate helper omitted: record');
        continue;
      }

      // Strip export keywords
      const stripped = line.replace(/^export\s+(const|let|var|function|class|async\s+function)\b/, '$1');
      bodyLines.push(stripped);
    }

    moduleBodies.push(`// ==========================================================================\n// Module: ${relPath}\n// ==========================================================================\n${bodyLines.join('\n')}`);
  }

  // Format node imports
  const headerImportLines = [];
  for (const [mod, syms] of [...nodeImports.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...syms].sort();
    headerImportLines.push(`import { ${sorted.join(', ')} } from 'node:${mod}';`);
  }

  const bundle = `#!/usr/bin/env node
/**
 * agy-zotero-bridge (Single-file release bundle)
 * Standalone Claude Code CLI / SDK shim + managed bridge server for llm-for-zotero.
 * Node.js 20+, zero external dependencies.
 *
 * Repository: https://github.com/15699122/agy-zotero-bridge
 */

${headerImportLines.join('\n')}

${moduleBodies.join('\n\n')}

// ==========================================================================
// Entrypoint Dispatcher
// ==========================================================================
export {
  BRIDGE_VERSION,
  CliProbe,
  EmbeddingService,
  SessionProcessPool,
  SessionStore,
  compactRuntimeContext,
  computeLocalSemanticEmbedding,
  cosineSimilarity,
  createBridgeApp,
  createConfig,
  ensureWindowsClaudeCmdShim,
  extractPaperScopeManifest,
  extractSdkUserImageBlocks,
  materializeTurnImages,
  parseClaudeShimArgs,
  parseImageDataUrl,
  runClaudeCodeAgyShim,
  startBridgeServer,
  validateImageBuffer
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const argv = process.argv.slice(2);

  // 1. Internal stdio MCP proxy dispatch (used by agy session-settings / .agents mcp_config.json)
  if (argv[0] === '--proxy-mcp') {
    process.argv.splice(2, 1);
    await runProxy();
  }
  // 2. Explicit HTTP Bridge server invocation (--bridge or --host or --port)
  else if (argv.includes('--bridge') || argv.some((a) => a === '--host' || a.startsWith('--host=') || a === '--port' || a.startsWith('--port='))) {
    const bridgeArgs = argv.filter((a) => a !== '--bridge');
    const config = createConfig(process.env, bridgeArgs);
    delete process.env.ADAPTER_AUTH_TOKEN;

    const { server } = await startBridgeServer(config);
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    console.log(
      \`[agy-bridge] listening on http://\${config.host}:\${port}\${config.token ? '/[REDACTED_TOKEN]' : ''}\`
    );
    console.log(
      \`CLAUDE_BRIDGE_READY \${JSON.stringify({
        host: config.host,
        port,
        version: config.bridgeVersion,
        runtimeCwd: config.root,
        stateDir: dirname(config.stateFile)
      })}\`
    );

    const onShutdown = async (signal) => {
      console.log(\`[agy-bridge] received \${signal}, closing server...\`);
      server.close(() => process.exit(0));
    };
    process.on('SIGINT', () => onShutdown('SIGINT'));
    process.on('SIGTERM', () => onShutdown('SIGTERM'));

    if (config.exitOnStdinClose) {
      process.stdin.resume();
      process.stdin.on('end', () => {
        console.log('[agy-bridge] stdin closed, terminating');
        process.exit(0);
      });
      process.stdin.on('close', () => {
        console.log('[agy-bridge] stdin closed, terminating');
        process.exit(0);
      });
    }
  }
  // 3. Default: Claude Code CLI / SDK stream-json shim (for Zotero "Claude Code path")
  else {
    const code = await runClaudeCodeAgyShim({ argv });
    if (typeof code === 'number' && code !== 0) {
      process.exit(code);
    }
  }
}
`;

  const distDir = resolve(REPO_ROOT, 'dist');
  mkdirSync(distDir, { recursive: true });
  const outPath = resolve(distDir, 'agy-zotero-bridge.mjs');
  writeFileSync(outPath, bundle, 'utf8');
  console.log(`[build] Successfully generated single-file bundle: ${outPath} (${Buffer.byteLength(bundle)} bytes)`);
}

build();
