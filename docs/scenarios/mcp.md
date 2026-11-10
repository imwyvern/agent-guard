# MCP / LLM tool endpoint decoy（本地示例）

本示例研究暴露在 HTTP 上的 MCP（Model Context Protocol）endpoint 被枚举、随后调用内部工具的行为。威胁映射到 OWASP MCP Top 10 的 MCP01（Token Mismanagement & Secret Exposure）与 MCP08（Lack of Audit & Telemetry）：公开的 `tools/list` 可能暴露敏感能力名称，探测者可能试图使用泄漏凭据调用这些能力；缺少调用审计则难以发现这种尝试。一次枚举本身不证明恶意，本示例仅对 decoy 调用与有效 canary replay 告警。

## 运行与协议

```sh
npm run demo:mcp
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
curl -s http://127.0.0.1:3000/mcp -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"export_customer_records","arguments":{}}}'
```

服务仅监听 loopback，默认 console alert、离线注入 DNS；`PORT`、`AG_CANARY_SECRET`、`AG_WEBHOOK_URL` 和 `AG_WEBHOOK_SECRET` 与其他 demo 一致。`POST /mcp` 提供最小 JSON-RPC 2.0 request/response：`initialize`、`tools/list`、`tools/call`，真实工具为 `echo` 与 `get_time`。它不实现完整的 MCP Streamable HTTP transport：没有 SSE、session negotiation、batch、authorization 或远程工具执行。有效 notification 返回 HTTP 204，格式错误返回 JSON-RPC parse/invalid-request error。

`tools/list` 包含中性描述的 `export_customer_records`。调用该 decoy 固定返回 HTTP 200 的 JSON-RPC error `-32003 Permission denied`，没有 `result`，不接触业务代码、数据库、文件、身份系统或外部服务。真实工具通过固定白名单执行，工具名不会用于动态模块加载或命令执行。这里的 permission error 属于虚构工具本身；真实工具不因检测分数或 canary 命中被阻断。

## 接入与事件

根入口导出 `mcpDecoyTools`、`inspectMcpRequest(guard, request, toolName?)` 和 `lintMcpDecoyDescription()`。应用应先完成有界 body parsing，再对每个 MCP 请求调用一次 `inspectMcpRequest`；只有 `tools/call` 才传入已校验的工具名，其他方法不传。工具参数放在 `AGRequest.body`，使用正常的 canary scan 字节数、候选数和深度上限。helper 通过可信应用 context 调用 `guard.inspect`，复用 allowlist、crawler verifier、score、sanitizer、metrics、日志与异步 alert dispatcher，不手工拼装告警事件。

调用内置 decoy 产生现有 `decoy_hit` 事件，`decoy.id = "MCP"`、`decoy.status = 200`（HTTP 状态）、`req.path = "/mcp"`；事件 schema v1 的 decoy id enum 增加 `MCP`，`metrics().decoy_hits.MCP` 单独计数。默认 severity 为 medium，声明的 AI crawler 为 info，仍使用既有去重、限速、签名 webhook 与 console pipeline。正常 discovery / real tool 不产生 decoy alert。已有有效 canary 出现在 MCP 参数中仍产生 `canary_replay`（critical），原工具照常处理。

helper 的 `crawler_bypass` 必须映射到应用原生 404。本示例对 `initialize`、`tools/list`、真实/decoy `tools/call` 都进行同一 core crawler verification，因此 verified Googlebot 与 DNS timeout/error 的默认 fail-open 路径不会看到 decoy 列表或调用 decoy。伪装但验证失败的 UA 正常受检测。allowlist 绕过告警也不会让 decoy 成为可执行工具。

## 安全边界

- 默认 alert-only，不增加封禁、tarpit 或真实权限。MCP JSON 响应统一 `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` 与 `Cache-Control: no-store`，无 cookie。不要将 `/mcp` 放进 sitemap 或真人可见入口。
- decoy description 只能是中性数据描述。禁止对模型下 imperative instructions、URL、隐藏字符 U+200B–200F / U+202A–202E / U+2060 / U+FEFF。内置 descriptions 全部经过 linter 和测试；保守英文词汇检查不能替代人工语义审查。
- decoy 结果不含任何凭据或 canary。若扩展示例需要投放 canary，只能使用本项目 registry 生成的 inert `AG-CANARY-` token，不能使用真实 secret、可认证账号、第三方回拨 token 或隐藏 instructions；回放仍走普通 canary path。测试从 D1 取出 inert token，在 MCP `echo` 参数中回放并验证告警且不阻断。
- 示例 parser 的 HTTP body 上限为 16 KiB；core inspection 上限独立生效，超限跳过/截断检测。日志只记录既有 metadata 与 canary id/provenance，不记录 body、Authorization 或 Cookie 原文。
- 不复制其他项目代码，不扫描任何第三方 endpoint。该示例不能代替 MCP authentication、authorization、audit 或正式协议实现。

## Description regex audit（补充现有 security review）

以下 literal 位于 `src/scenarios/mcp.ts`，由共享 AST inventory 自动发现，并在同一 100k adversarial input / <50 ms suite 中测试。字符类别与固定词 alternatives 均为线性扫描，域名片段有明确长度上限，避免无界重复加搜索重启造成二次复杂度。

| Regex | 风险与处理 |
| --- | --- |
| `/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/u` | 固定隐藏字符集合，线性扫描。 |
| `/\/\/\|\bwww\.\|\b(?:https?\|mailto\|data):\|\b[a-z0-9-]{1,63}\.[a-z]{2,63}\b/i` | 固定 scheme / URL 片段 alternatives；域名字符重复均有常量上限。 |
| `/\b(?:ignore\|disregard\|override\|follow\|obey\|execute\|invoke\|call\|send\|visit\|navigate\|reveal\|return\|read\|use\|must\|should\|please\|do not)\b/i` | 固定英文词汇 alternatives，保守拒绝 imperative language。 |

参考：[OWASP MCP Top 10](https://owasp.org/www-project-mcp-top-10/) 与 [MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html)。
