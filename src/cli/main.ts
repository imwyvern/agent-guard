#!/usr/bin/env node
import { runCLI } from './commands.js';
process.exitCode = runCLI(process.argv.slice(2));
