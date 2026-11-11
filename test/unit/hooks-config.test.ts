import { expect, it } from 'vitest';
import { AgentGuardConfigError, validateConfig } from '../../src/config.js';
import { HookRunner } from '../../src/hooks/runner.js';
import type { AgentGuardConfig, ResponseHook } from '../../src/types.js';
import { config } from '../helpers.js';

const hook: ResponseHook = { on: 'canary_replay', run: ['/usr/bin/operator-hook'] };

it.each([undefined, [], [hook], [{ ...hook, run: ['/opt/a path/hook', '', ';', '`literal`', '$(literal)', '\n'] }]])('accepts disabled hooks and literal configured argv: %j', hooks => {
    expect(() => validateConfig(config({ hooks: hooks as AgentGuardConfig['hooks'] }))).not.toThrow();
});

it.each([null, {}, 'hook', Array.from({ length: 33 }, () => hook), [null], [1], [{}], [{ ...hook, on: 'probe' }], [{ ...hook, on: undefined }]])('rejects invalid hook collections/triggers: %j', hooks => {
    expect(() => validateConfig(config({ hooks: hooks as AgentGuardConfig['hooks'] }))).toThrow(AgentGuardConfigError);
});

it.each([undefined, null, 'command', [], [''], ['relative'], ['bin/hook'], ['/'], ['//bin/hook'], ['/usr//bin/hook'], ['/usr/bin/'], ['/bin/nu\0l'], ['/bin/hook', 1], ['/bin/hook', '\0'], Array(2)])('rejects invalid argv: %j', run => {
    const hooks = [{ ...hook, run }] as AgentGuardConfig['hooks'];
    expect(() => validateConfig(config({ hooks }))).toThrow(AgentGuardConfigError);
    expect(() => new HookRunner(hooks, () => {})).toThrow(AgentGuardConfigError);
});

it.each([
    ['timeoutMs', 1, 60000], ['maxPerHour', 1, 100], ['maxConcurrent', 1, 8],
] as const)('validates conservative safe-integer bounds for %s', (name, minimum, maximum) => {
    for (const value of [minimum, maximum]) expect(() => validateConfig(config({ hooks: [{ ...hook, [name]: value }] }))).not.toThrow();
    for (const value of [minimum - 1, maximum + 1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', null])
        expect(() => validateConfig(config({ hooks: [{ ...hook, [name]: value }] }))).toThrow(AgentGuardConfigError);
});

it.each(['incident_high', 'canary_replay', 'honeyfile_read'] as const)('accepts the %s trigger', on => {
    expect(() => validateConfig(config({ hooks: [{ ...hook, on }] }))).not.toThrow();
});
