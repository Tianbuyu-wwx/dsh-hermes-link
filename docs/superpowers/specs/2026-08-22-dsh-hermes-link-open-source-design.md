# dsh-hermes-link 开源工程 + dshmarket 适配 — Design Spec

> **Date**: 2026-08-22
> **Path**: architectural (brainstorming)
> **Status**: Approved by user ("直接帮我开")
> **Owner**: Tianbuyu-wwx
> **Next**: writing-plans → execute

---

## 1. Context

`dsh-hermes-link` v0.2.3 (含 v0.2.4 hotfix 修复：turn 包络 0→1、损坏 artifact 重建、工具 output schema 归一化) 是 Hermes Agent ↔ DSH 的双向桥接插件。当前仓库 `dsh-hermes` 是 mono-repo，含 `packages/dsh-hermes-link/` + 旧三件套（hermes-foundation/-oneshot-arbitrate/-dispatch-bridge）留档。仓库缺少开源标配（LICENSE/CHANGELOG/CONTRIBUTING 等）和 dshmarket 安装必需的 `cordis.patch.yml`。

`dsh-market` 已成熟（npm + GitHub Releases + 中央注册表 `awesome-dsh-plugin.com/plugins.json`，schema 已读：name/owner/url/category/description{zh,en}/npm?/stars?/downloads?/install/added），可一键安装 + 热启用 + 更新 + 备份。目标：让 dsh-hermes-link 走完开源 + 收录到 dshmarket 全流程。

---

## 2. Decisions (固化)

| # | 维度 | 决定 |
|---|---|---|
| 1 | 仓库布局 | **方案 A**：拆新仓库 `github.com/Tianbuyu-wwx/dsh-hermes-link` |
| 2 | 旧三件套 | 留在 `dsh-hermes` 加 archive tag + README 横幅（不删、不迁出） |
| 3 | 包名 | `@Tianbuyu-wwx/dsh-hermes-link`（个人 scope） |
| 4 | 发布渠道 | npm publish + GitHub Releases 双轨，changesets 驱动 |
| 5 | 文档语言 | 英文主（README/docs）+ 中文镜像（README.zh.md） |
| 6 | LICENSE | MIT (Copyright 2026 Tianbuyu-wwx) |
| 7 | Node 要求 | `>=20` |
| 8 | OS / CPU | `["win32","darwin","linux"]` / `["x64","arm64"]` |
| 9 | 版本号 | v0.2.4（含 turn 包络修复等 hotfix） |
| 10 | dshmarket 注册 | 提交 PR 到 `awesome-dsh-plugin`（仓库地址待验证） |

---

## 3. Repository Tree

```
dsh-hermes-link/
├── .github/
│   ├── CODEOWNERS
│   ├── FUNDING.yml
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.md
│   │   └── feature_request.md
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── docs/
│   ├── README.md                    # 文档目录索引
│   ├── security-model.md            # ★ v0.2.1-S1~S4 + K.1-K.5 + v0.2.4 完整安全边界
│   ├── plugin-developer-guide.md    # ★ Hermes 端 dispatch/amend/consult 协议实现指南
│   ├── plugin-install-guide.md      # ★ dshmarket / npm / git 三种安装方式
│   ├── dispatch-spec.md             # 协议级文档
│   ├── sharing-conventions.md
│   ├── hotfix-20260820.md
│   ├── delivery-v0.6.0-20260821.md  # 留档交付报告
│   ├── hermes-upgrade-v0.2.2.md     # Hermes 端升级指南
│   └── superpowers/
│       └── specs/
│           └── 2026-08-22-dsh-hermes-link-open-source-design.md  # 本 spec
├── packages/
│   └── dsh-hermes-link/
│       ├── index.mjs                 # v0.2.4（含 hotfix 修复）
│       ├── cordis.patch.yml          # ★ 新建：dshmarket patch 必需
│       ├── dispatch-spec.schema.json
│       ├── package.json              # @Tianbuyu-wwx/dsh-hermes-link v0.2.4
│       ├── import/
│       ├── services/
│       ├── tools/
│       ├── http/
│       └── skills/
│           └── dsh-hermes-link/SKILL.md
├── scripts/
│   ├── smoke-test.mjs
│   ├── test-request-dump.mjs        # 含 case 9/10 turn 包络回归
│   ├── test-dispatch-schema.mjs
│   ├── test-services.mjs
│   ├── test-amend-security.mjs
│   ├── test-consult-security.mjs
│   ├── test-foundation-policy.mjs
│   ├── test-mirror-opt-in.mjs
│   ├── test-v0.2.3-hardening.mjs
│   ├── test-consult-client.mjs
│   ├── import-check.mjs
│   ├── verify-install.mjs
│   ├── run-all-tests.cmd
│   └── version-bump.mjs             # ★ 新建：应急本地 bump
├── .gitignore
├── .editorconfig
├── .nvmrc                            # 20
├── CHANGELOG.md                      # changesets 自动生成
├── CODE_OF_CONDUCT.md                # Contributor Covenant v2.1
├── CONTRIBUTING.md
├── LICENSE                           # MIT
├── README.md                         # 英文主
├── README.zh.md                      # 中文镜像
└── SECURITY.md
```

