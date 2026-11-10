import { spawn } from 'node:child_process';
import { existsSync, openSync, closeSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDemo, demoConfig, realPaths } from '../examples/shared/site.js';
import { socketFallback } from '../examples/shared/loopback.js';
import { median, isMain, save, report } from './common.js';
interface Scores {
    performance: number;
    accessibility: number;
    'best-practices': number;
    seo: number;
    lcp: number;
    tbt: number;
    cls: number;
}
export function lighthouseGate(delta: Scores): boolean { return ['performance', 'accessibility', 'best-practices', 'seo'].every(k => Math.abs(delta[k as keyof Scores]) <= 2) && Math.abs(delta.lcp) <= 100 && Math.abs(delta.tbt) <= 50 && delta.cls === 0; }
async function execute(args: string[], file: string, timeout = 600000): Promise<{ status: number | null; error?: Error }> {
    const fd = openSync(file, 'w');
    try {
        return await new Promise(resolve => {
            const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', fd, fd], timeout });
            child.once('error', error => resolve({ status: null, error }));
            child.once('exit', status => resolve({ status }));
        });
    } finally { closeSync(fd); }
}
export async function lighthouse() {
    mkdirSync('bench/results', { recursive: true });
    const chrome = '/usr/bin/google-chrome';
    const flags = ['--headless', '--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions', '--no-first-run', '--no-default-browser-check', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--user-data-dir=/tmp/agent-guard-lighthouse'];
    let reason: string | undefined;
    if (!existsSync(chrome))
        reason = 'Chrome unavailable';
    else {
        const probe = await execute([chrome, ...flags, '--dump-dom', 'about:blank'], 'bench/results/chrome-probe.log', 15000);
        if (probe.status !== 0 || probe.error)
            reason = 'Chrome cannot start in sandbox: ' + readFileSync('bench/results/chrome-probe.log', 'utf8').trim();
    }
    if (reason) {
        const result = { status: 'skipped', reason };
        save('lighthouse', result);
        return result;
    }
    const comparisons = [];
    for (const kind of ['express', 'node'] as const) {
        const on = await startDemo(kind, demoConfig({ log: { sink: () => { } }, alerts: { adapters: [] } })), off = await startDemo(kind, false);
        try {
            if (socketFallback) {
                const result = { status: 'skipped', reason: 'Local TCP listeners unavailable (EPERM); Lighthouse cannot reach an in-process endpoint' };
                save('lighthouse', result);
                return result;
            }
            for (const form of ['desktop', 'mobile']) {
                const scores: Record<string, Record<string, Scores>> = {};
                for (const mode of ['off', 'on'] as const) {
                    const url = mode === 'on' ? on.url : off.url;
                    const configuration = 'bench/results/lhci-config.json';
                    const chromeFlags = flags.filter(flag => !flag.startsWith('--user-data-dir=')).map(flag => {
                        const equal = flag.indexOf('=');
                        return flag.includes(' ') && equal >= 0 ? flag.slice(0, equal + 1) + JSON.stringify(flag.slice(equal + 1)) : flag;
                    }).join(' ');
                    writeFileSync(configuration, JSON.stringify({ ci: { collect: {
                        url: realPaths.map(path => url + path), numberOfRuns: 5, chromePath: chrome,
                        settings: { chromeFlags, onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
                            blockedUrlPatterns: ['https://*'], ...(form === 'desktop' ? { preset: 'desktop' } : { formFactor: 'mobile' }) }
                    } } }));
                    // Async child execution keeps the local demo event loop available to Chrome.
                    rmSync('.lighthouseci', { recursive: true, force: true });
                    const result = await execute([process.execPath, 'node_modules/@lhci/cli/src/cli.js', 'collect', '--config=' + configuration], `bench/results/lhci-${kind}-${form}-${mode}.log`);
                    if (result.status !== 0 || result.error)
                        throw new Error('LHCI collect failed; see bench/results logs');
                    const reports = readdirSync('.lighthouseci').filter(f => f.endsWith('.json') && f !== 'manifest.json').map(f => JSON.parse(readFileSync(resolve('.lighthouseci', f), 'utf8')) as {
                        requestedUrl: string;
                        categories: Record<string, {
                            score: number;
                        }>;
                        audits: Record<string, {
                            numericValue: number;
                        }>;
                    });
                    scores[mode] = {};
                    for (const path of realPaths) {
                        const requestedUrl = new URL(path, url).href;
                        const selected = reports.filter(r => new URL(r.requestedUrl).href === requestedUrl);
                        if (selected.length !== 5)
                            throw new Error('expected five Lighthouse reports per URL');
                        scores[mode][path] = Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo', 'lcp', 'tbt', 'cls'].map(key => [key, median(selected.map(r => key === 'lcp' ? r.audits['largest-contentful-paint']!.numericValue : key === 'tbt' ? r.audits['total-blocking-time']!.numericValue : key === 'cls' ? r.audits['cumulative-layout-shift']!.numericValue : r.categories[key]!.score * 100))])) as unknown as Scores;
                    }
                }
                for (const path of realPaths) {
                    const a = scores.off![path]!, b = scores.on![path]!, delta = Object.fromEntries(Object.keys(a).map(k => [k, b[k as keyof Scores] - a[k as keyof Scores]])) as unknown as Scores;
                    comparisons.push({ demo: kind, form, path, off: a, on: b, delta, passed: lighthouseGate(delta) });
                }
            }
        }
        finally {
            await on.close();
            await off.close();
        }
    }
    const result = { status: comparisons.every(c => c.passed) ? 'passed' : 'failed', comparisons };
    save('lighthouse', result);
    return result;
}
if (isMain(import.meta.url)) {
    const result = await lighthouse();
    console.log(JSON.stringify(result, null, 2));
    report();
    if (result.status === 'failed')
        process.exitCode = 1;
}
