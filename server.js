'use strict';

/**
 * 站点状态监控服务 —— 零依赖，只用 Node 内置模块。
 *
 *   node server.js
 *
 * 功能：
 *   1. 按固定间隔探测监控列表里的每个站点（HTTP 状态码 + 响应耗时）
 *   2. 保存最近 N 次检测历史到 data/history.json，重启不丢
 *   3. 提供 /api/status、/api/check 接口
 *   4. 同时作为静态服务器托管 public/ 下的状态面板
 *   5. 管理员可通过 vault OAuth 登录后，在页面上编辑「监控站点」与「公告横幅」
 *
 * 可编辑配置存在 data/settings.json；首次启动用 sites.config.js 的 sites 做种子。
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const config = require('./sites.config.js');
const settings = require('./lib/settings.js');
const auth = require('./lib/auth.js');

const PORT = Number(process.env.PORT) || Number(config.port) || 3000;

/* 状态取值 */
const STATUS = { OK: 'operational', SLOW: 'degraded', DOWN: 'down', PENDING: 'pending' };
const HISTORY_CODE = { down: 0, operational: 1, degraded: 2 };   // 存盘用的紧凑编码

/* ------------------------------------------------------------------ *
 * 1. 内存状态
 * ------------------------------------------------------------------ */
const state = new Map();

function emptyState(history) {
  return {
    history: Array.isArray(history) ? history.slice(-config.historySize) : [],
    status: STATUS.PENDING,
    code: null,
    ms: null,
    error: null,
    hint: null,
    lastChecked: null,
  };
}

function loadHistory() {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[warn] 读取历史失败：' + err.message);
  }

  state.clear();
  for (const site of settings.get().sites) {
    const prev = saved && Array.isArray(saved[site.id]) ? saved[site.id] : [];
    state.set(site.id, emptyState(prev));
  }
}

/**
 * 让内存状态与当前站点列表对齐：
 * 保留下来的站点沿用历史，新增的空状态开始，删掉的直接丢弃。
 */
