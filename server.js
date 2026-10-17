'use strict';

/**
 * 站点状态监控服务 —— 零依赖，只用 Node 内置模块。
 *
 *   node server.js
 *
 * 功能：
 *   1. 按固定间隔探测 sites.config.js 中的每个站点（HTTP 状态码 + 响应耗时）
 *   2. 保存最近 N 次检测历史到 data/history.json，重启不丢
 *   3. 提供 /api/status、/api/check 接口
 *   4. 同时作为静态服务器托管 public/ 下的状态面板
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const config = require('./sites.config.js');
const PORT = Number(process.env.PORT) || Number(config.port) || 3000;

/* 状态取值 */
const STATUS = { OK: 'operational', SLOW: 'degraded', DOWN: 'down', PENDING: 'pending' };
const HISTORY_CODE = { down: 0, operational: 1, degraded: 2 };   // 存盘用的紧凑编码

/* ------------------------------------------------------------------ *
 * 1. 内存状态
 * ------------------------------------------------------------------ */
const state = new Map();

function loadHistory() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[warn] 读取历史失败：' + err.message);
  }
  for (const site of config.sites) {
    const prev = saved && Array.isArray(saved[site.id]) ? saved[site.id] : [];
    state.set(site.id, {
      history: prev.slice(-config.historySize),
      status: STATUS.PENDING,
      code: null,
      ms: null,
      error: null,
      hint: null,
      lastChecked: null,
    });
  }
}

function saveHistory() {
  const out = {};
  for (const [id, st] of state) out[id] = st.history;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(out), 'utf8');
  } catch (err) {
    console.warn('[warn] 保存历史失败：' + err.message);
  }
}

/* ------------------------------------------------------------------ *
 * 2. 单站点探测（跟随重定向，最多 3 跳）
 * ------------------------------------------------------------------ */
function probe(site) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ hint: null, ...result });
    };

    const attempt = (targetUrl, redirectsLeft) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch {
        return finish({ reachable: false, code: null, ms: Date.now() - started, error: 'URL 格式无效' });
      }

      const mod = parsed.protocol === 'http:' ? http : https;
      const req = mod.request(
        parsed,
        {
          method: 'GET',
          timeout: config.timeoutMs,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; SiteStatusBot/1.0)',
            accept: '*/*',
            'cache-control': 'no-cache',
          },
        },
        (res) => {
          const ms = Date.now() - started;
          const code = res.statusCode;

          // 跟随重定向
          if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
            res.resume();
            let next;
            try {
              next = new URL(res.headers.location, parsed).toString();
            } catch {
              return finish({ reachable: true, code, ms, error: null });
            }
            return attempt(next, redirectsLeft - 1);
          }

          res.resume();   // 丢弃响应体，避免占用连接
          finish({
            // 5xx 与网络错误视为故障；4xx 说明服务器在线，只是拒绝了本次请求
            reachable: code < 500,
            code,
            ms,
            error: code >= 500 ? `HTTP ${code}` : null,
            hint: code >= 400 && code < 500
              ? `HTTP ${code} · 服务器在线，可能开启了访问验证`
              : null,
          });
        }
      );

      req.on('timeout', () => req.destroy(new Error(`超时（>${config.timeoutMs}ms）`)));
      req.on('error', (err) =>
        finish({ reachable: false, code: null, ms: Date.now() - started, error: err.message || '请求失败' })
      );
      req.end();
    };

    attempt(site.url, 3);
  });
}

/* ------------------------------------------------------------------ *
 * 3. 一轮完整检测
 * ------------------------------------------------------------------ */
let cycleRunning = false;

async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;

  const startedAt = Date.now();
  try {
    const results = await Promise.all(
      config.sites.map(async (site) => ({ site, result: await probe(site) }))
    );

    const now = Date.now();
    for (const { site, result } of results) {
      const st = state.get(site.id);
      if (!st) continue;

      let status;
      if (!result.reachable) status = STATUS.DOWN;
      else if (result.ms > config.slowMs) status = STATUS.SLOW;
      else status = STATUS.OK;

      st.status = status;
      st.code = result.code;
      st.ms = result.ms;
      st.error = result.error;
      st.hint = result.hint || null;
      st.lastChecked = now;
      st.history.push({ t: now, s: HISTORY_CODE[status], ms: result.ms, c: result.code });

      if (st.history.length > config.historySize) {
        st.history.splice(0, st.history.length - config.historySize);
      }
    }

    saveHistory();
    const downCount = results.filter((r) => !r.result.reachable).length;
    console.log(
      `[${new Date().toLocaleTimeString('zh-CN')}] 检测完成 · ${config.sites.length} 个站点` +
        (downCount ? ` · ${downCount} 个异常` : ' · 全部正常') +
        ` · 耗时 ${Date.now() - startedAt}ms`
    );
  } catch (err) {
    console.error('[error] 检测异常：' + err.message);
  } finally {
    cycleRunning = false;
  }
}

