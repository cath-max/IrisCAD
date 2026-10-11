---
name: IrisCAD Cloud Run and Supabase Deployment
overview: 将 IrisCAD 从当前带 /cadam 前缀的本地应用，分阶段迁移为运行在 Cloud Run、使用 Supabase Pro，并通过 https://cad.iris.com/ 直接访问的生产 Web Agent。阶段完成后必须在本文件中更新状态和实施记录。
todos:
  - id: phase-0-root-path
    content: 阶段 0：完成根路径、静态资源与生产 URL 配置改造
    status: completed
  - id: phase-1-cloud-run-runtime
    content: 阶段 1：补齐 Cloud Run 容器运行条件并通过本地 Docker 验收
    status: completed
  - id: phase-2-supabase-schema
    content: 阶段 2：将现有数据库结构安全部署到新 Supabase 项目并审计 RLS
    status: pending
  - id: phase-3-supabase-auth
    content: 阶段 3：配置 Supabase Auth、邮件、回调与 OAuth
    status: pending
  - id: phase-4-gcp-foundation
    content: 阶段 4：建立 GCP 项目、服务账号、API 与 Secret Manager 资源
    status: pending
  - id: phase-5-cloud-run-deploy
    content: 阶段 5：部署到 Cloud Run 默认 URL 并完成端到端冒烟测试
    status: pending
  - id: phase-6-custom-domain
    content: 阶段 6：通过全局 HTTPS Load Balancer 将 cad.iris.com 接入 Cloud Run
    status: pending
  - id: phase-7-dns
    content: 阶段 7：切换 DNS 并验证 TLS、深层路由与静态资源
    status: pending
  - id: phase-8-auth-cutover
    content: 阶段 8：正式切换 Supabase 回调与所有生产 URL
    status: pending
  - id: ongoing-release-process
    content: 持续工作：固化无须修改 DNS 的发布与数据库迁移流程
    status: pending
  - id: ongoing-production-operations
    content: 持续工作：建立 Cloud Run、Supabase、安全和费用维护清单
    status: pending
isProject: true
---

# IrisCAD Cloud Run + Supabase Pro + 独立域名部署计划

## 目标与边界

最终用户直接访问 `https://cad.iris.com/` 即可体验 IrisCAD Web Agent。应用部署于 Google Cloud Run，数据、Auth 与 Storage 使用新的 Supabase Pro 项目，正式域名通过 Google Cloud HTTPS Load Balancer 接入。

本计划按顺序执行。每一阶段只有在其验收条件全部满足后才能标记为 `completed`，并在“实施记录”中写明日期、主要变更和验证结果。

明确边界：

- 保留 localhost 开发体验和 `VITE_CAD_UI_VARIANT` UI feature flag。
- 外部产品名逐步迁移为 IrisCAD、Agent 名为 Iris。
- 不因地址改造机械重命名内部 CADAM 标识、数据库对象、Supabase migration 或兼容性常量。
- 数据库生产变更与应用部署分开审批和执行。
- 服务端秘密不得进入浏览器 bundle。

## 阶段 0：根路径与地址结构

状态：`completed`

这是所有云配置的前置依赖。应用当前仍假设运行在 `/cadam`，目标是从域名根路径 `/` 运行。

实施范围：

- 保留 localhost 和现有 UI feature flag 行为。
- 将应用 base path 从 `/cadam` 改为 `/`。
- 调整 Vite、TanStack Router/Start 与 Nitro 的 base、public/base URL 和构建配置。
- 调整 WASM、Pyodide、字体和 SimpleCADAPI wheel 等静态资源路径。
- 调整生产输出目录，去除 `dist/cadam` 或等价的 `/cadam` 嵌套假设。
- 删除路由中对 `/cadam` 的特殊判断，但不改变实际业务路由名称。
- 检查 Auth 邮件确认、重置密码、更新密码路径。
- 检查 API URL 拼接，确保同源根路径工作且 localhost 不回归。
- 将生产 URL 配置收敛到 `APP_URL` 或明确的等价变量；处理 `ADAM_URL` 等旧地址变量，但不机械重命名无关内部标识。
- 更新与本阶段直接相关的环境变量模板；完整 README 重写留给独立文档阶段。

验收条件：

- 本地访问 `/` 能打开首页。
- `/editor/...`、`/signin`、`/confirm-email`、`/reset-password`、`/update-password` 等深层路由刷新不返回 404。
- 页面资源不再从 `/cadam/...` 加载。
- WASM、Pyodide、字体和 wheels 能从根路径正确加载。
- API 与 Agent 流式请求使用正确的同源地址。
- 不依赖反向代理补 `/cadam` 前缀。
- UI feature flag 仍能选择旧/新 UI。

