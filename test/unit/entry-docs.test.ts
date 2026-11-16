import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

const readmes = ['README.md', ...['zh-CN', 'zh-TW', 'ja', 'ko', 'es'].map(locale => `docs/i18n/README.${locale}.md`)];
const blocks = (text: string) => text.match(/```[^\n]*\n[\s\S]*?```/g) ?? [];
it.each(readmes)('%s keeps identical executable examples and resolving relative file links', path => {
    const text = readFileSync(path, 'utf8');
    expect(blocks(text)).toEqual(blocks(readFileSync('README.md', 'utf8')));
    expect(text).toContain('Zero-code entry points (unreleased)');
    const prose = text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
    for (const match of prose.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!.split('#')[0]!;
        if (!target || /^[a-z]+:/i.test(target)) continue;
        expect(existsSync(resolve(dirname(path), decodeURIComponent(target)))).toBe(true);
    }
});
