#!/usr/bin/env node
import { runCLI } from './commands.js';
import { runProxy } from './proxy.js';
const args = process.argv.slice(2);
if (args[0] === 'proxy') void runProxy(args.slice(1)).then(code => { process.exitCode = code; });
else process.exitCode = runCLI(args);