function syncState() {
  const sites = settings.get().sites;
  const keep = new Set(sites.map((site) => site.id));

  for (const id of [...state.keys()]) {
    if (!keep.has(id)) state.delete(id);
  }
  for (const site of sites) {
    if (!state.has(site.id)) state.set(site.id, emptyState());
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
    const sites = settings.get().sites;
    const results = await Promise.all(
      sites.map(async (site) => ({ site, result: await probe(site) }))
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
      `[${new Date().toLocaleTimeString('zh-CN')}] 检测完成 · ${sites.length} 个站点` +
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
  const current = settings.get();

  const sites = current.sites.map((site) => {
    const st = state.get(site.id) || emptyState();
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
    // 公告横幅与状态条是两回事：横幅由管理员手写，状态条由探测结果驱动
    banner: current.banner,
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
 * 5. HTTP 工具
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

function sendJson(res, code, payload, extraHeaders) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'content-type': MIME['.json'],
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function redirect(res, location, cookies) {
  const headers = { location };
  if (cookies && cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error('请求体过大');
        err.expose = true;
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        const err = new Error('请求体不是合法 JSON');
        err.expose = true;
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

/**
 * 静态资源的内容指纹。
 *
 * 部署到 Railway / Cloudflare 之后，边缘节点会把 .js / .css 缓存起来
 * （实测被改写成 max-age=14400），而 HTML 是 no-cache。
 * 结果就是「新 HTML + 旧 JS」，页面直接报错。
 * 给资源链接带上内容哈希，文件一变 URL 就变，缓存自然失效。
 */
function contentVersion(relPath) {
  try {
    const buf = fs.readFileSync(path.join(PUBLIC_DIR, relPath));
    return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
  } catch {
    return '0';
  }
}

function withAssetVersions(buf) {
  let html = buf.toString('utf8');
  for (const file of ['styles.css', 'app.js']) {
    html = html.split(`"${file}"`).join(`"${file}?v=${contentVersion(file)}"`);
  }
  return Buffer.from(html, 'utf8');
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

    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const body = isHtml ? withAssetVersions(buf) : buf;

    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': body.length,
      // HTML 每次校验；带指纹的资源可以长期缓存
      'cache-control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(body);
  });
}

/* ------------------------------------------------------------------ *
 * 6. 认证路由（vault OAuth）
 * ------------------------------------------------------------------ */
function handleLogin(req, res) {
  if (!auth.isConfigured()) {
    return redirect(res, '/?error=auth_not_configured');
  }

  const { verifier, challenge, state } = auth.createFlowSecrets();
  // 按当前访问域名挑选回调地址（站点同时挂在多个域名上）
  const redirectUri = auth.resolveRedirectUri(req);

  if (!redirectUri) {
    console.warn('[auth] OAUTH_REDIRECT_URI 没有配置');
    return redirect(res, '/?error=auth_not_configured');
  }

  const cookies = [
    auth.serializeCookie(req, auth.COOKIE_STATE, state, auth.FLOW_MAX_AGE),
    auth.serializeCookie(req, auth.COOKIE_VERIFIER, verifier, auth.FLOW_MAX_AGE),
  ];

  return redirect(res, auth.buildAuthorizeUrl({ state, challenge, redirectUri }), cookies);
}

async function handleCallback(req, res, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  const cookies = auth.parseCookies(req);
  const expectedState = cookies[auth.COOKIE_STATE] || '';
  const verifier = cookies[auth.COOKIE_VERIFIER] || '';

  // 无论成败，临时 Cookie 都要清掉
  const clearFlow = [
    auth.clearCookie(req, auth.COOKIE_STATE),
    auth.clearCookie(req, auth.COOKIE_VERIFIER),
  ];

  const bail = (reason) => {
    redirect(res, `/?error=${encodeURIComponent(reason)}`, clearFlow);
  };

  if (oauthError) {
    console.warn('[auth] 授权失败或被拒绝：' + oauthError);
    return bail(oauthError);
  }
  if (!state || !expectedState || !auth.safeEqual(state, expectedState)) {
    console.warn('[auth] state 校验失败');
    return bail('invalid_state');
  }
  if (!code || !verifier) {
    console.warn('[auth] 回调缺少 code 或 verifier');
    return bail('missing_code');
  }

  try {
    const redirectUri = auth.resolveRedirectUri(req);
    const accessToken = await auth.exchangeCode(code, verifier, redirectUri);
    const profile = await auth.fetchProfile(accessToken);

    // 核心规则：只有管理员能留下会话，其他人当场登出
    if (!auth.isAdminEmail(profile.email)) {
      console.warn(`[auth] 非管理员登录，已立即退出：${profile.email}`);
      return bail('not_admin');
    }

    const session = auth.buildSessionCookie(req, {
      sub: profile.sub,
      email: profile.email,
      name: profile.name,
      exp: Date.now() + auth.SESSION_MAX_AGE * 1000,
    });

    console.log(`[auth] 管理员登录：${profile.email}`);
    return redirect(res, '/', [...clearFlow, session]);
  } catch (err) {
    console.error('[auth] 回调处理失败：' + err.message);
    return bail('oauth_failed');
  }
}

function handleLogout(req, res) {
  return redirect(res, '/', [auth.clearCookie(req, auth.COOKIE_SESSION)]);
}

function handleMe(req, res) {
  const session = auth.getSession(req);
  const cookies = auth.parseCookies(req);
  const hadCookie = Boolean(cookies[auth.COOKIE_SESSION]);

  // Cookie 存在但已失效（过期 / 被移出 ADMIN_EMAILS）→ 顺手清掉
  const extra = !session && hadCookie ? { 'set-cookie': [auth.clearCookie(req, auth.COOKIE_SESSION)] } : undefined;

  if (!session) {
    // 顺手告诉前端缺哪些环境变量（只有变量名，不含值），比一个 configured=false 有用得多
    const status = auth.getConfigStatus();
    return sendJson(
      res,
      200,
      {
        authenticated: false,
        admin: false,
        configured: status.ready,
        missing: status.ready ? undefined : status.missing,
      },
      extra
    );
  }
  return sendJson(
    res,
    200,
    { authenticated: true, admin: true, configured: true, email: session.email, name: session.name },
    extra
  );
}

/* ------------------------------------------------------------------ *
 * 7. 配置读写
 * ------------------------------------------------------------------ */
function handleGetSettings(req, res) {
  const current = settings.get();
  return sendJson(res, 200, { sites: current.sites, banner: current.banner });
}

async function handlePutSettings(req, res) {
  const session = auth.getSession(req);
  if (!session) {
    return sendJson(res, 401, { error: '未登录或没有管理员权限' });
  }

  try {
    const body = await readJsonBody(req);
    const saved = settings.save({ sites: body.sites, banner: body.banner });

    // 站点有增删时同步内存状态，并补跑一轮检测让新站点尽快出状态
    syncState();
    runCycle().catch((err) => console.error('[error] 保存后补检测失败：' + err.message));

    console.log(
      `[settings] ${session.email} 更新配置 · ${saved.sites.length} 个站点 · 横幅${
        saved.banner.enabled ? '开' : '关'
      }`
    );
    return sendJson(res, 200, { ok: true, sites: saved.sites, banner: saved.banner });
  } catch (err) {
    if (!err.expose) console.error('[error] 保存配置失败：' + err.message);
    return sendJson(res, err.expose ? 400 : 500, {
      error: err.expose ? err.message : '保存失败，请查看服务端日志',
    });
  }
}

/* ------------------------------------------------------------------ *
 * 8. 路由
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  /* ---- 认证 ---- */
  if (pathname === '/auth/login' && req.method === 'GET') return handleLogin(req, res);
  if (pathname === '/auth/callback' && req.method === 'GET') return handleCallback(req, res, url);
  if (pathname === '/auth/logout') return handleLogout(req, res);

  /* ---- 账号与配置 ---- */
  if (pathname === '/api/me' && req.method === 'GET') return handleMe(req, res);
  if (pathname === '/api/settings' && req.method === 'GET') return handleGetSettings(req, res);
  if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'PATCH')) {
    return handlePutSettings(req, res);
  }

  /* ---- 只读数据 ---- */
  if (pathname === '/api/status') {
    return sendJson(res, 200, buildSnapshot());
  }

  if (pathname === '/api/check') {
    await runCycle();                       // 立即触发一轮检测
    return sendJson(res, 200, buildSnapshot());
  }

  if (pathname === '/api/config') {
    const current = settings.get();
    return sendJson(res, 200, {
      title: config.title,
      subtitle: config.subtitle,
      intervalMs: config.intervalMs,
      timeoutMs: config.timeoutMs,
      slowMs: config.slowMs,
      sites: current.sites.map(({ id, name, url, group }) => ({ id, name, url, group })),
    });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('405 Method Not Allowed');
  }

  return serveStatic(req, res, pathname);
});

/* ------------------------------------------------------------------ *
 * 9. 启动
 * ------------------------------------------------------------------ */
settings.load();
loadHistory();

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  const current = settings.get();

  console.log('');
  console.log('  站点状态监控已启动');
  console.log('  ────────────────────────────────────');
  console.log(`  面板地址   ${url}`);
  console.log(`  监控站点   ${current.sites.length} 个`);
  console.log(`  检测间隔   ${Math.round(config.intervalMs / 1000)} 秒`);
  const authStatus = auth.getConfigStatus();
  console.log(`  管理登录   ${authStatus.ready ? '已启用（vault OAuth）' : '未启用'}`);
  if (!authStatus.ready) {
    console.log(`  缺少变量   ${authStatus.missing.join('、')}`);
  }
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