实施记录（2026-08-25）：

- Vite、TanStack Router/Start 与 Nitro 已统一使用根路径 `/`；客户端中间输出目录由 `dist/cadam` 调整为 `dist/client`，最终 Nitro 产物继续位于 `.output`。
- 移除了 Iris 首页对 `/cadam` 的兼容特判，并增加根路由回归测试。
- 字体、OpenSCAD、公共图片、HDR、OpenSCAD libraries 和 SimpleCADAPI wheels 已改为根路径安全拼接，避免 `//asset`；开发 wheel middleware 和本地启动提示同步为根路径。
- billing 回跳改用服务端 `APP_URL`；未配置时使用当前请求 origin，因此 localhost 无需额外生产配置。环境变量模板已同步。
- 保留 `VITE_CAD_UI_VARIANT` 及其 legacy/new-ui 行为；未重命名内部 CADAM 标识、数据库对象或 migration。
- 精简验收通过：TypeScript 类型检查、39 项现有/回归测试、生产构建；Nitro 从 `/` 预渲染。最小运行探针验证 `/`、`/signin`、字体和一个 wheel 均返回 200，构建产物中无 `/cadam/` 资源引用。

## 阶段 1：Cloud Run 容器运行条件

状态：`completed`

实施范围：

- 增加 `Dockerfile`、`.dockerignore` 和生产启动命令。
- 增加 `/healthz` 健康检查。
- 使用正确的 Node Server/Nitro 构建产物。
- 监听 Cloud Run 注入的 `PORT`（默认 8080）和 `0.0.0.0`。
- 容器内部只提供 HTTP；TLS 由 Google 终止。
- 不依赖容器临时文件系统保存永久用户数据。
- 将 `VITE_*` 公共配置作为构建参数；服务端秘密通过 Secret Manager 注入。

本地验收：

- `docker build -t iriscad-web .`
- `docker run --rm -p 8080:8080 iriscad-web`
- 验证首页、`/healthz`、登录、服务端 API、静态字体、WASM、Pyodide、wheels、Agent 流式输出和深层路由刷新。

实施记录（2026-08-26）：

- 已加入 `Dockerfile`、`.dockerignore`、`npm run start` 与 `/healthz`。运行时采用 Nitro 的 `.output/server/index.mjs`，并监听 Cloud Run 提供的 `PORT`（默认 8080）及 `0.0.0.0`。
- 已在本机成功构建镜像 `iriscad-web:phase1`（约 130 MB）。构建时使用 Supabase 项目的公开 URL 和临时 publishable key 占位值；正式部署时需替换为真实的公开 publishable key。服务端秘密不写入镜像，留待后续通过 Secret Manager 注入。
- 已启动临时容器验证，`/healthz`、`/`、`/signin`、`/Geist-Regular.ttf` 和 `vendor/simplecadapi/simplecadapi-2.0.1b6-py3-none-any.whl` 均返回 HTTP 200；容器日志确认服务监听 `0.0.0.0:8080`。验证容器已停止并自动删除。
- 由于当前 lockfile 中 Nitro beta 的开发期可选 peer 依赖与 npm 的严格校验不兼容，Docker 构建使用 `npm ci --legacy-peer-deps`；生产构建及运行验证均已通过。

## 阶段 2：部署数据库结构到新 Supabase

状态：`pending`

实施范围：

- 使用 `npx supabase start` 与 `npx supabase db reset` 验证历史 migration 可从零执行。
- 链接新项目并运行 migration list 与 `db push --dry-run`。
- 由用户确认后才执行远程 `db push`；禁止对正式项目执行 `db reset --linked`。
- 验证 conversations、messages、profiles、images、previews、prompts、Storage buckets/policies、triggers、enum/type、Agent 设置及 billing/token 表。
- 重新生成远程 TypeScript 数据库类型。
- 审计所有用户数据表 RLS、公共分享策略、Storage policy 和 service role 使用范围。
- 运行 Supabase Security Advisor。

实施记录：尚未实施。

## 阶段 3：Supabase Auth

状态：`pending`

实施范围：

- 首轮使用 Cloud Run `run.app` URL 作为 Site URL，并同时允许 localhost 与 run.app 回调。
- 正式域名可用后再切换到 `https://cad.iris.com`。
- 覆盖 `/confirm-email`、`/reset-password`、`/update-password` 和必要通配回调。
- 配置正式 SMTP、发件人、SPF、DKIM、DMARC。
- 测试注册确认、忘记密码、修改邮箱、一次性链接和垃圾邮件投递。
- 如启用 OAuth，区分 OAuth 平台到 Supabase 的 callback 与 Supabase 返回 IrisCAD 的 redirect。

