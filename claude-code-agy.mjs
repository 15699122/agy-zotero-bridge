#!/usr/bin/env node
import { runClaudeCodeAgyShim } from './src/claude-sdk/cli-shim.mjs';

const code = await runClaudeCodeAgyShim();
if (typeof code === 'number' && code !== 0) {
  process.exit(code);
}
