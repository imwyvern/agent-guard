import { writeFileSync } from 'node:fs';
import { cpus, platform, release, arch } from 'node:os';
import { isMain, save } from './common.js';
import { MazeModel, MAZE_DEFAULTS, type MazeSession, type StopReason } from './lib/maze-model.js';
import { deceptionLint } from './deception-lint.js';

const seed = 'agent-guard-v0.3b-20261110';
const models = ['depth-first', 'breadth-first', 'random-walk', 'abandon-on-repeat', 'abandon-on-budget-exhaustion'] as const;
type AgentModel = typeof models[number];
const sessionsPerModel = 200;
const requestOverheadMs = 25;
const processingBytesPerSecond = 128 * 1024;
function randomSource(initial: number) {
    let state = initial;
    return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
function distribution(steps: number[]) {
    const sorted = [...steps].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]!;
    return { min: sorted[0]!, p50: at(.5), p95: at(.95), max: sorted.at(-1)!,
        histogram: Object.fromEntries([...new Set(sorted)].map(n => [n, sorted.filter(step => step === n).length])) };
}
interface Agent {
    session: MazeSession;
    frontier: string[];
    seen: Set<string>;
    random: () => number;
    steps: number;
    simulatedMs: number;
    done: boolean;
}

function simulateModel(name: AgentModel) {
    const maze = new MazeModel(seed);
    let hostCpuNs = 0n, requests = 0, requestBytes = 0, receivedBytes = 0, simulatedMs = 0;
    const steps: number[] = [], sessionResults: Array<{ steps: number; simulatedMs: number; reason: string }> = [];
    const reasons: Partial<Record<StopReason | 'repeat' | 'frontier-empty', number>> = {};
    // hrtime brackets only synchronous host model operations, excluding agent work.
    const host = <T>(fn: () => T): T => {
        const start = process.hrtime.bigint();
        try { return fn(); } finally { hostCpuNs += process.hrtime.bigint() - start; }
    };
    for (let offset = 0; offset < sessionsPerModel; offset += MAZE_DEFAULTS.maxConcurrent) {
        const agents: Agent[] = Array.from({ length: MAZE_DEFAULTS.maxConcurrent }, (_, i) => ({
            session: host(() => maze.startSession()), frontier: [host(() => maze.entry)], seen: new Set<string>(),
            random: randomSource(20261110 + offset + i), steps: 0, simulatedMs: 0, done: false,
        }));
        const finish = (agent: Agent, reason: keyof typeof reasons) => {
            agent.done = true;
            steps.push(agent.steps);
            sessionResults.push({ steps: agent.steps, simulatedMs: agent.simulatedMs, reason });
            reasons[reason] = (reasons[reason] ?? 0) + 1;
            host(() => maze.endSession(agent.session));
        };
        while (agents.some(agent => !agent.done)) {
            let roundMs = 0;
            for (const agent of agents) {
                if (agent.done) continue;
                const path = name === 'depth-first' ? agent.frontier.pop() : agent.frontier.shift();
                if (!path) { finish(agent, 'frontier-empty'); continue; }
                agent.steps++;
                requests++;
                requestBytes += Buffer.byteLength(`GET ${path} HTTP/1.1\r\n\r\n`);
                const response = host(() => maze.visit(agent.session, path));
                const bytes = Buffer.byteLength(response.body);
                receivedBytes += bytes;
                const elapsed = requestOverheadMs + bytes / processingBytesPerSecond * 1000;
                agent.simulatedMs += elapsed;
                simulatedMs += elapsed;
                roundMs = Math.max(roundMs, elapsed);
                if (response.kind === 'stop') { finish(agent, response.reason!); continue; }
                if (name === 'abandon-on-repeat' && agent.seen.has(path)) { finish(agent, 'repeat'); continue; }
                agent.seen.add(path);
                if (name === 'random-walk' || name === 'abandon-on-repeat') {
                    agent.frontier = [response.links[Math.floor(agent.random() * response.links.length)]!];
                } else if (name === 'abandon-on-budget-exhaustion') {
                    // Deliberately tolerate repeats: poll the root until a budget stops it.
                    agent.frontier = [response.links.at(-1)!];
                } else {
                    const fresh = response.links.filter(link => !agent.seen.has(link));
                    agent.frontier.push(...(name === 'depth-first' ? fresh.reverse() : fresh));
                }
            }
            host(() => maze.advance(roundMs));
        }
        // Cohort cooldown is simulated, excluded from opponent active time.
        host(() => maze.advance(60_000));
    }
    const cpuMs = Number(hostCpuNs) / 1e6;
    return { model: name, sessions: sessionsPerModel, opponent: { requests, requestBytes, receivedBytes, simulatedMs },
        host: { cpuNs: hostCpuNs.toString(), cpuMs, outboundBytes: receivedBytes, handledRequests: requests },
        costRatio: { time: simulatedMs / cpuMs, bytes: receivedBytes / receivedBytes, requests: requests / requests },
        abandonmentSteps: distribution(steps), abandonmentReasons: reasons, sessionResults, events: { ...maze.events },
        simulatedWallMs: maze.nowMs };
}