---

## 4. Implementation Plan (执行清单)

### Phase 1: Bootstrap 仓库
1. mkdir 完整目录树 ✅
2. 复制 `packages/dsh-hermes-link/` 全部代码 + `scripts/` 11 个 + `docs/` 留档 ✅
3. 写 spec（本文档）

### Phase 2: 代码层修改
4. 新建 `cordis.patch.yml`（dshmarket patch 必需）
5. 重写 `packages/dsh-hermes-link/package.json`：`name: @Tianbuyu-wwx/dsh-hermes-link`, `version: 0.2.4`, 加 repository/homepage/bugs/author/engines/os/cpu/publishConfig
6. `packages/dsh-hermes-link/index.mjs` `VERSION = '0.2.4'`
7. `packages/dsh-hermes-link/http/dispatch.mjs` `VERSION = '0.2.4'`
8. 新建 `scripts/version-bump.mjs`（应急本地 bump）

### Phase 3: 开源标准文档
9. LICENSE（MIT，Copyright 2026 Tianbuyu-wwx）
10. README.md（英文，SHIELD/Why/Features/Quickstart/Architecture/Configuration/Security/Roadmap/FAQ/License）
11. README.zh.md（中文镜像）
12. CHANGELOG.md（v0.2.3 → v0.2.4 hotfix 条目）
13. CONTRIBUTING.md（dev setup + PR 流程 + commit 约定 + 自检命令）
14. SECURITY.md（私下漏洞报告 + 已知安全边界 + 威胁模型 + 版本支持窗口）
15. CODE_OF_CONDUCT.md（Contributor Covenant v2.1）
16. .gitignore（扩展 node_modules/, *.log, dist/, .DS_Store, .vscode/, coverage/）
17. .editorconfig
18. .nvmrc（`20`）

### Phase 4: CI / 发布
19. .github/workflows/ci.yml（PR/push → npm ci → npm test → matrix windows/ubuntu/macos × Node 20/22）
20. .github/workflows/release.yml（changesets action → 自动 npm publish + GitHub Release）
21. .github/CODEOWNERS
22. .github/FUNDING.yml
23. .github/ISSUE_TEMPLATE/bug_report.md
24. .github/ISSUE_TEMPLATE/feature_request.md
25. .github/PULL_REQUEST_TEMPLATE.md

### Phase 5: docs/ 内部文档
26. docs/README.md（文档目录索引）
27. docs/security-model.md（v0.2.1-S1~S4 + K.1-K.5 + v0.2.4 turn 包络，按层画清楚）
28. docs/plugin-developer-guide.md（Hermes 端协议实现指南：dispatch_spec schema、amend nonce、consult reply_secret、persona envelope、foundation slice 限制）
29. docs/plugin-install-guide.md（dshmarket / npm / git 三种安装）

### Phase 6: dshmarket 注册
30. 准备 `REGISTRY-ENTRY.json` 给用户的 PR 草稿（提交到 awesome-dsh-plugin 仓库）

### Phase 7: 旧仓库处理
31. `dsh-hermes/README.md` 顶部加横幅 → 指向 `github.com/Tianbuyu-wwx/dsh-hermes-link`

### Phase 8: 收尾
32. 探针验证 import-check（19 模块可加载）
33. 清理 staging 探针
34. 写本轮进展到 memory（daily + project）

---

## 5. Risk

| 风险 | 缓解 |
|---|---|
| npm scope `@Tianbuyu-wwx` 已被他人占用 | npmjs.com 搜 + 占用则改 `@dsh-external/dsh-hermes-link`（需 org 权限） |
| `awesome-dsh-plugin` 仓库地址 ≠ 推断 | spec 注明待验证；提交 PR 前 web search 验证 |
| GitHub Actions secrets（`NPM_TOKEN`）缺失 | release.yml 注释手动 fallback（`pnpm changeset publish` 本地） |
| 旧 `dsh-hermes` 仓库用户 profile 的 link GBK 乱码路径 | README 横幅只指官方 dshmarket/npm 安装命令 |

---

## 6. Verification

- ✅ `node scripts/smoke-test.mjs` 静态结构 + 语法（77 项）
- ✅ `node scripts/test-request-dump.mjs`（含 case 9/10 turn 包络回归）
- ✅ `node scripts/import-check.mjs`（19 模块全量加载）
- ✅ 探针 import-check：在 DSH 进程内动态 import 新仓库的 `packages/dsh-hermes-link/index.mjs` 等关键模块，无语法错误
- ✅ 探针 mkdir + copyFileSync 完整性：所有文件 size > 0

---

## 7. Out of Scope (未做)

- 实际 push 到 GitHub（需要用户认证）
- 实际 PR 到 `awesome-dsh-plugin` 仓库（提交内容已准备好，用户去推）
- npm publish（需要 `NPM_TOKEN`）
- GitHub Actions secrets 配置（需 repo admin）
- 旧 `dsh-hermes` 仓库的 git tag（需 git push 权限）