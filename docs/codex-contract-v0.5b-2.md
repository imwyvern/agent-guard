# Codex 合同：v0.5b 第二批（Docker 镜像模板、Compose、nginx / Caddy / Traefik 片段、本地 SBOM；DI-8）

- 依据：[plan-v0.5-v0.7.md](plan-v0.5-v0.7.md) §3、[distribution.md](distribution.md) §1 / §6（E-2，验收 DI-8）；每周迭代例行任务 2026-11-23（HKT）。上周已交付 E-1 / E-3 / E-4（proxy / init / watch --log）。
- 约束：Node ≥20，TS strict，**运行时依赖仍为 0**；不加 CI / GitHub Actions / CodeQL，不打 tag，不发 npm，不改包名或仓库名，不 force-push，不向 Docker Hub / GHCR 或任何 registry 发布镜像；**默认 `mode: 'detect'`、alert-only，不新增任何自动拦截**；未使用新入口时库的默认行为与 v0.5b 第一批字节一致；现有测试不得减少，现有断言不得改动；canary 永远 inert，诱饵页保持 noindex。
- 范围外（本合同不做）：真实 AI 代理评测框架（Issue #11，模型预算待 Dan 决定）、假成功（v0.6 / Issue #9）、蜜罐机（v0.7）、Workers 模板 / Helm（E-5）、Web Bot Auth 验证器、合并或关闭 Dependabot PR、修改延迟门槛。
- 发布前用法：所有示例继续写 `node dist/cli/main.js <cmd>`（或 `npx tsx src/cli/main.ts`），并注明 npm 发布后才可用 `npx @imwyvern/agent-guard`（发布仍需 Dan 单独批准）。Docker 示例以源码构建的本地镜像为准，不假设已有公开镜像名。

## 1. 交付位置

在仓库根目录新增 `deploy/`（模板，不是已发布产物）：

| 文件 | 作用 |
| --- | --- |
| `deploy/Dockerfile` | 多阶段构建，只打包 `dist` + 运行所需的 `package.json`（零运行时依赖，生产阶段不必 `npm ci`） |
| `deploy/.dockerignore` | 必须排除 `.env`、`**/.env`、`**/*.pem`、`.git`、`node_modules`、测试与基准结果 |
| `deploy/compose.yaml` | 本地 `guard`（proxy）+ 可选示例 `upstream`；默认安全选项见下 |
| `deploy/.env.example` | 只列变量名（`AG_CANARY_SECRET`、`AG_PROJECT_SEED`、`AG_WEBHOOK_SECRET` 等），不含任何密钥值 |
| `deploy/nginx.conf.example` | 把 TLS 终止后的流量转到本机 / 旁路的 proxy |
| `deploy/Caddyfile.example` | 同上 |
| `deploy/traefik.yaml.example` | 同上（静态或动态配置片段均可，须可独立阅读） |
| `deploy/README.md` | 本地构建、运行、安全边界与 SBOM 用法 |
| `scripts/sbom.ts` 或等价脚本 | 在本机生成 SPDX 或 CycloneDX，输出到 gitignore 目录（如 `bench/results/sbom.json`），不提交、不挂到 release |

不要改 `package.json` 的 `files` 字段：这些模板只随 git 仓库提供，不进入 npm 包。不要新增 `.github/workflows`。

## 2. Dockerfile（非 root、无可写业务路径、无密钥）