/* ------------------------------------------------------------------ *
 * 4. 生成 API 数据
 * ------------------------------------------------------------------ */
function buildSnapshot() {
  const sites = config.sites.map((site) => {
    const st = state.get(site.id);
    const history = st.history;
    const total = history.length;
    const okCount = history.filter((h) => h.s !== HISTORY_CODE.down).length;
    const fastCount = history.filter((h) => h.s === HISTORY_CODE.operational).length;
    const sumMs = history.reduce((acc, h) => acc + (h.ms || 0), 0);

    return {
      id: site.id,
      name: site.name,
      url: site.url,
      group: site.group || '未分组',
      note: site.note || '',
      status: st.status,
      code: st.code,
      ms: st.ms,
      error: st.error,
      hint: st.hint,
      lastChecked: st.lastChecked,
      uptime: total ? (okCount / total) * 100 : null,          // 可用率（非故障占比）
      fastRate: total ? (fastCount / total) * 100 : null,      // 良好率（未标记缓慢）
      avgMs: total ? Math.round(sumMs / total) : null,
      checks: total,
      history: history.slice(-40),
    };
  });

  let overall = STATUS.PENDING;
  if (sites.some((s) => s.status === STATUS.DOWN)) overall = STATUS.DOWN;
  else if (sites.some((s) => s.status === STATUS.SLOW)) overall = STATUS.SLOW;
  else if (sites.some((s) => s.status === STATUS.OK)) overall = STATUS.OK;

  return {
    title: config.title,
    subtitle: config.subtitle,
    overall,
    updatedAt: Date.now(),
    intervalMs: config.intervalMs,
    slowMs: config.slowMs,
    counts: {
      total: sites.length,
      up: sites.filter((s) => s.status === STATUS.OK).length,
      slow: sites.filter((s) => s.status === STATUS.SLOW).length,
      down: sites.filter((s) => s.status === STATUS.DOWN).length,
      pending: sites.filter((s) => s.status === STATUS.PENDING).length,
    },
    sites,
  };
}

/* ------------------------------------------------------------------ *
 * 5. HTTP 服务：API + 静态文件
 * ------------------------------------------------------------------ */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': MIME['.json'],
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // 防目录穿越：解析后的路径必须仍在 public 目录内
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (pathname === '/api/status') {
    return sendJson(res, 200, buildSnapshot());
  }

  if (pathname === '/api/check') {
    await runCycle();                       // 立即触发一轮检测
    return sendJson(res, 200, buildSnapshot());
  }

  if (pathname === '/api/config') {
    return sendJson(res, 200, {
      title: config.title,
      subtitle: config.subtitle,
      intervalMs: config.intervalMs,
      timeoutMs: config.timeoutMs,
      slowMs: config.slowMs,
      sites: config.sites.map(({ id, name, url, group }) => ({ id, name, url, group })),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('405 Method Not Allowed');
  }

  return serveStatic(req, res, pathname);
});

/* ------------------------------------------------------------------ *
 * 6. 启动
 * ------------------------------------------------------------------ */
loadHistory();

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('');
  console.log('  站点状态监控已启动');
  console.log('  ────────────────────────────────────');
  console.log(`  面板地址   ${url}`);
  console.log(`  监控站点   ${config.sites.length} 个`);
  console.log(`  检测间隔   ${Math.round(config.intervalMs / 1000)} 秒`);
  console.log('  ────────────────────────────────────');
  console.log('  按 Ctrl+C 停止');
  console.log('');

  runCycle();                                                        // 启动即检测一次
  const timer = setInterval(runCycle, config.intervalMs);
  timer.unref?.();
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[error] 端口 ${PORT} 已被占用，可用 PORT=3001 node server.js 换一个端口。`);
  } else {
    console.error('[error] ' + err.message);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在退出，保存历史…');
    saveHistory();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
