# 站点状态监控

一个零依赖的站点状态面板：本地 Node 服务定时探测各个站点的 HTTP 状态与响应耗时，页面实时展示可用率、响应时间和最近 40 次检测的心跳条。

管理员可以通过 **MemoVault（vault）OAuth 登录**后，直接在页面上增删改监控站点、维护一条公告横幅 —— 不用改代码再重新部署。

不装任何 npm 包，只用 Node 内置模块。

## 快速开始

```bash
cd D:\sites\homepage
node server.js          # 或 npm start
```

然后打开 <http://localhost:3000>。

服务启动后会立刻检测一轮，之后按 `intervalMs` 定时检测。页面每 15 秒拉取一次最新数据，也可以点「刷新」立即触发一轮检测。

## 配置监控目标

只需要改 [`sites.config.js`](sites.config.js)：

```js
module.exports = {
  title: '站点状态',
  subtitle: '实时监控各站点可用性与响应速度',

  intervalMs: 60 * 1000,   // 探测间隔
  timeoutMs: 10 * 1000,    // 单次请求超时
  slowMs: 1500,            // 超过该耗时标记为「缓慢」
  historySize: 60,         // 每站保留的检测次数
  port: 3000,              // 监听端口

  sites: [
    { id: 'github', name: 'GitHub', url: 'https://github.com', group: '开发平台' },
    // ...
  ],
};
```

### 站点字段

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 唯一标识，用于保存历史数据；**改了 id 会丢失该站的历史** |
| `name` | 是 | 面板上显示的名称 |
| `url` | 是 | 完整地址，支持 `http` / `https`，可以带路径，如 `https://example.com/health` |
| `group` | 否 | 分组名，面板按分组展示，默认「未分组」 |
| `note` | 否 | 备注，鼠标悬停时显示 |

### 加上你自己的站点

```js
sites: [
  { id: 'my-blog',  name: '我的博客',  url: 'http://localhost:3001', group: '自建站点' },
  { id: 'my-api',   name: 'API 网关',  url: 'http://localhost:8080/health', group: '自建站点' },
  { id: 'my-site',  name: '线上主站',  url: 'https://example.com', group: '自建站点' },
]
```

> 探测本地服务时，请确保该服务已经启动，否则会显示为「故障」。

> **`sites.config.js` 现在只是初始种子。** 管理员在页面上改过之后，配置会保存到
> `data/settings.json`，并以后者为准 —— 改 `sites.config.js` 不会影响已经在运行的实例
> （除非删掉 `data/settings.json` 重启）。

## 管理员登录与在线编辑

### 设计前提

这是一个**公开只读**的状态页：任何人都能查看状态，但只有管理员能编辑。

登录用的是 vault 的 OAuth（授权码 + PKCE）。和博客不同的是，这里的规则更严格：

> **只有 `ADMIN_EMAILS` 里的邮箱能留下会话；其他人即使完成授权，也会在回调里被立刻清掉
> Cookie 并打回首页。**

所以「登录」在这套系统里等价于「申请管理员权限」，没有普通用户登录这一说。
每次校验会话还会重新比对 `ADMIN_EMAILS` —— 把人从名单里删掉，他手里的旧 Cookie 立即失效。

### 配置

在环境变量里填（本地开发可写进 `.env` 或用 `set`/`export`；Railway 在 Variables 里加）：

| 变量 | 说明 |
| --- | --- |
| `SESSION_SECRET` | 会话签名密钥，≥16 字符。生成：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `VAULT_ISSUER` | vault 地址，如 `https://vault.colordev.space` |
| `OAUTH_CLIENT_ID` | 客户端标识，如 `statu` |
| `OAUTH_CLIENT_SECRET` | 与 vault 里登记的保持一致 |
| `OAUTH_REDIRECT_URI` | 如 `https://colordev.space/auth/callback`，必须与 vault 里完全一致。**站点有多个域名时用英文逗号分隔**，服务端按当前访问域名自动挑选，否则跨域会丢 state Cookie 导致登录失败 |
| `ADMIN_EMAILS` | 管理员邮箱，逗号分隔；必须与 MemoVault 账号一致 |

**同时要在 vault 的 `OAUTH_CLIENTS` 里注册这个客户端**，`redirectUris` 填上面的
`OAUTH_REDIRECT_URI`。五个变量缺任意一个，页面右上角就不会出现管理入口。

### 能改什么

点右上角的管理图标 → MemoVault 登录 → 回到页面后出现「编辑」按钮：

- **公告横幅**：开关、文案（最多 200 字）、级别（提示 / 注意 / 严重）
  - 文案留空会自动关掉，不会出现空白横幅
