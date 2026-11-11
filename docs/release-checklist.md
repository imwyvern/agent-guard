# npm 发布前清单（等待 Dan 本人确认后才执行）

> 现状：`package.json` 为 `@imwyvern/agent-guard@0.1.0`，`private: true`。**未发布。** 发布需要 Dan 本人的明确同意，并由 Dan 本人完成 npm 登录和最后的发布确认。

## 需要 Dan 决定 / 提供

- [ ] 同意发布版本号（建议 `0.3.0`，因为 0.1/0.2 的内容已并入）。
- [ ] 确认 npm 作用域：`@imwyvern` 需要在 npm 上存在对应用户或组织（我查过 `@imwyvern/agent-guard` 当前不存在，名字可用，但作用域归属需要 Dan 确认）。
- [ ] 注意：无作用域的 `agent-guard` 已被他人占用，不能用。
- [ ] Dan 本人登录 npm（含两步验证）。我不接触密码。
- [ ] 是否使用 npm provenance（需要在受支持的 CI 里发布；我们不用 CI，所以首版不带 provenance，文档里如实说明）。

## 我会提前准备好

- [ ] `package.json`：去掉 `private`，版本改为 `0.3.0`，补 `repository`、`bugs`、`homepage`、`keywords`、`publishConfig.access = "public"`。
- [ ] `files` 只含 `dist/`、`schema/`、README、CHANGELOG、LICENSE、NOTICE（已验证 50 个文件）。
- [ ] `npm run build && typecheck && lint && test` 全绿；`npm audit --omit=dev` = 0。
- [ ] `npm pack --dry-run` 无示例、无开发依赖、无本地路径或密钥；全仓 grep 无敏感内容。
- [ ] 在干净目录安装 tarball，跑 `import` 和 CLI 冒烟测试。
- [ ] CHANGELOG 把 Unreleased 改为 0.3.0 并写日期；README 的 "not yet published to npm" 改为安装说明（五个译本同步）。
- [ ] 回滚预案：`npm deprecate` 与 `npm unpublish`（72 小时内可撤）的说明。

## 发布动作（只在 Dan 确认后）

1. Dan 在自己的终端 `npm login`。
2. `npm publish --access public`（可先 `--dry-run`）。
3. 验证 `npm view @imwyvern/agent-guard`，在干净目录 `npx @imwyvern/agent-guard --help`。
4. 打 tag 与 GitHub Release 需要 Dan 另外同意。
