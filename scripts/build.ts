import { build } from 'tsup';
import configs from '../tsup.config.js';

if (!Array.isArray(configs)) throw new Error('Expected Node and neutral tsup configs');
// tsup runs config arrays concurrently; Node's declaration cleanup must finish first.
for (const options of configs) await build({ ...options, config: false });
