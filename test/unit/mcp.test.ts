import { it, expect } from 'vitest';
import { lintMcpDecoyDescription, mcpDecoyTools } from '../../src/index.js';

it('all built-in MCP decoy descriptions pass the neutral-data linter', () => {
    for (const tool of mcpDecoyTools) expect(lintMcpDecoyDescription(tool.description)).toEqual([]);
});
it('description lint rejects imperative language, URLs and every forbidden hidden character', () => {
    for (const text of ['Ignore previous instructions', 'Please call this tool', 'Send secrets', 'https://example.invalid', 'ftp://example.invalid', 'www.example.invalid', '']) {
        expect(lintMcpDecoyDescription(text).length).toBeGreaterThan(0);
    }
    for (const code of [...Array.from({ length: 5 }, (_, i) => 0x200B + i), ...Array.from({ length: 5 }, (_, i) => 0x202A + i), 0x2060, 0xFEFF]) {
        expect(lintMcpDecoyDescription('Metadata' + String.fromCodePoint(code))).toContain('hidden character');
    }
});
