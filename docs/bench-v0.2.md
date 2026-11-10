# agent-guard v0.2 本地延迟 benchmark

本次 AC-10 primary measurement 使用 µs-resolution `process.hrtime.bigint()` runner；阈值保持 **p50 增量 ≤200 µs（0.2 ms）、p99 增量 ≤1000 µs（1 ms）、50k client_key 增量内存 ≤10,000,000 bytes（10 MB）**。100 connections 决定 verdict，10 connections 只作 supplementary。这里的 PASS/FAIL 仅对应这次本地方法的观测值，不能推导为生产环境延迟保证。

开始时间：2026-11-10T16:43:53.677Z（UTC）；总 benchmark wall time：152.54 s，包含全部 36 次 TCP measurement、warmup、child startup、memory 和 microbenchmark，少于约 6 分钟。

## 方法与复现

```sh
npm run bench:latency:hr
# 默认值；HR_RUNS 不得小于 3
HR_CONNECTIONS=100 HR_LOW_CONNECTIONS=10 HR_DURATION=3 HR_WARMUP=1 HR_RUNS=3 npm run bench:latency:hr
```

Express、native Node HTTP、Hono 三个 demo 均请求 homepage `GET /`，浏览器 UA 为 `Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36`。on/off 各运行在独立、持续存活的 server child process；每个 sample 的 load generator 另起一个 child process，parent 只协调及保存结果。使用现有 `bench/latency-server.ts` / demo 配置：日志 sink 为空、告警 adapters 为空、DNS 注入，无真实出站请求；首页不启用 HTML comment lure，其余检测保持启用。仅访问 `127.0.0.1`，不允许 virtual/in-process TCP fallback 冒充测量成功。

每个 adapter × concurrency × mode 测三次；顺序为 `off,on / on,off / off,on`。每次先 warmup 1 s，再记录 3 s，沿用同一个 `node:http.Agent` 的 keep-alive sockets；每个 connection 同时只有一个 in-flight request，无 pipelining、think time 或 rate limit。这是 closed-loop saturation（持续提供尽可能多的负载），不是 fixed-rate。100 connections 的 run 是 primary；10 connections 帮助观察排队放大。没有为了通过 gate 改用低并发或低固定速率。

计时从创建 request 前开始，直至完整响应 body 的 `end`；包含 Agent 排队、client/server event loop、HTTP 和 loopback。只将 HTTP 200 完整响应记录进 histogram；timeout、transport error、non-200 均计 error，warmup error 同样使 primary 不能 PASS。请求 inactivity timeout 为 2 s，child 有独立 wall timeout。截止后不再发请求，已开始请求 drain 完成后计入；throughput 分母包括 drain 时间。

Histogram 无新依赖：收集整数 µs（ns 向上取整，误差 <1 µs），测量结束后 sort，percentile 使用 nearest rank `ceil(q*n)-1`；没有整数 ms 插值，也没有用吞吐量倒数伪装成 latency。每个 percentile 先取三次 run 的 median，delta = median(on) − median(off)；throughput 也取三次 median。不是合并所有 run 的样本，也不是 paired delta 的 median。p99.9 仅供观察，不参与 AC-10 gate。raw JSON 包含每次计数、warmup、时长、socket count、client/server PID 与完整 autocannon secondary snapshot：`bench/results/latency-hr.json`（gitignored）。

## Machine / environment

- Node：`v24.22.1`；OS：`linux 6.12.113+ x64`。
- `os.cpus()`：8 logical CPUs；型号：`Intel(R) Xeon(R) Processor`；采样 speed：0, 0, 0, 0, 0, 0, 0, 0 MHz（VM 返回 0，实际频率未提供）。
- `os.totalmem()`：16,779,689,984 bytes；结果生成时 `os.freemem()`：7,042,723,840 bytes；`os.loadavg()`：[1.77, 1.17, 0.99]。
- 同一台 Linux VM / host 上的 child processes；未固定 CPU affinity、频率或 GC。运行期间未并行执行 build/tests 或其他 benchmark。

## 新测量结果（µs）

