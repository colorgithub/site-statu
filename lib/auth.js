'use strict';

/**
 * vault（MemoVault）OAuth 2.0 客户端 + 极简会话。
 *
 * 设计前提：**只有管理员才允许持有会话**。
 * 非管理员即使走完 OAuth，也会在回调里被立刻清掉 Cookie 打回首页；
 * 并且每次校验会话都会重新比对 ADMIN_EMAILS —— 把人从名单里删掉，
 * 他手里的旧 Cookie 也立即失效。
 *
 * 全部用 Node 内置模块实现，保持项目「零依赖」。
 */

const crypto = require('node:crypto');

const COOKIE_SESSION = 'statu_session';
const COOKIE_STATE = 'statu_oauth_state';
const COOKIE_VERIFIER = 'statu_oauth_verifier';

const FLOW_MAX_AGE = 10 * 60;            // 授权流程临时 Cookie：10 分钟
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 会话：7 天
const MIN_SECRET_LENGTH = 16;

function env(name) {
  return (process.env[name] || '').trim();
}

function getConfig() {
  return {
    sessionSecret: env('SESSION_SECRET'),
    issuer: env('VAULT_ISSUER').replace(/\/+$/, ''),
    clientId: env('OAUTH_CLIENT_ID'),
    clientSecret: env('OAUTH_CLIENT_SECRET'),
    redirectUri: env('OAUTH_REDIRECT_URI'),
    adminEmails: env('ADMIN_EMAILS')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  };
}

function isConfigured() {
  const c = getConfig();
  return Boolean(
    c.sessionSecret.length >= MIN_SECRET_LENGTH &&
      c.issuer &&
      c.clientId &&
      c.clientSecret &&
      c.redirectUri &&
      c.adminEmails.length > 0
  );
}

function isAdminEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return false;
  return getConfig().adminEmails.includes(target);
}

/**
 * 配置自检：只返回**变量名**与问题性质，绝不返回变量的值。
 *
 * 页面上「没有登录入口」最常见的原因就是少配了某个变量，但之前接口只回一个
 * configured=false，看不出是哪一项。这个函数让 /api/me 能直接说清楚。
 */
