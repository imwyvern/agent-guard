import type { AgentGuardConfig, AGResponse } from '../types.js';
import { decoyHeaders } from '../decoys/headers.js';

export class WebTrap {
    private manual = true;
    private circuit = false;
    private nextCheck = 0;
    private readonly pending = new Set<() => void>();
    constructor(private readonly config: AgentGuardConfig) {}
    get enabled(): boolean { return this.config.mode === 'trap' && this.manual && !this.circuit; }
    get delayed(): number { return this.pending.size; }
    setEnabled(enabled: boolean): void {
        this.manual = enabled;
        if (enabled) { this.circuit = false; this.nextCheck = Date.now() + 250; }
        else for (const finish of this.pending) finish();
    }
    checkCircuit(p99: () => number): boolean {
        if (!this.enabled || Date.now() < this.nextCheck) return false;
        this.nextCheck = Date.now() + 250;
        if (p99() <= (this.config.trap?.circuit?.inspectP99Ns ?? 5e9)) return false;
        this.circuit = true;
        for (const finish of this.pending) finish();
        return true;
    }
    async delay(): Promise<void> {
        const options = this.config.trap?.delay;
        if (!this.enabled || options?.enabled !== true || this.pending.size >= (options.maxConcurrent ?? 20)) return;
        const ms = Math.min(options.ms ?? 1000, 3000);
        if (!ms) return;
        await new Promise<void>(resolve => {
            const finish = (): void => { clearTimeout(timer); this.pending.delete(finish); resolve(); };
            const timer = setTimeout(finish, ms);
            this.pending.add(finish);
        });
    }
}
export function trapResponse(status: 403 | 429, head = false): AGResponse {
    return { status, headers: decoyHeaders('text/plain'), body: head ? '' : status === 403 ? 'Forbidden\n' : 'Too Many Requests\n' };
}
export function notFound(head = false): AGResponse {
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: head ? '' : 'Not Found\n' };
}
