# 站点状态监控

一个零依赖的站点状态面板：本地 Node 服务定时探测各个站点的 HTTP 状态与响应耗时，页面实时展示可用率、响应时间和最近 40 次检测的心跳条。

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
├─ server.js            探测服务 + API + 静态服务器
├─ sites.config.js      ← 要监控的站点写在这里
├─ package.json
├─ public/
│  ├─ index.html        面板页面
│  ├─ styles.css
│  └─ app.js
└─ data/
   └─ history.json      检测历史（自动生成，已在 .gitignore 中忽略）
```

## API

| 接口 | 说明 |
| --- | --- |
| `GET /api/status` | 返回当前快照：总体状态、各站点状态、可用率、平均响应、最近 40 次历史 |
| `GET /api/check` | 立即触发一轮检测，返回检测后的快照（耗时取决于最慢的站点） |
| `GET /api/config` | 返回当前配置（不含敏感信息） |

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

**想公网访问**：这个服务本身没有做鉴权，直接暴露到公网前请自行加一层反向代理与访问控制。