function getConfigStatus() {
  const c = getConfig();
  const missing = [];

  if (!c.sessionSecret) missing.push('SESSION_SECRET');
  else if (c.sessionSecret.length < MIN_SECRET_LENGTH) {
    missing.push(`SESSION_SECRET(需≥${MIN_SECRET_LENGTH}字符, 当前${c.sessionSecret.length})`);
  }
  if (!c.issuer) missing.push('VAULT_ISSUER');
  if (!c.clientId) missing.push('OAUTH_CLIENT_ID');
  if (!c.clientSecret) missing.push('OAUTH_CLIENT_SECRET');
  if (!c.redirectUri) missing.push('OAUTH_REDIRECT_URI');
  if (c.adminEmails.length === 0) missing.push('ADMIN_EMAILS');

  return { ready: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ *
 * PKCE / state
 * ------------------------------------------------------------------ */
const b64url = (buf) => buf.toString('base64url');

function createFlowSecrets() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  return { verifier, challenge, state };
}

/**
 * 解析本次请求应该使用的回调地址。
 *
 * 站点同时挂在多个域名上（例如 colordev.space 与 color111111.dpdns.org），
 * 而 OAuth 的回调地址必须是**发起登录时的那个域名** —— 否则 state Cookie
 * 写在 A 域名、回调却落到 B 域名，校验必然失败。
 *
 * 所以 OAUTH_REDIRECT_URI 支持逗号分隔多个地址，按请求的 origin 匹配；
 * 匹配不到时退回第一个（单域名场景就是它本身）。
 */
function requestOrigin(req) {
  const protoHeader = req.headers['x-forwarded-proto'];
  const proto =
    (typeof protoHeader === 'string' && protoHeader.split(',')[0].trim()) ||
    (isSecureRequest(req) ? 'https' : 'http');

  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const host = (typeof hostHeader === 'string' && hostHeader.split(',')[0].trim()) || '';

  return host ? `${proto}://${host}` : '';
}

function resolveRedirectUri(req) {
  const list = env('OAUTH_REDIRECT_URI')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  if (list.length === 0) return '';
  if (list.length === 1) return list[0];

  const origin = requestOrigin(req);
  if (origin) {
    const matched = list.find((uri) => uri.startsWith(origin + '/'));
    if (matched) return matched;
  }
  return list[0];
}

function buildAuthorizeUrl({ state, challenge, redirectUri }) {
  const c = getConfig();
  const url = new URL(`${c.issuer}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * 令牌交换 / 用户信息
 * ------------------------------------------------------------------ */
async function exchangeCode(code, verifier, redirectUri) {
  const c = getConfig();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code_verifier: verifier,
  });

  const res = await fetch(`${c.issuer}/api/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON，按状态码处理 */
  }

  if (!res.ok) {
    const detail = data && (data.error_description || data.error) ? `：${data.error_description || data.error}` : '';
    throw new Error(`令牌交换失败（HTTP ${res.status}）${detail}`);
  }
  if (!data || typeof data.access_token !== 'string') {
    throw new Error('令牌响应里没有 access_token');
  }
  return data.access_token;
}

async function fetchProfile(accessToken) {
  const c = getConfig();
  const res = await fetch(`${c.issuer}/api/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* ignore */
  }

  if (!res.ok) throw new Error(`获取用户信息失败（HTTP ${res.status}）`);

  const email = data && typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  const sub = data && typeof data.sub === 'string' ? data.sub : '';
  const name = data && typeof data.name === 'string' ? data.name.trim() : '';

  if (!sub || !email) throw new Error('用户信息缺少 sub 或 email');
  return { sub, email, name: name || email.split('@')[0] };
}

/* ------------------------------------------------------------------ *
 * 会话 Cookie：base64url(payload) + "." + HMAC-SHA256
 * ------------------------------------------------------------------ */
function signSession(payload) {
  const secret = getConfig().sessionSecret;
  if (!secret) throw new Error('缺少 SESSION_SECRET');
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

function verifySession(token) {
  const secret = getConfig().sessionSecret;
  if (!secret || typeof token !== 'string' || !token) return null;

  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(crypto.createHmac('sha256', secret).update(body).digest());

  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload.email !== 'string') return null;
  if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;

  // 关键：会话有效期不等于管理员有效期。每次校验都重新比对名单，
  // 这样把某人从 ADMIN_EMAILS 移除后，旧 Cookie 立刻失效。
  if (!isAdminEmail(payload.email)) return null;

  return payload;
}

/* ------------------------------------------------------------------ *
 * Cookie 工具
 * ------------------------------------------------------------------ */

/** 恒定时间字符串比较，用于 state 等一次性值的校验。 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/** 请求是否走 HTTPS（Railway / 反向代理后面）。 */
function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  if (typeof proto === 'string' && proto.split(',')[0].trim() === 'https') return true;
  return Boolean(req.socket && req.socket.encrypted);
}

function serializeCookie(req, name, value, maxAge) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function buildSessionCookie(req, payload) {
  return serializeCookie(req, COOKIE_SESSION, signSession(payload), SESSION_MAX_AGE);
}

function clearCookie(req, name) {
  return serializeCookie(req, name, '', 0);
}

/** 从请求里取出当前管理员会话；没有/失效/非管理员都返回 null。 */
function getSession(req) {
  const cookies = parseCookies(req);
  return verifySession(cookies[COOKIE_SESSION]);
}

module.exports = {
  COOKIE_SESSION,
  COOKIE_STATE,
  COOKIE_VERIFIER,
  FLOW_MAX_AGE,
  SESSION_MAX_AGE,
  getConfig,
  isConfigured,
  getConfigStatus,
  isAdminEmail,
  createFlowSecrets,
  buildAuthorizeUrl,
  resolveRedirectUri,
  exchangeCode,
  fetchProfile,
  signSession,
  verifySession,
  getSession,
  safeEqual,
  parseCookies,
  serializeCookie,
  buildSessionCookie,
  clearCookie,
};