/** Separate deterministic fault probes; never mixed into agent cost measurements. */
function safetyProbes() {
    const admission = new MazeModel(seed);
    const sessions = Array.from({ length: 100 }, () => admission.startSession());
    const admitted = admission.activeSessions;
    const rejected = sessions.filter(session => admission.visit(session, admission.entry).reason === 'concurrency').length;
    const rate = new MazeModel(seed);
    let rateStops = 0, outboundBytes = 0;
    // No simulated clock advance: all responses land in the same rolling minute.
    for (let i = 0; i < 100; i++) {
        const session = rate.startSession();
        for (let page = 0; page <= MAZE_DEFAULTS.maxPages; page++) {
            const response = rate.visit(session, rate.entry);
            if (response.kind === 'stop') { if (response.reason === 'rate') rateStops++; break; }
            outboundBytes += Buffer.byteLength(response.body);
        }
        rate.endSession(session);
    }
    const duration = new MazeModel(seed);
    const expired = duration.startSession();
    duration.advance(MAZE_DEFAULTS.maxDurationMs);
    const durationStop = duration.visit(expired, duration.entry).reason;
    const breaker = ['inspect', 'event-loop'].map(signal => {
        const maze = new MazeModel(seed), session = maze.startSession();
        maze.injectOverload(signal === 'inspect' ? { inspectP99Ms: 2 } : { eventLoopDelayMs: 21 });
        maze.injectOverload({ inspectP99Ms: 10, eventLoopDelayMs: 100 });
        return { signal, reason: maze.visit(session, maze.entry).reason, events: { ...maze.events } };
    });
    return { concurrency: { offered: 100, admitted, rejected, events: admission.events },
        rate: { rateStops, outboundBytes, limit: MAZE_DEFAULTS.maxBytesPerMinute, events: rate.events },
        duration: { simulatedMs: duration.nowMs, reason: durationStop, events: duration.events }, breaker };
}
function hkt(date: Date): string { return new Date(date.getTime() + 8 * 3600_000).toISOString().replace('Z', '+08:00'); }

