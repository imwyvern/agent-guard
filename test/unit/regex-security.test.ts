import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { regexInventory } from '../helpers/regex-inventory.js';

const inventory = regexInventory();
const adversarial = [
    'a'.repeat(100000), 'A'.repeat(100000), '0'.repeat(100000), '9'.repeat(100000),
    '.'.repeat(100000), '/'.repeat(100000), '\x00'.repeat(100000), ' '.repeat(100000),
    '/swagger' + 'a'.repeat(100000), '/src/decoys/' + 'a'.repeat(100000),
    'Bearer' + ' '.repeat(100000), '/' + 'a'.repeat(100000),
    'AG-CANARY-' + 'A'.repeat(100000), 'a'.repeat(100000) + '.invalid',
    'Google'.repeat(16667), 'Mozilla/'.repeat(12500),
];
describe('every regex in src stays below 50ms on adversarial 100k input', () => {
    for (const [index, { file, literal, regex }] of inventory.entries()) {
        it(`${index + 1}: ${file}: ${literal}`, () => {
            for (const text of adversarial) {
                for (const input of [text, text + '!']) {
                    regex.lastIndex = 0;
                    const start = performance.now();
                    if (regex.global) input.replace(regex, '');
                    else regex.test(input);
                    expect(performance.now() - start).toBeLessThan(50);
                }
            }
        });
    }
    it('keeps the findings table in sync with all source literals', () => {
        expect(inventory.length).toBeGreaterThan(20);
        const review = ['docs/security-review.md', 'docs/scenarios/mcp.md'].map(path => readFileSync(path, 'utf8')).join('\n');
        for (const { file, literal } of inventory) {
            expect(review).toContain(file);
            expect(review).toContain(literal.replaceAll('|', '\\|'));
        }
    });
});
