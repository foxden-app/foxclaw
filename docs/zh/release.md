# FoxClaw 发布 runbook

本文件给维护者使用。用户侧升级由 `/update` 或 `foxclaw update` 完成，但它们只会安装 npm registry 上的 `@foxden-app/foxclaw@latest`。推 PR、推普通分支或本地提交都不会让已安装节点收到新版。

## 发布规则

- npm `latest` 是 `/update` 的事实来源。
- GitHub `Publish` workflow 由 `v*` tag 触发，也支持手动 dispatch；正常发布只使用 tag。
- tag 名必须等于 `v<package.json version>`，例如 `package.json` 是 `0.5.10` 时只能推 `v0.5.10`。
- npm 上已经存在的版本不会再次发布。重新安装同版本时，Telegram 可能显示 `0.5.10 -> 0.5.10`，这表示 registry latest 没有前进。
- `CHANGELOG.md` 必须包含目标版本条目。`/update` 完成回报会从已安装包读取这个条目展示“更新内容”。

## 发布前检查

确认工作区和远端状态：

```bash
git status --short --branch
npm pkg get name version
npm view @foxden-app/foxclaw version
git tag --list 'v*' --sort=-v:refname | head
```

确认目标版本还没有发布，也没有远端 tag：

```bash
npm view @foxden-app/foxclaw@0.5.10 version 2>/dev/null || true
git ls-remote --tags origin refs/tags/v0.5.10
```

运行与发布 workflow 对齐的本地校验：

```bash
npm run lint
npm run typecheck
npm test
npm pack --dry-run
git diff --check
```

`npm pack --dry-run` 会执行 `prepack` 构建，并列出 npm 包内容。确认输出里有 `CHANGELOG.md`。

## 准备版本

1. 更新 `package.json` 和 `package-lock.json` 的版本号。
2. 在 `CHANGELOG.md` 顶部新增版本条目，包含 `### 中文` 和 `### English` 小节。
3. 提交发布 commit，推荐格式：

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "发布 0.5.10：一句话说明"
```

## 推送并触发发布

当前仓库使用 lightweight tag：

```bash
git tag v0.5.10
git push origin <branch>
git push origin v0.5.10
```

观察发布 workflow：

```bash
gh run list --repo foxden-app/foxclaw --workflow Publish --limit 5
gh run watch <run-id> --repo foxden-app/foxclaw --exit-status
```

成功后确认 npm 和 GitHub Release：

```bash
npm view @foxden-app/foxclaw version
gh release view v0.5.10 --repo foxden-app/foxclaw --json tagName,name,url,publishedAt,isDraft,isPrerelease
```

## 验收 `/update`

在仍安装旧版本的节点上发送 `/update`，期望看到：

```text
FoxClaw 已升级并重启：0.5.9 -> 0.5.10。

更新内容：
- ...
```

如果节点已经是最新版本，再次 `/update` 可能显示：

```text
FoxClaw 已升级并重启：0.5.10 -> 0.5.10。
```

这只表示重新安装了当前 npm latest，并不代表有新版本。

## 发布失败处理

- 如果 workflow 在版本校验失败，先检查 tag 和 `package.json` 是否一致。
- 如果 npm 显示版本已存在，不要复用同一个版本号；修正后发布下一个 patch 版本。
- 如果 npm publish 成功但 GitHub Release 创建失败，可以重新运行 workflow 或手动修复 release notes。
- 已发布到 npm 的版本不要删除重发。需要撤回线上 latest 时，优先发布修复版；只有紧急情况下才考虑调整 npm dist-tag。