export function exhaustSim() {
    const start = new Date(), wallStart = process.hrtime.bigint();
    const runs = models.map(simulateModel);
    const probes = safetyProbes();
    const lint = deceptionLint();
    const end = new Date();
    const environment = { node: process.version, cpu: cpus()[0]?.model ?? 'unknown', logicalCpus: cpus().length, platform: platform(), release: release(), arch: arch() };
    const formulas = { time: 'sum(opponent simulated active milliseconds) / sum(host synchronous hrtime nanoseconds / 1e6)',
        bytes: 'opponent received body bytes / host outbound body bytes', requests: 'opponent requests / host handled requests' };
    const result = { seed, startedHkt: hkt(start), finishedHkt: hkt(end), wallSeconds: Number(process.hrtime.bigint() - wallStart) / 1e9,
        environment, limits: MAZE_DEFAULTS, formulas, assumptions: { requestOverheadMs, processingBytesPerSecond, cohortSize: 20, cooldownMs: 60_000 }, runs, probes, deceptionLint: lint };
    save('exhaust-sim', result);
    const table = runs.map(run => `| ${run.model} | ${run.opponent.requests} | ${run.opponent.requestBytes} / ${run.opponent.receivedBytes} | ${run.opponent.simulatedMs.toFixed(1)} | ${run.host.cpuMs.toFixed(3)} | ${run.costRatio.time.toFixed(2)}:1 | ${run.costRatio.bytes.toFixed(2)}:1 | ${run.abandonmentSteps.min}/${run.abandonmentSteps.p50}/${run.abandonmentSteps.p95}/${run.abandonmentSteps.max} | ${run.events.exhaust_budget_spent} | ${run.events.exhaust_circuit_open} |`).join('\n');
    writeFileSync('docs/bench-v0.3b.md', `# agent-guard v0.3b 离线评估\n\n开始：${result.startedHkt}；结束：${result.finishedHkt}（HKT / UTC+8）；wall time ${result.wallSeconds.toFixed(3)} s。\n\nNode ${environment.node}；CPU ${environment.cpu}；${environment.logicalCpus} logical CPUs；${environment.platform} ${environment.release} ${environment.arch}。\n\n## 方法与复现\n\n\`npm run bench:exhaust-sim\` 与 \`npm run bench:deception-lint\`；raw JSON：\`bench/results/exhaust-sim.json\`（gitignored）。固定 seed：\`${seed}\`。五种 scripted greedy agents，各 200 sessions；每组 20 会话 round-robin，组间推进模拟时钟 60 s。DFS 使用 stack、BFS 使用 queue，均跳过已访问节点；random-walk 均匀选择出链；abandon-on-repeat 在响应重复路径后退出；abandon-on-budget-exhaustion 反复访问入口直到 stop。所有模型在 stop 时结束，step 包含终止请求。JSON 保存完整 step histogram、每会话 steps/time/reason。\n\n每次请求假设固定 ${requestOverheadMs} ms 开销，加 body bytes / ${processingBytesPerSecond} bytes/s 的处理时间；这是人为设定的模拟值，不是 LLM token、真实请求延迟或计费数据。对方时间累加所有 session active time（并发时不是 wall time），不包含组间 cooldown。host time 用 \`process.hrtime.bigint()\` 包围同步模型创建会话、入口生成、visit、clock advance、结束会话；不计 agent 选择、JSON 和报告 I/O。它是同步 CPU 成本的 elapsed-time proxy，含调度/GC 噪声，不是操作系统 CPU accounting。无 warmup、单次测量，结果随机器变化。\n\n**脚本模型 agent 不等于真实 LLM agent。** 未测真实 agent 的逃逸率、可信度判断、token 成本、生产正常路径 p99 或误伤率；模型也未实现生产准入闸门。因此不能据此启用 E2 或推导生产防护有效性。纯内存，不建 TCP server，不访问网络、不实际 sleep、不改 src；mode 仍只接受 detect。\n\n## 成本比（cost ratio）\n\n时间比 = ${formulas.time}。字节比 = ${formulas.bytes}。请求比 = ${formulas.requests}。不同单位没有任意加权混成一个比值；request bytes 是合成 GET request-line 与空 headers 的 UTF-8 长度，received/outbound bytes 只计 body，不含实际 HTTP/TLS 开销。空 stop body 为 0 bytes。\n\n| Agent model（200 sessions 各） | Requests | Request / received bytes | Opponent simulated ms | Host CPU proxy ms | Time ratio | Byte ratio | Abandon steps min/p50/p95/max | Budget spent | Circuit opens |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |\n${table}\n\n请求比均为 1:1，host outbound bytes 等于 opponent received bytes。exhaust.md §6 目标 >10:1，低于 3:1 该级别不得启用。即使假设下的 time ratio 达标，**byte ratio 仍为 1:1，低于 3:1，E2 不应启用**。没有用模拟时间比掩盖带宽成本。\n\n## 边界与自保\n\n默认每会话 depth ≤6、pages ≤50、bytes ≤512 KiB、duration <600,000 simulated ms；访问第 7 层或再请求超过额度时 stop/404，每会话只计一次 exhaust_budget_spent。每页固定模板替换、8 子链接 + parent/root 共 10 出链，均 rel=nofollow；noindex/nofollow/no-store，无 cookie、外部 URL。入口仅存在 bench，未加入运行时路由/robots/lures。\n\n节点为截断 100-bit base32 HMAC(seed, parent|index|depth)，query trail 携带有界祖先索引以无状态重算校验；无节点表。伪造 MAC 在任何预算处理前拒绝，无页面/字节支出，也不增加 budget counter。session budget 本身有状态。全局并发 ≤20；出站为 rolling 60 s window ≤5 MiB（不是固定分钟桶）。断路器阈值 inspect p99 >1 ms 或 event-loop delay >20 ms，注入 telemetry 后永久关闭该模型实例，每次打开只计一次。正常 agent runs 不伪造 overload。\n\n独立 fault probes（不混入成本比）：100 会话同时申请，admitted ${probes.concurrency.admitted}、rejected ${probes.concurrency.rejected}；同一模拟分钟出站 ${probes.rate.outboundBytes} bytes（cap ${probes.rate.limit}），rate stop ${probes.rate.rateStops}；duration probe 在 ${probes.duration.simulatedMs} ms 返回 ${probes.duration.reason}。inspect 与 event-loop 两个 probe 各触发 1 次 exhaust_circuit_open，后续访问均 stop/circuit，重复 overload 不重复计数。这些是注入信号的功能验证，不是宿主实际压力测试。\n\n## Deception safety scan\n\n扫描结果：${lint.status}，${lint.samples} samples，${lint.violations.length} violations。只读调用现有 envBody、adminResponse、opsBody、openapiBody、fakeData、generateCanary 与 mcpDecoyTools，覆盖 D1–D4（含 D2 401/403）、MCP tool/schema/description，以及 20 个 seed 的 persona JSON。现有 decoy cap 8 KiB；persona cap 16 KiB，persona 不含凭据。canary 为 AG-CANARY-，不当作厂商 secret。\n\n扫描覆盖厂商前缀、PEM private-key headers、保留主机（.invalid/.example、RFC 5737/3849）、隐藏字符与 agent-directed English/中文命令。允许描述性 copy “do not share”，以及相对路径的 dotted filename。lint 是 bounded samples 的启发式检查，不是任意文本的完整语义安全证明；未测 persona 的真实 agent 可信度。独立 lint 命令按当前生成物重新检查，发现违规退出 1。\n\n## 范围与偏差\n\n仅新增 bench、tests、docs 与 package.json scripts；无 runtime 修改，无 src safety fix，无新依赖，未改 lockfile。未执行 commit/push/publish，遵循本次用户约束（覆盖旧合同的 push 条款）。\n`);
    return result;
}
if (isMain(import.meta.url)) {
    const result = exhaustSim();
    console.log(JSON.stringify({ ...result, runs: result.runs.map(({ sessionResults: _sessions, ...run }) => run) }, null, 2));
    if (result.deceptionLint.violations.length) process.exitCode = 1;
}
