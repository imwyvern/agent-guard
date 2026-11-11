import type { AgentGuardConfig } from '../../src/index.js';
import { config } from '../helpers.js';

export function mazeConfig(maze: NonNullable<NonNullable<AgentGuardConfig['trap']>['maze']> = {}): AgentGuardConfig {
    return config({ mode: 'trap', trap: { maze: { enabled: true, ...maze } } });
}
export function entryFrom(body: string): string {
    const match = /^ARCHIVE_INDEX=(.+)$/m.exec(body);
    if (!match) throw new Error('expected maze entry in D1');
    return match[1]!;
}
export function mazeLinks(body: string): string[] {
    return [...body.matchAll(/href="([^"]+)"/g)].map(match => match[1]!);
}