每格均为 **off → on（Δ on−off）**；RPS 为 requests/s 的 median；errors 为六次 run（含各自 warmup）总计。负 delta 保留原值，不裁零。36 次 measurement 共完成 2,888,187 个 HTTP 200 请求；每次 socket count 均等于配置的 100 或 10，且 client/server PID 不同。

| Adapter | Connections | p50 µs | p90 µs | p99 µs | p99.9 µs | RPS off → on | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| express | 100 | 3636 → 3403 (-233) | 4492 → 4001 (-491) | 9856 → 7156 (-2700) | 62361 → 32159 (-30202) | 26074.0 → 27694.6 | 0 |
| express | 10 | 284 → 304 (+20) | 524 → 542 (+18) | 711 → 858 (+147) | 1000 → 1838 (+838) | 30151.0 → 28033.3 | 0 |
| node | 100 | 3854 → 4001 (+147) | 5244 → 5206 (-38) | 7942 → 7495 (-447) | 91682 → 26448 (-65234) | 23725.8 → 23864.2 | 0 |
| node | 10 | 324 → 331 (+7) | 587 → 583 (-4) | 817 → 949 (+132) | 1565 → 1549 (-16) | 24682.8 → 25914.0 | 0 |
| hono | 100 | 3723 → 3598 (-125) | 4602 → 4767 (+165) | 6474 → 7164 (+690) | 28147 → 9172 (-18975) | 25102.1 → 26354.8 | 0 |
| hono | 10 | 283 → 298 (+15) | 520 → 536 (+16) | 705 → 796 (+91) | 1044 → 1385 (+341) | 30475.1 → 28290.6 | 0 |

100-connection primary 的每次原始 percentile（按各 mode 实际执行次序；单位 µs）如下，便于检查短 run 的波动：

| Adapter | off p50 ×3 | on p50 ×3 | off p99 ×3 | on p99 ×3 |
|---|---|---|---|---|
| express | 3636, 3418, 3844 | 3403, 3371, 3481 | 6485, 18376, 9856 | 6912, 10514, 7156 |
| node | 3956, 3854, 3814 | 4077, 4001, 3957 | 7560, 10605, 7942 | 8271, 6792, 7495 |
| hono | 3723, 3908, 3506 | 3809, 3598, 3541 | 6839, 6474, 6439 | 8198, 7164, 6712 |

Memory 使用原有 `bench/memory.ts`，独立 child + `--expose-gc`：guard 创建并 warmup 后记录 heapUsed baseline，插入 50,000 个不同 UA/client keys 后再次 GC，再取 heapUsed 增量。结果 **8,321,776 bytes = 8.322 MB**，GC=True。这是共同 core client state 的增量 heap gate，三种 adapter 共用；不是各框架 50k TCP connections 的总 RSS，也没有声称覆盖框架总内存。

## AC-10 verdict（阈值未改）

| Adapter | 100-connection Δp50 ≤200 µs | Δp99 ≤1000 µs | 50k client keys ≤10 MB | Verdict |
|---|---:|---:|---:|---|
| express | -233 | -2700 | 8.322 MB | **PASS** |
| node | +147 | -447 | 8.322 MB | **PASS** |
| hono | -125 | +690 | 8.322 MB | **PASS** |

> **维护者注（置信度）**：100 connections 下同一 mode 三次 run 的 p50 自身波动约 200–430 µs（例如 express off：3418–3844 µs），已经和 200 µs gate 同量级，所以这里的 PASS 只说明"观测值没有超过阈值"，**统计功效不足以单独证明** Δp50 ≤ 200 µs；负 delta 就是噪声的直接证据。更有说服力的证据是两条互相印证的低噪声数据：10 connections 下 Δp50 只有 +7 ～ +20 µs，以及 in-process hot path ≈ 2.6 µs/op。后续（roadmap v0.3）计划：更长窗口、更多 run、paired bootstrap 置信区间，以及固定 CPU affinity 的专用 runner，再把 AC-10 从"观测 PASS"升级为"有置信区间的 PASS"。

## Hot path microbenchmark