- 构建阶段使用 Node 20 的 slim 镜像（钉死 major.minor，禁止 `latest`）。生产阶段只复制构建产物，以 `node` 运行 `dist/cli/main.js`。
- 最终镜像必须以非 root 用户运行（`USER` 不能是 `root`，建议使用数字 UID，例如 65532）。不要 `sudo`，不要安装无关包。
- **禁止**把 `.env`、密钥、`AG_CANARY_SECRET` 等值打进镜像层（不要 `ENV AG_CANARY_SECRET=...`，不要 `COPY .env`）。密钥只允许运行时由编排注入。
- 默认 `CMD` / `ENTRYPOINT` 启动 **detect-only** 的 `proxy`。容器内监听 `0.0.0.0:8080` 时必须带 `--allow-public-bind`（容器网络命名空间与宿主机发布端口不是一回事，见 §3）。上游地址由编排的 `command` 或环境参数传入，不要在镜像里写死公网上游。
- 只读根文件系统下 `--init-secrets` 无法写 `.env`，**默认镜像 / Compose 路径不得依赖 `--init-secrets`**，必须要求运营者注入环境变量。把这一点写进 `deploy/README.md`。
- 不要为了健康检查新增诱饵路径，也不要新增会改变默认诱饵表的公开路由。`HEALTHCHECK` 若存在，只能探测非诱饵路径（例如转发到上游的 `/`），缺省也可不做 HTTP 探活，只在文档说明。
- 镜像是运营者本地构建的模板；文档禁止提供 `curl | sh`，也不要求 root 才能构建源码（使用 Docker 本身是运营者环境的事）。

## 3. Compose 默认必须硬一点

`deploy/compose.yaml` 必须同时满足：

- 宿主机端口只绑定回环：`127.0.0.1:8080:8080`。**禁止**默认写成 `8080:8080` 或 `0.0.0.0:8080:8080`。
- `read_only: true`；`cap_drop: [ALL]`；`security_opt: ["no-new-privileges:true"]`；`privileged` 不得为 true。
- 为 `/tmp`（如必须）提供 `tmpfs`，不要把业务数据或宿主机密钥目录默认挂进来。
- 以非 root `user` 运行（与镜像 UID 一致）。
- 示例 `upstream` **不要**发布到宿主机公网；若需要本机调试，同样只绑 `127.0.0.1`。`guard` 与 `upstream` 走内部网络；`guard` 的 `--upstream` 指向该内部主机名（如 `http://upstream:3000`）。
- 文档必须写清：容器内 `--listen 0.0.0.0:8080 --allow-public-bind` **不等于**把服务暴露到宿主机所有接口；宿主机是否暴露只取决于 `ports:`。运营者若改掉 `127.0.0.1:` 前缀，风险自负。
- 默认 `mode: detect`，不启用 trap / block。`AGENT_GUARD=off` 的语义不变（纯透传）。
- 通过 `env_file` 引用运营者自己的 `.env`（该文件被 gitignore / dockerignore）；示例文件不含值。

## 4. 网关配置片段

nginx、Caddy、Traefik 三个示例都遵循同一模式：**网关终止 TLS，再反代到本机 agent-guard proxy**（默认 `127.0.0.1:8080` 或文档中的 Docker 服务名），由 proxy 做检测 / 诱饵应答并转发上游。

- 片段必须是完整可粘贴的最小配置，含 `server_name` / 站点块占位符，不包含真实证书私钥。
- 不要在片段里把管理 API 或 dashboard 默认绑到 `0.0.0.0`。
- 注明：verified crawler 的豁免由 guard 处理；网关不要改写诱饵响应，不要去掉 `noindex` / robots 相关头。
- 可选：补充一小节，说明也可把网关的 access log 交给已有的 `watch --log`（不是本批的新代码路径，只是交叉引用 [distribution.md](distribution.md) §5）。

## 5. 本地 SBOM（不发布）

提供 `npm run sbom`（或文档中的一条 `node scripts/...` 命令），使用现有工具链在本机生成 SPDX 或 CycloneDX JSON，写入已被 gitignore 的目录（建议 `bench/results/`，该目录已在 `.gitignore`）。

- 不把 SBOM 提交进 git，不创建 GitHub Release，不上传 registry。
- 不新增运行时依赖；若必须用开发依赖，需说明仅为可选，且 Docker 构建不需要它。
- 优先用 npm 11 已有的 `npm sbom`；环境缺少子命令时脚本应给出明确错误，而不是假装成功。
- 后续正式发布仍按 [release-checklist.md](release-checklist.md) 由 Dan 单独批准。

## 6. 文档与多语言（硬性要求）

