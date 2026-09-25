# API 余额面板（Cloudflare Workers + Pages/KV）

一个自托管的**多平台 API Key 余额查询面板**：注册登录后绑定各平台的 API Key，统一查看余额；Key 以 AES-256-GCM 加密存储在 Cloudflare KV 中，页面上永远只显示脱敏片段。

## 功能一览

| 功能 | 说明 |
|---|---|
| 用户登录/注册 | 密码 PBKDF2 加盐哈希存储；登录态 Token 存 KV，7 天有效 |
| 绑定 API Key | 每个用户最多 **50 个**；支持添加、删除、单个刷新、全部刷新 |
| 添加前校验 | 添加时先用该 Key 真实查询一次余额，**校验失败则无法添加** |
| 自定义查询接口 | 每个 Key 可独立配置：接口 URL、请求方法（GET/POST）、请求头模板（`{key}` 自动替换）、余额字段 JSON 路径、余额单位 |
| 刷新页面自动获取余额 | 打开页面即自动刷新全部余额 |
| 刷新按钮 | 只更新余额数字/状态，**不刷新/重载界面** |
| 加密存储 | Key 用 AES-256-GCM 加密（密钥为 Worker Secret `ENCRYPTION_KEY`），明文永不返回前端 |
| 脱敏展示 | 页面只显示 `sk-xxxx...xxxx` 形式的脱敏片段 |
| 美观 UI | 深色玻璃拟态风格，响应式适配手机/桌面 |

## 目录结构

```
api-balance-checker/
├── .gitignore           # 忽略 node_modules / .wrangler / 本地密钥
├── wrangler.toml        # Worker + KV + 静态资源配置
├── package.json         # npm 脚本（dev / deploy / test / preview）
├── src/
│   ├── index.js         # Worker 入口（绑定 KV / Secret / Assets）
│   └── app.js           # 全部业务逻辑（认证 / 加密 / 余额查询 / 路由）
├── public/
│   └── index.html       # 前端页面（登录、仪表盘、刷新、添加弹窗）
└── test/
    ├── mock-test.mjs    # 本地 mock 验证（32 项断言）
    └── preview-server.mjs  # 本地界面预览（npm run preview）
```

## 快速开始（GitHub + Cloudflare）

### 1. 推到 GitHub

```bash
git init
git add .
git commit -m "init api balance checker"
git branch -M main
git remote add origin https://github.com/<你的用户名>/api-balance-checker.git
git push -u origin main
```

### 2. 纯 npm 命令部署（无需改任何代码，前端自动由 Worker 托管）

```bash
# ① 安装依赖（wrangler 由 npm 管理）
npm install

# ② 登录 Cloudflare（浏览器授权一次）
npx wrangler login

# ③ 创建 KV 命名空间，把输出的 id 复制到 wrangler.toml 的 id 字段
npx wrangler kv namespace create KV

# ④ 生成 AES 加密密钥并写入 Worker Secret
openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY

# ⑤ 部署
npm run deploy
```

部署完成后，访问输出的 `https://api-balance-checker.<你的子域>.workers.dev` 即可使用。
前端与后端在同一 Worker 内（同源），**无需配置任何 API 地址**。

### 3. 更新部署

```bash
# 改完代码后
git add . && git commit -m "update" && git push
npm run deploy
```

### 4. 本地开发 / 验证

```bash
npm run dev       # wrangler 本地调试
npm run preview   # 浏览器打开 http://127.0.0.1:8321 预览界面（演示数据）
npm test          # 32 项 mock 测试
```

## 使用说明

1. 打开页面 → 注册账号 → 登录。
2. 点击「+ 添加 Key」填写：
   - **名称**（可选）：给自己看的备注。
   - **查询接口 URL**：各平台的余额查询地址，例如 `https://api.lk888.ai/v1/skills/balance`。
   - **请求方法**：默认 GET。
   - **请求头模板**：默认 `Authorization: Bearer {key}`，`{key}` 会被替换为你的密钥。其他平台如用 `x-api-key` 可自行改写。
   - **余额字段路径**：余额在返回 JSON 中的位置，如 `balance`、`data.balance`、`result.items.0.value`。拿不准可以先 curl 一下看响应结构。
   - **余额单位**（可选）：如 `算力`、`USD`、`元`；不填会自动尝试从响应中识别。
   - **API Key**：明文只在这里填一次，提交后即加密保存。
3. 添加时会先做一次真实查询，成功才保存；失败会显示具体原因。
4. 列表每张卡片支持「单刷」和「删除」；顶部「刷新余额」按钮只刷新余额数据，不重载页面；**刷新页面时也会自动重新获取全部余额**。

## 常见平台参考配置

| 平台 | 查询接口 URL | 请求头模板 | 余额路径 |
|---|---|---|---|
| lk888 / lk666 | `https://api.lk888.ai/v1/skills/balance` | `Authorization: Bearer {key}` | `balance` |
| OpenAI 官方 | `https://api.openai.com/v1/dashboard/billing/credit_grants` | `Authorization: Bearer {key}` | `total_granted` |
| 其他中转站 | 见平台文档 | 按平台要求 | 按返回结构 |

## 安全说明

- **Key 加密**：使用 Worker Secret `ENCRYPTION_KEY`（AES-256-GCM）加密后写入 KV，密文与用户名绑定（AAD），跨用户无法互换使用。
- **响应脱敏**：任何 API 响应都不包含明文 Key，前端只显示首尾片段。
- **密码**：PBKDF2（SHA-256，10 万次迭代）加盐存储，不保存明文。
- **登录态**：随机 Token 存 KV，7 天过期；退出即删除。
- **建议**：本工具查询余额一般不会扣费，但请只绑定你信任的查询接口；定期在平台侧轮换密钥。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册 `{username, password}` |
| POST | `/api/auth/login` | 登录，返回 `{token}` |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/keys` | Key 列表（含缓存余额，脱敏） |
| POST | `/api/keys` | 添加 Key（先校验查询，成功才保存） |
| DELETE | `/api/keys/:id` | 删除 Key |
| POST | `/api/keys/:id/refresh` | 单个刷新 |
| POST | `/api/refresh` | 全部刷新（并行） |

## 本地验证

```bash
npm test
```

mock 测试覆盖：注册/登录/鉴权、加密存储（KV 无明文）、添加前置校验、上限 50、列表脱敏、刷新全部/单个、删除、超时容错、静态资源托管，共 32 项断言。
