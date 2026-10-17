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

  const OVERALL_TITLE = {
    operational: '全部系统正常',
    degraded: '部分站点响应缓慢',
    down: '有站点出现故障',
    pending: '正在检测…',
  };

  const BAR_CLASS = { 1: 'bar--ok', 2: 'bar--slow', 0: 'bar--down' };
  const DOT_CLASS = { operational: 'dot--ok', degraded: 'dot--slow', down: 'dot--down', pending: 'dot--pending' };
  const PILL_CLASS = { operational: 'pill--ok', degraded: 'pill--slow', down: 'pill--down', pending: 'pill--pending' };
  const BAR_COUNT = 40;

  const AUTH_ERRORS = {
    not_admin: '你不是管理员，已自动退出登录。',
    auth_not_configured: '管理登录尚未配置，请联系站长。',
    invalid_state: '登录请求已失效，请重新发起。',
    missing_code: '授权服务器没有返回授权码，请重试。',
    oauth_failed: '登录失败，请稍后重试；若持续失败请查看服务端日志。',
    access_denied: '你取消了授权。',
  };

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
    toastTimer = setTimeout(() => { toast.className = 'toast'; }, isErr ? 4200 : 2600);
  }

  /* ---------- 公告横幅 ---------- */
  function renderNotice(banner) {
    const el = $('#notice');
    const textEl = $('#noticeText');
    if (!el || !textEl) return;

    const on = banner && banner.enabled && banner.text;
    if (!on) { el.hidden = true; return; }

    el.hidden = false;
    el.className = 'notice notice--' + (banner.level || 'info');
    textEl.textContent = banner.text;
  }

  /* ---------- 渲染 ---------- */
  function renderBanner(data) {
    const banner = $('#banner');
    const overall = data.overall || 'pending';

    banner.className = 'banner' + (overall === 'operational' ? ' is-ok'
      : overall === 'degraded' ? ' is-slow'
      : overall === 'down' ? ' is-down' : '');

    $('#bannerTitle').textContent = OVERALL_TITLE[overall] || OVERALL_TITLE.pending;

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
    $('#updated').textContent = '更新于 ' + timeText(data.updatedAt);

    renderNotice(data.banner);
    renderBanner(data);
    renderGroups(data);
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

  /* ==========================================================================
     管理员：登录入口 + 编辑面板
     ========================================================================== */
  const ICON_LOGOUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 17l5-5-5-5"/><path d="M20 12H9"/><path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6"/></svg>';
  const ICON_LOGIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  let me = { admin: false, configured: false };
  let draft = { sites: [], banner: { enabled: false, text: '', level: 'info' } };

  async function initAdminArea() {
    const area = $('#adminArea');
    if (!area) return;

    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      me = await res.json();
    } catch {
      me = { admin: false, configured: false };
    }

    if (me.admin) {
      area.innerHTML =
        `<span class="admin-chip" title="${esc(me.email)}">${esc(me.name || me.email)}</span>` +
        '<button class="btn" type="button" id="editBtn">编辑</button>' +
        `<a class="icon-btn" href="/auth/logout" title="退出登录" aria-label="退出登录">${ICON_LOGOUT}</a>`;
      $('#editBtn')?.addEventListener('click', openEditor);
    } else if (me.configured) {
      area.innerHTML =
        `<a class="icon-btn" href="/auth/login" title="管理员登录" aria-label="管理员登录">${ICON_LOGIN}</a>`;
    } else {
      area.innerHTML = '';
    }
  }

  /* ---------- 编辑面板 ---------- */
  function renderSiteEditor() {
    const wrap = $('#siteEditor');
    if (!wrap) return;

    if (!draft.sites.length) {
      wrap.innerHTML = '<p class="field-hint">还没有站点，点下面的「添加站点」。</p>';
      return;
    }

    wrap.innerHTML = draft.sites
      .map((site, i) => `
        <div class="site-row" data-i="${i}">
          <input class="input" data-k="name" value="${esc(site.name)}" placeholder="名称" maxlength="60" aria-label="名称" />
          <input class="input" data-k="url" value="${esc(site.url)}" placeholder="https://example.com" maxlength="500" aria-label="地址" spellcheck="false" />
          <input class="input" data-k="group" value="${esc(site.group)}" placeholder="分组" maxlength="40" aria-label="分组" />
          <button class="icon-btn site-row__del" type="button" data-del="${i}" aria-label="删除站点">${ICON_CLOSE}</button>
        </div>`)
      .join('');
  }

  async function openEditor() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      draft = {
        sites: (data.sites || []).map((s) => ({
          id: s.id,
          name: s.name || '',
          url: s.url || '',
          group: s.group && s.group !== '未分组' ? s.group : '',
        })),
        banner: {
          enabled: Boolean(data.banner && data.banner.enabled),
          text: (data.banner && data.banner.text) || '',
          level: (data.banner && data.banner.level) || 'info',
        },
      };
    } catch (err) {
      showToast('读取配置失败：' + err.message, true);
      return;
    }

    renderSiteEditor();
    $('#bannerEnabled').checked = draft.banner.enabled;
    $('#bannerText').value = draft.banner.text;
    $('#bannerLevel').value = draft.banner.level;

    const modal = $('#editor');
    modal.hidden = false;
    document.body.classList.add('no-scroll');
    $('#bannerText').focus();
  }

  function closeEditor() {
    const modal = $('#editor');
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.body.classList.remove('no-scroll');
  }

  async function saveEditor() {
    const btn = $('#saveBtn');
    if (btn) btn.disabled = true;

    try {
      // 名称和地址都空的行视为「误点添加」，直接丢掉
      const sites = draft.sites
        .map((s) => ({
          id: s.id,
          name: (s.name || '').trim(),
          url: (s.url || '').trim(),
          group: (s.group || '').trim(),
        }))
        .filter((s) => s.name || s.url);

      const payload = {
        sites,
        banner: {
          enabled: $('#bannerEnabled').checked,
          text: $('#bannerText').value.trim(),
          level: $('#bannerLevel').value,
        },
      };

      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        showToast(data.error || '保存失败', true);
        return;
      }

      closeEditor();
      showToast('已保存');
      await load(false);
    } catch (err) {
      showToast('保存失败：' + err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // 弹窗交互
  $('#editor')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeEditor();
  });

  // 站点行的编辑与删除（事件委托，行是动态渲染的）
  $('#siteEditor')?.addEventListener('input', (e) => {
    const row = e.target.closest('.site-row');
    if (!row) return;
    const index = Number(row.dataset.i);
    const key = e.target.dataset.k;
    if (!key || !draft.sites[index]) return;
    draft.sites[index][key] = e.target.value;
  });

  $('#siteEditor')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    draft.sites.splice(Number(btn.dataset.del), 1);
    renderSiteEditor();
  });

  $('#addSiteBtn')?.addEventListener('click', () => {
    draft.sites.push({ name: '', url: '', group: '' });
    renderSiteEditor();
    const rows = document.querySelectorAll('.site-row');
    const last = rows[rows.length - 1];
    last?.querySelector('input[data-k="name"]')?.focus();
  });

  $('#saveBtn')?.addEventListener('click', saveEditor);

  /* ---------- 登录结果提示 ---------- */
  (function handleAuthResult() {
    const params = new URLSearchParams(window.location.search);
    const err = params.get('error');
    if (!err) return;

    showToast(AUTH_ERRORS[err] || ('登录未完成：' + err), true);

    params.delete('error');
    const qs = params.toString();
    history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : ''));
  })();

  /* ---------- 启动 ---------- */
  initAdminArea();
  load(false);
  setInterval(() => load(false), 15000);

  // 切回标签页时立即刷新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load(false);
  });
})();