更新 README.md 与 `docs/i18n/README.*.md` 五个译本（zh-CN、zh-TW、ja、ko、es；**代码块逐字一致**，相对链接可解析）：在现有 "Zero-code entry points (unreleased)" 小节写明 Docker / Compose 已作为**本地模板**提供（非 root、只读根文件系统、宿主机默认只绑 127.0.0.1），并链到 `deploy/README.md` 与 [distribution.md](distribution.md)。真实 AI 代理评测、Workers 模板 / Helm 仍为 planned；不要把本地 Dockerfile 写成“已发布官方镜像”。

更新 CHANGELOG（[Unreleased] 下 Added / Changed，带 2026-11-23 HKT 日期）、`docs/distribution.md`（E-2 改为已实现 / unreleased，补 DI-8 证据与「不发布镜像」边界）、`docs/plan-v0.5-v0.7.md` 总览与 §3、`docs/roadmap.md`、`docs/positioning.md` 的宣称 / 状态 / 证据表（如有相关行）、必要时 `docs/community.md`。

在 `docs/roadmap.md` §1 用一两句话更新同类动态（只借鉴思路，不抄代码）：Beelzebub 仓库现位于 [beelzebub-labs/beelzebub](https://github.com/beelzebub-labs/beelzebub)（GPL-3.0，本周主要是 mcp-go 与文档依赖更新，无新功能需跟进）；Web Bot Auth 正式草案仍为 `draft-ietf-webbotauth-httpsig-protocol-01`（2026-10-29），编辑稿日期 2026-11-15，尚未有 -02。不要把未证实的消耗 token / 假成功写成已交付。

不改 GitHub issues 或 PR（关闭 / 评论由人工处理）。不改延迟门槛。

## 7. 验收

- build / typecheck / lint / test 全绿，通过数不低于 1517（2026-11-16 基线：1517 passed / 4 skipped）且不改动既有断言；`check:neutral` 通过；`bench:deception-lint` 0 违规。
- 新增测试（**不依赖本机已安装 Docker**，本 box 可能没有 Docker 守护进程）至少覆盖：
  - DI-8a：解析 `deploy/Dockerfile`：最终 `USER` 不是 root；未 `COPY` / `ADD` `.env`；未把密钥写进 `ENV` / `ARG` 默认值；基础镜像不是 `latest`。
  - DI-8b：解析 `deploy/compose.yaml`：所有 `ports` 都带 `127.0.0.1:` 前缀；`read_only: true`；`cap_drop` 含 `ALL`；无 `privileged: true`；含 `no-new-privileges`；`guard` 以非 root 运行。
  - DI-8c：`deploy/.dockerignore` 包含 `.env`（或 `**/.env`）、`node_modules`、`.git`。
  - DI-8d：三份网关片段都把后端指向 `127.0.0.1` 或文档中的内部服务名，且不含私钥。
  - DI-8e：SBOM 命令在本机可生成非空文档到 gitignore 路径（或在工具缺失时非零退出并说明原因）；输出不得包含仓库外真实密钥。
  - DI-8f（可选）：若本机有 Docker 守护进程，则 `docker build` 后以 Compose 默认配置启动，curl 普通页面与 `/.env` 诱饵（noindex + 告警），再拆除容器；**没有 Docker 时必须显式 skip**，不得假装通过。
- 现有 proxy / init / watch 行为不变；默认配置延迟门槛不得被改；本批不要求重跑饱和延迟门槛，也不为变绿而改门槛。
- `npm audit --omit=dev` 为 0；`npm pack --dry-run` 仍不含密钥，也不把 `deploy/` 强行塞进包（保持现有 `files`）；对已排除的外部品牌名做全仓扫描，结果为 0（扫描词不要写进仓库文件）；六份 README 代码块一致、相对链接无失效（沿用 `test/unit/entry-docs.test.ts`，必要时扩展）；不新增 `.github/workflows`。
- 不做对第三方的探测或攻击，不碰练答服务器，不在生产环境做 reverse prompt injection。

验收由维护者在 Codex 交卷后独立重跑，通过后再正常 push 到 `main`。