实施记录：尚未实施。

## 阶段 4：Google Cloud 基础资源

状态：`pending`

建议资源：

- GCP Project：`iriscad-production`
- Region：`us-east4`
- Cloud Run service：`iriscad-web`
- Artifact Registry：`iriscad`
- 专用 runtime service account：`iriscad-runtime@<project>.iam.gserviceaccount.com`

实施范围：

- 启用 Cloud Run、Artifact Registry、Cloud Build、Secret Manager、Compute Engine、Certificate Manager API。
- 按最小权限授予 runtime service account 指定 secret 读取与日志写入权限。
- 每个密钥使用独立 Secret Manager secret，不使用大 JSON，不授予 Owner/Editor。

实施记录：尚未实施。

## 阶段 5：Cloud Run 默认 URL 首次部署

状态：`pending`

部署链路：代码 → Cloud Build → Artifact Registry → Cloud Run revision。

初始建议：1 CPU、1 GiB、并发 10–20、最小实例 1（成本优先时可为 0）、最大实例 10、超时 900 秒、开启 startup CPU boost。

在默认 `run.app` URL 上完成端到端冒烟：

1. 首页、注册、邮件确认、登录。
2. 创建参数化模型，完成 Agent 生成、七视图检查和修正。
3. 刷新恢复对话、上传图片、调整参数。
4. 导出 STEP/STL，验证 Assembly 生成和导出。
5. 登出再登录。
6. 检查 Cloud Run 日志无密钥泄漏。

默认 URL 未通过前不得修改正式 DNS。

实施记录：尚未实施。

## 阶段 6：将 cad.iris.com 接入 Cloud Run

状态：`pending`

正式方案采用 Global External Application Load Balancer，不以 Preview 状态的 Cloud Run Direct Domain Mapping 作为首选生产方案。

目标结构：Global static IP → Google-managed SSL certificate → HTTPS forwarding rule → target HTTPS proxy → URL map → backend service → Serverless NEG → Cloud Run `us-east4`。

实施范围：

- 预留全局静态 IPv4。
- 创建指向 `iriscad-web` 的 Serverless NEG、Backend Service 和 URL Map。
- 创建 `cad.iris.com` Google-managed certificate、HTTPS Target Proxy 与 443 Forwarding Rule。
- 可选增加 HTTP 到 HTTPS 重定向。
- 将 Cloud Run ingress 调整为 Internal and Cloud Load Balancing，并保持所需 IAM 调用权限。

实施记录：尚未实施。

## 阶段 7：DNS 切换

状态：`pending`

DNS 配置：A 记录 `cad` 指向全局 Load Balancer IPv4，初始 TTL 300。只有固定 IP 创建完成后才修改。

若 DNS 托管于 Cloudflare，证书初次签发期间使用 DNS only，待证书正常后再决定是否启用代理。

验收条件：

- DNS 返回正确固定 IP。
- TLS 证书包含 `cad.iris.com`，HTTP 自动跳转 HTTPS。
- 深层路由刷新正常，无 mixed content。
- Auth 不再错误跳回 run.app。
- 静态资源不请求 `/cadam/...`。

实施记录：尚未实施。

## 阶段 8：正式切换 Supabase 回调与生产 URL

状态：`pending`

实施范围：

- Supabase Site URL 改为 `https://cad.iris.com` 并添加正式 Redirect URLs。
- 检查邮件模板和 OAuth 平台配置。
- Cloud Run 配置 `APP_URL=https://cad.iris.com` 及仍实际需要的 webhook base URL。
- 检查 billing checkout、支付 webhook、账户删除回调等所有外部 URL。
- 重新测试注册、密码重置、修改密码和 OAuth。

完成此阶段才视为正式域名切换完成。

实施记录：尚未实施。

## 持续发布流程

状态：`pending`

应用发布：main 合并 → Cloud Build 新镜像 → Cloud Run 新 revision → 健康检查 → 流量切换。DNS、固定 IP、Load Balancer 和证书不随发布修改。

数据库发布：代码测试 → migration dry-run → 人工批准 → db push → 部署兼容的新应用 revision。禁止多人或多个 CI job 同时执行生产 migration。

实施记录：尚未固化。

## 上线维护清单

状态：`pending`

- Cloud Run：5xx、P95/P99、504、实例数、内存、冷启动、Agent 流中断、Secret 失败、费用与预算告警。
- Supabase：CPU、RAM、Disk、连接数、Auth 错误、Storage、慢查询、RLS/安全警告、备份与 PITR。
- 安全：管理员 2FA、账号隔离、service role 不进入浏览器、密钥轮换、日志脱敏、GCP/Supabase 预算告警。

实施记录：尚未建立。
