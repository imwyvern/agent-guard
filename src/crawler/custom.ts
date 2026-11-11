import type { AgentGuardConfig } from '../types.js';

export async function customCrawlerVerify(options: NonNullable<AgentGuardConfig['crawler']>, ip: string, ua: string): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            Promise.resolve().then(() => options.customVerify!(ip, ua)),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('crawler verification timeout')), options.timeoutMs ?? 300); }),
        ]);
    }
    catch { return options.failOpen !== false; }
    finally { clearTimeout(timer); }
}
