/* ==========================================================================
   站点状态面板 · app.js
   ========================================================================== */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const STATUS_TEXT = {
    operational: '正常',
    degraded: '缓慢',
    down: '故障',
    pending: '检测中',
  };

  const OVERALL_TEXT = {
    operational: ['全部系统正常', '所有站点均可正常访问'],
    degraded: ['部分站点响应缓慢', '站点可访问，但响应时间偏高'],
    down: ['有站点出现故障', '请查看下方异常站点的详细信息'],
    pending: ['正在检测…', '首次检测可能需要几秒钟'],
  };

  const BAR_CLASS = { 1: 'bar--ok', 2: 'bar--slow', 0: 'bar--down' };
  const DOT_CLASS = { operational: 'dot--ok', degraded: 'dot--slow', down: 'dot--down', pending: 'dot--pending' };
  const PILL_CLASS = { operational: 'pill--ok', degraded: 'pill--slow', down: 'pill--down', pending: 'pill--pending' };
  const BAR_COUNT = 40;

  /* ---------- 工具 ---------- */
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );

  const timeText = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return d.toLocaleTimeString('zh-CN', { hour12: false });
  };

  const pct = (v) => (v == null ? '—' : v.toFixed(v >= 99.95 || v === 0 ? 0 : 1) + '%');
  const msText = (v) => (v == null ? '—' : Math.round(v) + ' ms');

  /* ---------- 主题 ---------- */
  const root = document.documentElement;
  const themeToggle = $('#themeToggle');
  const THEME_COLORS = { dark: '#0b0b0d', light: '#fafafa' };
  const metaTheme = document.querySelector('meta[name="theme-color"]');

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    if (metaTheme) metaTheme.setAttribute('content', THEME_COLORS[theme] || THEME_COLORS.dark);
  }

  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('status-theme'); } catch (e) { /* ignore */ }
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    applyTheme(saved || (prefersLight ? 'light' : 'dark'));
  })();

  themeToggle?.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('status-theme', next); } catch (e) { /* ignore */ }
  });

  /* ---------- 提示条 ---------- */
  const toast = $('#toast');
  let toastTimer = null;

  function showToast(msg, isErr) {
    if (!toast) return;
    toast.textContent = msg;
    toast.className = 'toast is-on' + (isErr ? ' is-err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2600);
  }

  /* ---------- 渲染 ---------- */
  function renderBanner(data) {
    const banner = $('#banner');
    const overall = data.overall || 'pending';
    const [title, desc] = OVERALL_TEXT[overall] || OVERALL_TEXT.pending;

    banner.className = 'banner' + (overall === 'operational' ? ' is-ok'
      : overall === 'degraded' ? ' is-slow'
      : overall === 'down' ? ' is-down' : '');

    $('#bannerTitle').textContent = title;
    $('#bannerDesc').textContent = desc;

    const allMs = data.sites.filter((s) => s.status !== 'pending' && s.ms != null).map((s) => s.ms);
    const avgMs = allMs.length ? Math.round(allMs.reduce((a, b) => a + b, 0) / allMs.length) : null;

    const metrics = [
      ['正常', data.counts.up],
      ['缓慢', data.counts.slow],
      ['故障', data.counts.down],
      ['平均响应', avgMs == null ? '—' : avgMs + ' ms'],
    ];

    $('#bannerMetrics').innerHTML = metrics
      .map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`)
      .join('');

    const mark = document.querySelector('.brand__mark');
    if (mark) {
      mark.className = 'brand__mark' + (overall === 'operational' ? ' is-ok'
        : overall === 'degraded' ? ' is-slow'
        : overall === 'down' ? ' is-down' : '');
    }
  }

  function renderBars(history) {
    const items = (history || []).slice(-BAR_COUNT);
    const padding = Math.max(0, BAR_COUNT - items.length);
    let html = '';

    for (let i = 0; i < padding; i++) html += '<span class="bar" title="尚无数据"></span>';

    for (const h of items) {
      const cls = BAR_CLASS[h.s] || '';
      const label = `${timeText(h.t)} · ${STATUS_TEXT[h.s === 1 ? 'operational' : h.s === 2 ? 'degraded' : 'down']}` +
        (h.ms != null ? ` · ${Math.round(h.ms)}ms` : '') +
        (h.c != null ? ` · HTTP ${h.c}` : '');
      html += `<span class="bar ${cls}" title="${esc(label)}"></span>`;
    }
    return `<div class="bars">${html}</div>`;
  }

  function renderRow(site) {
    const status = site.status || 'pending';
    const dot = DOT_CLASS[status] || 'dot--pending';
    const pill = PILL_CLASS[status] || 'pill--pending';
    const label = STATUS_TEXT[status] || '检测中';
    const detail = site.error || site.hint ? ` title="${esc(site.error || site.hint)}"` : '';
    // 只在非 2xx/3xx 时显示状态码，避免列表噪音
    const codeNote = site.code != null && site.code >= 400 ? `<small> · ${esc(site.code)}</small>` : '';

    return `
      <div class="row">
        <div class="site">
          <i class="dot ${dot}"${detail}></i>
          <div class="site__text">
            <a class="site__name" href="${esc(site.url)}" target="_blank" rel="noopener noreferrer">${esc(site.name)}</a>
            <span class="site__url">${esc(site.url)}</span>
          </div>
        </div>
        ${renderBars(site.history)}
        <div class="num num--muted num--uptime">${esc(pct(site.uptime))}</div>
        <div class="num num--resp">${esc(msText(site.ms))}${codeNote}</div>
        <span class="pill ${pill}"${detail}>${esc(label)}</span>
      </div>`;
  }

  function renderGroups(data) {
    const groupsEl = $('#groups');
    const empty = $('#empty');

    if (!data.sites.length) {
      groupsEl.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    // 按 group 分组，保持配置中的先后顺序
    const order = [];
    const map = new Map();
    for (const site of data.sites) {
      const g = site.group || '未分组';
      if (!map.has(g)) { map.set(g, []); order.push(g); }
      map.get(g).push(site);
    }

    groupsEl.innerHTML = order
      .map((g) => `
        <div class="group">
          <div class="group__title">${esc(g)}</div>
          <div class="group__list">${map.get(g).map(renderRow).join('')}</div>
        </div>`)
      .join('');
  }

  function render(data) {
    document.title = data.title || '站点状态';
    $('#siteTitle').textContent = data.title || '站点状态';
    $('#siteSubtitle').textContent = data.subtitle || '';
    $('#updated').textContent = '更新于 ' + timeText(data.updatedAt);

    renderBanner(data);
    renderGroups(data);

    const interval = Math.round((data.intervalMs || 60000) / 1000);
    $('#legendNote').textContent =
      `每 ${interval} 秒自动检测一次 · 响应超过 ${data.slowMs || 1500}ms 记为缓慢 · 5xx 与连接失败记为故障`;
    $('#footerInfo').textContent = `${data.title || '站点状态'} · 共 ${data.counts.total} 个站点`;
  }

  /* ---------- 数据获取 ---------- */
  let loading = false;

  async function load(force) {
    if (loading) return;
    loading = true;

    const btn = $('#refreshBtn');
    if (force && btn) {
      btn.disabled = true;
      btn.classList.add('is-busy');
    }

    try {
      const res = await fetch(force ? '/api/check' : '/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      render(await res.json());
      if (force) showToast('检测完成');
    } catch (err) {
      showToast('获取状态失败：' + err.message, true);
    } finally {
      loading = false;
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
      }
    }
  }

  $('#refreshBtn')?.addEventListener('click', () => load(true));

  load(false);
  setInterval(() => load(false), 15000);

  // 切回标签页时立即刷新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(false);
  });
})();