同一进程中直接 `await guard.inspect()`，human homepage request、固定 IP/UA，20,000 次 warmup，之后每次 100,000 ops，三次测量；计入 await、decision assertion、bounds、canary scan、client state 和 metrics，排除 adapter、socket 与 HTTP。三次 **2856.36, 2267.76, 2564.13 ns/op**，median **2564.13 ns/op**。这是 warmed repeated-client 路径，不能代替 AC-10 end-to-end percentile，亦不能将 ns/op 直接等同于 saturated latency delta。

## 保留的 autocannon secondary（历史 v0.1）

原 `bench/latency.ts`、它的 autocannon 测量及 [v0.1 report](bench-v0.1.md) 保持不变。以下来自该报告 / 已有 `bench/results/latency.json`：100 connections、30 s、三次 median、每 mode 3 s warmup。为控制这次总 bench 时长，没有重跑约 8.5 分钟的原命令；这是历史数据，**不是与新 runner 同时采集**。原本的 fixed-rate supplementary 数据也完整保留在 v0.1 report / JSON snapshot 中。

| Adapter | off/on p50 ms | Δp50 ms | off/on p99 ms | Δp99 ms | 原记录 verdict |
|---|---:|---:|---:|---:|---|
| Express | 1 / 2 | +1 | 3 / 3 | 0 | FAIL（p50） |
| Node | 1 / 1 | 0 | 2 / 3 | +1 | PASS（原数值 gate） |
| Hono | 未测 | — | 未测 | — | 未验证 |

原 memory：8,279,168 bytes（8.279 MB）。Express 的 +1 ms FAIL 原样保留；不会把它改写为 +0.001 ms 或“此前已通过”。安装的 autocannon latency histogram 以整数 ms 返回这些 percentiles：1 ms 的 bucket 宽度大于 0.2 ms budget，off/on 跨 bucket 的差值不能解析真实亚毫秒增量；两边相同 bucket 也不能证明真实增量 ≤0.2 ms。保留更多 JSON 小数位、throughput-derived service time 或 fixed-rate 结果都无法恢复丢失的信息。v0.2 因此使用新的 µs measurement 作 primary，而不修改 gate 数字。

## Caveats / interpretation

- Loopback、同 host、相同 homepage 和 warmed browser client 只覆盖本地条件；没有 TLS、远程 RTT、真实浏览器行为、多样 client keys 或生产路由成本。
- Closed-loop 始终保持最多 N 个请求，并未设定相同 arrival rate。on/off throughput 可以不同；saturated 时 queueing 会放大小的 service cost。10 connections 的低排队结果不能替换 100 connections gate。也未用 fixed-rate 测量替换 saturated 测量。
- 使用不同 HTTP client 后，throughput 明显低于历史 autocannon；生成器自身的 CPU / event loop 也可能限制负载。这里的 saturated 指 offered closed-loop load，**未单独证明 server CPU 已达最大吞吐极限**。因此这次 PASS 只表示该 100-connection runner 的观测阈值通过，不意味着任意压测器、arrival rate 或 host 上都会通过。
- 1 s warmup、3 s window、三次 median 是时长约束下的取舍；JIT、GC、VM 邻居进程与 scheduler drift 均可能影响结果。interleaving 只降低漂移，不能消除噪声；没有统计置信区间。µs histogram 的数值分辨率不等于 µs 的实验准确度。尤其负 delta 不能解读为 guard 会加速响应，p99/p99.9 波动更明显。
- 原 autocannon 与新测量的时长、client 实现、环境时刻不同，不应以两组差值做性能优化归因。新测量没有放宽检测，也没有修改 middleware runtime 实现；本次若某 adapter 超出阈值，仍需记为 FAIL。

## 验证

`npm run build && npm run lint && npm test` 全绿：15 个 test files、197 tests，包含 histogram nearest-rank、µs rounding 与 p99.9 boundary 测试；完整 TCP benchmark 不加入 `npm test`。另外检查 raw artifact 的 36 次 run 均有正确的并发 socket 数、独立 client/server PID、完整测量窗口及零错误。