- **监控站点**：增删改 名称 / 地址 / 分组
  - 地址只接受 `http` / `https`，其他协议会被服务端拒绝
  - 新站点自动生成 id；已有站点改名不影响它的历史记录
  - 删除站点会一并清掉它的检测历史

改动会原子写入 `data/settings.json`（先写临时文件再 rename），并立刻触发一轮检测。

### 数据在哪

```
data/
├─ history.json    检测历史（按站点 id 存，自动生成）
└─ settings.json   站点列表 + 公告横幅（页面编辑后生成）
```

`data/` 已在 `.gitignore` 中。**注意**：如果部署在无持久化卷的容器里（Railway 默认如此），
重启后 `data/settings.json` 会丢失、回退到 `sites.config.js` 的种子配置。需要长期保留
请在 Railway 上挂载 Volume。

## 状态判定规则

| 显示 | 含义 | 判定条件 |
| --- | --- | --- |
| 🟢 正常 | operational | 能连上且响应耗时 ≤ `slowMs` |
| 🟠 缓慢 | degraded | 能连上但响应耗时 > `slowMs` |
| 🔴 故障 | down | 连接失败、超时、DNS 解析失败，或返回 5xx |
| ⚪ 检测中 | pending | 尚未完成首次检测 |

说明：

- **4xx 不算故障**。像 Stack Overflow、Cloudflare 这类站点会对脚本请求返回 403，但服务器本身是在线的，因此仍标记为「正常」，状态码会附在响应时间后面（如 `516 ms · 403`）。
- 探测会自动跟随重定向，最多 3 跳。
- 请求使用 `GET`，拿到响应头后立即丢弃响应体，不会下载整个页面。
- 可用率 = 非故障检测次数 ÷ 总检测次数（基于本地保存的历史）。

## 目录结构

```
homepage/
├─ server.js            探测服务 + API + 路由 + 静态服务器
├─ sites.config.js      ← 初始种子配置（首次启动用，之后以 data/settings.json 为准）
├─ package.json
├─ .env.example         环境变量说明（管理登录相关）
├─ lib/
│  ├─ settings.js       可编辑配置的读写与校验（原子写入）
│  └─ auth.js           vault OAuth 客户端 + 会话签名/校验
├─ public/
│  ├─ index.html        面板页面 + 编辑弹窗
│  ├─ styles.css
│  └─ app.js
└─ data/                （.gitignore 忽略，运行期数据）
   ├─ history.json      检测历史
   └─ settings.json     站点列表 + 公告横幅
```

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | 返回当前快照：总体状态、公告横幅、各站点状态、可用率、平均响应、最近 40 次历史 |
| `GET /api/check` | 立即触发一轮检测，返回检测后的快照（耗时取决于最慢的站点） |
| `GET /api/config` | 返回当前配置（不含敏感信息） |
| `GET /api/settings` | 返回可编辑部分：站点列表 + 公告横幅 |
| `PUT /api/settings` | **需管理员会话**。保存站点列表与横幅，非法输入返回 400 |
| `GET /api/me` | 返回 `{ authenticated, admin, configured }`，前端据此决定是否显示编辑入口 |
| `GET /auth/login` | 跳转到 vault 授权页（302） |
| `GET /auth/callback` | OAuth 回调；**非管理员会被立即登出**并重定向到 `/?error=not_admin` |
| `GET /auth/logout` | 清空会话并回首页 |

`/api/status` 返回示例：

```json
{
  "overall": "operational",
  "counts": { "total": 6, "up": 6, "slow": 0, "down": 0, "pending": 0 },
  "sites": [
    {
      "id": "github",
      "name": "GitHub",
      "url": "https://github.com",
      "group": "开发平台",
      "status": "operational",
      "code": 200,
      "ms": 360,
      "uptime": 100,
      "avgMs": 372,
      "history": [{ "t": 1760000000000, "s": 1, "ms": 360, "c": 200 }]
    }
  ]
}
```

## 常见问题

**端口被占用**：换一个端口启动，例如 `PORT=3001 node server.js`（PowerShell 里用 `$env:PORT=3001; node server.js`）。

**想让服务一直跑着**：Windows 下可以用 `pm2`、`nssm`，或者写成计划任务；也可以放到服务器上配合 `systemd` / `docker` 运行。

**历史数据太大了**：每个站点只保留最近 `historySize` 条（默认 60 条），文件很小。想清零直接删掉 `data/history.json` 再重启。

**想公网访问**：读取是公开的，编辑已经用 vault OAuth + 管理员白名单保护，可以直接暴露。
如果连读取也想限制，再自行加一层反向代理与访问控制。
