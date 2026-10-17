'use strict';

/**
 * 可编辑配置的持久化层。
 *
 * 只有「监控站点列表」与「公告横幅」是可编辑的；标题、探测间隔、超时等
 * 仍然留在 sites.config.js 里（那些属于部署期参数，不该让页面改）。
 *
 * 存储：data/settings.json（首次启动用 sites.config.js 的 sites 作为种子）。
 * data/ 已在 .gitignore 中，所以运行期数据不会进版本库。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const defaults = require('../sites.config.js');

const MAX_SITES = 50;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const BANNER_LEVELS = ['info', 'warning', 'critical'];

let current = null;

function blankBanner() {
  return { enabled: false, text: '', level: 'info' };
}

function fail(message) {
  const err = new Error(message);
  err.expose = true; // 可以直接回显给前端
  throw err;
}

function genId() {
  return 'site-' + crypto.randomBytes(4).toString('hex');
}

function normalizeText(value, field, max) {
  if (value == null) return '';
  if (typeof value !== 'string') fail(`${field} 必须是字符串`);
  const text = value.trim();
  if (text.length > max) fail(`${field} 不能超过 ${max} 个字符`);
  return text;
}

/** 站点地址只允许 http/https，避免被塞成 javascript: 之类。 */
function normalizeUrl(value) {
  const raw = normalizeText(value, '站点地址', 500);
  if (!raw) fail('站点地址不能为空');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(`站点地址不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail('站点地址只支持 http / https');
  }
  // 校验用 URL 解析，但保存用户原本写的字符串（避免 https://a.com 变成 https://a.com/）
  return raw;
}

function validateSites(input) {
  if (!Array.isArray(input)) fail('sites 必须是数组');
  if (input.length > MAX_SITES) fail(`最多只能配置 ${MAX_SITES} 个站点`);

  const seen = new Set();
  const out = [];

  input.forEach((item, index) => {
    if (!item || typeof item !== 'object') fail(`第 ${index + 1} 个站点格式不正确`);

    const name = normalizeText(item.name, '站点名称', 60);
    if (!name) fail(`第 ${index + 1} 个站点缺少名称`);

    const url = normalizeUrl(item.url);

    let id = normalizeText(item.id, '站点 ID', 40);
    if (!id) id = genId();
    if (!ID_RE.test(id)) {
      fail(`站点 ID「${id}」不合法：只能用小写字母、数字和连字符，且以字母或数字开头`);
    }
    if (seen.has(id)) fail(`站点 ID「${id}」重复了`);
    seen.add(id);

    out.push({
      id,
      name,
      url,
      group: normalizeText(item.group, '分组', 40) || '未分组',
      note: normalizeText(item.note, '备注', 200),
    });
  });

  return out;
}

function validateBanner(input) {
  if (input == null) return blankBanner();
  if (typeof input !== 'object') fail('banner 格式不正确');

  const level = BANNER_LEVELS.includes(input.level) ? input.level : 'info';
  const text = normalizeText(input.text, '横幅文案', 200);

  // 没有文案就自动关掉，避免出现一条空白横幅
  const enabled = Boolean(input.enabled) && text.length > 0;

  return { enabled, text, level };
}

function readSaved() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[warn] 读取 settings.json 失败，回退到 sites.config.js：' + err.message);
    }
    return null;
  }
}

function load() {
  const saved = readSaved();

  let sites;
  try {
    // 已保存的配置优先；没有就（或解析失败）用 sites.config.js 的种子
    sites = validateSites(saved && Array.isArray(saved.sites) ? saved.sites : defaults.sites);
  } catch (err) {
    console.warn('[warn] 站点配置不合法，回退到 sites.config.js：' + err.message);
    sites = validateSites(defaults.sites);
  }

  let banner;
  try {
    banner = validateBanner(saved && saved.banner);
  } catch (err) {
    console.warn('[warn] 横幅配置不合法，已重置：' + err.message);
    banner = blankBanner();
  }

  current = { sites, banner };
  return current;
}

function get() {
  if (!current) load();
  return current;
}

/**
 * 保存配置。先写临时文件再 rename —— rename 在同一分区上是原子的，
 * 这样即使进程在写入过程中被杀，也不会留下半截 JSON。
 */
function save(next) {
  const sites = validateSites(next && next.sites);
  const banner = validateBanner(next && next.banner);

  const payload = { sites, banner, updatedAt: new Date().toISOString() };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);

  current = { sites, banner };
  return payload;
}

module.exports = { get, load, save, blankBanner, BANNER_LEVELS, MAX_SITES };
