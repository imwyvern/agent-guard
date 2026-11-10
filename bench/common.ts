import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import { pathToFileURL } from 'node:url';
export function quantile(values: number[], q: number): number { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0; }
export function median(values: number[]): number { return quantile(values, .5); }
export function isMain(url: string): boolean { return !!process.argv[1] && url === pathToFileURL(process.argv[1]).href; }
export function save(name: string, result: unknown): void { mkdirSync('bench/results', { recursive: true }); writeFileSync(`bench/results/${name}.json`, JSON.stringify(result, null, 2) + '\n'); }
export function report(): void {
    const sections = ['simulate', 'latency', 'lighthouse'].map(name => existsSync(`bench/results/${name}.json`) ? [name, JSON.parse(readFileSync(`bench/results/${name}.json`, 'utf8')) as unknown] : [name, { status: 'not run' }]);
    writeFileSync('docs/bench-v0.1.md', `# agent-guard v0.1 local benchmark\n\nGenerated ${new Date().toISOString()}. Node ${process.version}; ${platform()} ${release()} ${arch()}; ${cpus()[0]?.model}; ${cpus().length} logical CPUs.\n\nAll requests target local demo listeners and a local signed webhook receiver; DNS is injected. No external sites are contacted. Raw results: bench/results/ (ignored). Medians use three runs.\n\n` + sections.map(([name, result]) => `## ${name}\n\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\`\n`).join('\n'));
}
