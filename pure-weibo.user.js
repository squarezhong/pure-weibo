// ==UserScript==
// @name         Pure Weibo
// @namespace    pure-weibo
// @version      0.1.0
// @description  首页进入最新关注微博，清理推荐、热搜和显式广告，保留主动搜索、转发与播放。
// @author       squarezhong
// @match        https://weibo.com/*
// @match        https://www.weibo.com/*
// @match        https://s.weibo.com/*
// @match        https://video.weibo.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
  'use strict';
  const HOSTS = ['weibo.com', 'www.weibo.com', 's.weibo.com', 'video.weibo.com'];
  if (window.top !== window.self || !HOSTS.includes(location.hostname)) return;
  const KEY = 'pure-weibo-settings-v1';
  const UI = 'pure-weibo-settings';
  const HIDDEN = 'pure-weibo-hidden';
  const NAV = '[role="navigation"],nav';
  const PROSE = '.wbpro-feed-content,.detail_wbtext,.card-feed .txt,.WB_text,blockquote,[contenteditable],textarea,[class*="Comment"],[class*="comment"],.wbpro-list';
  const OPTIONS = [
    ['latest', '首页进入最新微博', true], ['strict', '严格过滤关注流', true],
    ['ads', '清理显式广告', true], ['modules', '清理热搜及推荐模块', true],
    ['showHot', '显示推荐导航入口', false], ['showVideo', '显示视频导航入口', false],
    ['showGames', '显示游戏导航入口', false]
  ];
  const defaults = Object.fromEntries(OPTIONS.map(([key, , value]) => [key, value]));
  const query = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = el => (el?.textContent || '').replace(/[\uE000-\uF8FF]/g, '').trim();
  const label = el => el.getAttribute('aria-label') || el.getAttribute('title') || text(el);
  const owned = el => !!el?.closest?.(`#${UI},#pure-weibo-style`);
  const normalize = value => ({ version: 1, ...Object.fromEntries(OPTIONS.map(([key, , fallback]) =>
    [key, typeof value?.[key] === 'boolean' ? value[key] : fallback])) });
  let settings;
  try { settings = normalize(typeof GM_getValue === 'function' ? GM_getValue(KEY, null) : null); }
  catch (_) { settings = normalize(null); }
  let hidden = new Set();
  const rewritten = new Map();
  const placeholders = new Map();
  const autoAttempts = new WeakMap();
  let frame = 0, observer, timer, stopped = false, lastURL = '', redirected = '';
  let ui, dialog, status, lastFocus, saving = false;

  function route() {
    if (location.hostname === 's.weibo.com') return 'search';
    if (location.hostname === 'video.weibo.com' || /^\/tv\/show\//.test(location.pathname)) return 'video';
    if (location.pathname === '/') return 'home';
    if (/^\/mygroups\/?$/.test(location.pathname)) return 'following';
    return 'other';
  }
  function urlOf(a) {
    try { return new URL(a.getAttribute('href'), location.href); } catch (_) { return null; }
  }
  function latestURL() {
    // Resolve fresh on every pass: no persisted account IDs or fabricated gid values.
    for (const a of query('a[href]')) {
      if (a.closest(`article,.card-wrap,${PROSE}`)) continue;
      const title = a.querySelector('[title="最新微博"]');
      if (!title && label(a) !== '最新微博') continue;
      const u = urlOf(a);
      if (u?.protocol === 'https:' && ['weibo.com', 'www.weibo.com'].includes(u.hostname) &&
          u.pathname === '/mygroups' && /^\d+$/.test(u.searchParams.get('gid') || '')) return u.href;
    }
    return null;
  }
  function rewrite(a, href) {
    const old = rewritten.get(a);
    if (!old || a.getAttribute('href') !== old.applied) rewritten.set(a, { original: a.getAttribute('href'), applied: href });
    else old.applied = href;
    if (a.getAttribute('href') !== href) a.setAttribute('href', href);
  }
  function restoreLinks() {
    for (const [a, { original, applied }] of rewritten) {
      if (a.getAttribute('href') === applied) a.setAttribute('href', original);
    }
    rewritten.clear();
  }
  function cleanNavigation(desired, latest) {
    for (const nav of query(NAV)) for (const a of query('a[href]', nav)) {
      const u = urlOf(a);
      if (!u) continue;
      const main = ['weibo.com', 'www.weibo.com', 's.weibo.com'].includes(u.hostname);
      const name = a.getAttribute('aria-label') || a.getAttribute('title') ||
        a.querySelector('[aria-label]')?.getAttribute('aria-label') || text(a);
      if (main && u.pathname === '/hot' && !settings.showHot ||
          main && u.pathname === '/tv' && !settings.showVideo ||
          u.hostname === 'game.weibo.com' && !settings.showGames) desired.add(a);
      if (settings.latest && main && u.pathname === '/' && /^(Weibo|微博|首页)$/i.test(name)) {
        // Search/legacy video pages have no account-specific sidebar. Enter the
        // main site first; its fresh latest link resolves the current account.
        const target = latest || (['s.weibo.com', 'video.weibo.com'].includes(location.hostname) ? 'https://weibo.com/' : null);
        if (target) rewrite(a, target);
      }
    }
    // Also cover the original "全部关注" entry, without changing user-defined groups.
    if (settings.latest && latest) for (const a of query('a[href]')) {
      if (!a.closest(`article,.card-wrap,${PROSE}`) && (a.querySelector('[title="全部关注"]') || label(a) === '全部关注')) {
        const u = urlOf(a);
        if (u && ['weibo.com', 'www.weibo.com'].includes(u.hostname) && u.pathname === '/') rewrite(a, latest);
      }
    }
  }
  function outerHeader(card) { return card.querySelector(':scope > header,:scope > div > header'); }
  function sourceRows(card) {
    // Only the source strip before the author's outer header. Never walk post prose.
    const header = outerHeader(card);
    if (!header) return [];
    const body = header.parentElement === card ? header : header.parentElement;
    const rows = [];
    for (const node of card.children) { if (node === body) break; rows.push(node); }
    if (body !== header) for (const node of body.children) { if (node === header) break; rows.push(node); }
    return rows;
  }
  function stripText(row) {
    const clone = row.cloneNode(true);
    query('a,button,[role="button"],.woo-pop-wrap', clone).forEach(e => e.remove());
    return text(clone).replace(/\s+/g, '');
  }
  function isAdHeader(header) {
    if (!header) return false;
    // Current native ad badge is an image without an accessible text label.
    return query('.wbpro-tag-img img', header).some(e => {
      try {
        const u = new URL(e.getAttribute('src'), location.href);
        return u.hostname === 'd.sinaimg.cn' && /\/icon_auth_(white|dark)\.png$/.test(u.pathname);
      } catch (_) { return false; }
    }) || query('.ad-tag,.ad-label,[data-ad-label]', header).some(e => /^(广告|推广|赞助)$/.test(label(e)));
  }
  function cleanCards(desired, page) {
    for (const card of query('main article,.wbpro-scroller-item > article')) {
      if (card.parentElement.closest('article')) continue;
      const header = outerHeader(card);
      const rows = sourceRows(card);
      const source = rows.map(stripText);
      const ad = settings.ads && (isAdHeader(header) || source.some(s => /^(广告|推广|赞助)$/.test(s)));
      const strict = settings.strict && ['home', 'following'].includes(page) && (
        source.some(s => /^(赞过|赞了|点赞了|推荐|推荐微博|为你推荐|你可能感兴趣|热门推荐)$/.test(s)) ||
        (header && query('button', header).some(b => /^(关注|\+\s*关注)$/.test(text(b))))
      );
      if (ad || strict) {
        const wrapper = card.parentElement;
        // A recycled item may hold several cards: never hide its unrelated children.
        desired.add(wrapper.matches('.wbpro-scroller-item') && wrapper.children.length === 1 ? wrapper : card);
      }
    }
    if (settings.ads) {
      for (const card of query('#pl_feedlist_index .card-wrap[action-type="feed_list_item"]')) {
        if (query(':scope > .card-top .ad-tag,:scope > .card-top .ad-label', card).some(e => /^(广告|推广|赞助)$/.test(text(e)))) desired.add(card);
      }
      // Explicit module attributes; never classify a card by words in its body.
      for (const el of query('[data-ad="true"],[data-ad-type="feed"],.WB_cardwrap_ad')) {
        if (!el.closest(PROSE)) desired.add(el);
      }
    }
  }
  function cleanModules(desired, page) {
    if (!settings.modules) return;
    for (const title of query('.wbpro-side-tit')) {
      if (title.closest('article,.card-wrap,[contenteditable]')) continue;
      const heading = text(title.firstElementChild || title);
      if (/^(微博热搜|你可能感兴趣的人|推荐关注|关注推荐|热门话题|为你推荐)$/.test(heading)) {
        const panel = title.closest('.wbpro-side');
        if (panel) desired.add(panel);
      }
    }
    for (const el of query('.hotBand,#hot-band-container')) if (!el.closest('article,.card-feed,[contenteditable]')) desired.add(el);
    // Search histories and query suggestions are not hot-search groups.
    for (const nav of query(NAV)) {
      for (const el of query('[class*="hotlist"],[class*="HotSearch"],[class*="hotSearch"],[class*="HotList"]', nav)) {
        if (!el.querySelector('input') && !el.closest('article')) desired.add(el);
      }
    }
    if (page === 'video') for (const related of query('[class*="Relatevideolist_inner_"]')) {
      for (const input of query('input.woo-switch-input[type="checkbox"]', related)) {
        // The switch is inside the confirmed "接下来播放" recommendations module.
        if (input.checked && (autoAttempts.get(input) || 0) < 2) {
          autoAttempts.set(input, (autoAttempts.get(input) || 0) + 1);
          input.click();
        }
      }
      const parent = related.parentElement;
      desired.add(parent.matches('[class*="Frame_side2_"]') && parent.children.length === 1 ? parent : related);
    }
  }
  function cleanSearch() {
    const active = new Set();
    if (settings.modules) for (const nav of query(NAV)) for (const input of query('input[type="text"],input[type="search"]', nav)) {
      active.add(input);
      const current = input.getAttribute('placeholder');
      const previous = placeholders.get(input);
      if (!previous || current !== previous.applied) placeholders.set(input, { original: current, applied: '搜索微博' });
      if (current !== '搜索微博') input.setAttribute('placeholder', '搜索微博');
    }
    for (const [input, record] of placeholders) if (!active.has(input)) {
      if (input.getAttribute('placeholder') === record.applied) {
        if (record.original === null) input.removeAttribute('placeholder'); else input.setAttribute('placeholder', record.original);
      }
      placeholders.delete(input);
    }
  }
  function injectStyle() {
    if (document.getElementById('pure-weibo-style')) return;
    const style = document.createElement('style'); style.id = 'pure-weibo-style';
    style.textContent = `.${HIDDEN}{display:none!important}
      #${UI}{color-scheme:light dark}
      [class*="Frame_content2_"]:has(> [class*="Frame_side2_"].${HIDDEN}) > [class*="Frame_main2_"]{margin-inline:auto!important;min-width:0!important;max-width:100%!important}
      @media(max-width:760px){[role="navigation"] input.woo-input-main{min-width:0!important}}
    `;
    document.documentElement.append(style);
  }
  function apply() {
    frame = 0;
    if (stopped || !document.documentElement) return;
    observer?.disconnect();
    try {
      injectStyle();
      const page = route();
      const current = location.href;
      if (current !== lastURL) { lastURL = current; redirected = ''; restoreLinks(); }
      // Restore before discovery to avoid using our own rewritten links as evidence.
      restoreLinks();
      const latest = settings.latest ? latestURL() : null;
      const desired = new Set();
      cleanNavigation(desired, latest); cleanCards(desired, page); cleanModules(desired, page); cleanSearch();
      for (const el of hidden) if (!desired.has(el)) el.classList.remove(HIDDEN);
      for (const el of desired) el.classList.add(HIDDEN);
      hidden = desired;
      if (page === 'home' && latest && redirected !== current) {
        redirected = current;
        location.replace(latest);
      }
    } finally { observe(); }
  }
  function schedule() { if (!frame && !stopped) frame = requestAnimationFrame(apply); }
  function observe() {
    if (!stopped && document.documentElement) observer?.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'href', 'placeholder', 'title', 'aria-label', 'src', 'checked', 'data-ad', 'data-ad-type']
    });
  }
  function ensureUI() {
    if (ui) { if (!ui.isConnected) document.body.append(ui); return; }
    ui = document.createElement('span'); ui.id = UI;
    const shadow = ui.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{font:14px/1.6 system-ui,sans-serif}*{box-sizing:border-box}
      dialog{color:var(--weibo-main-text-color,#24354b);background:var(--weibo-card-background,#fff);width:min(520px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid #8886;border-radius:16px;padding:24px;font:14px/1.6 system-ui,sans-serif;box-shadow:0 20px 80px #0004}
      dialog::backdrop{background:#18202c88}h2{margin:0 0 8px;font-size:22px}p{margin:8px 0 16px}.grid{display:grid;gap:8px}
      label{display:flex;align-items:center;gap:10px;padding:7px;border-radius:6px;background:#8881}input{accent-color:#e67e22;width:16px;height:16px}
      button{font:inherit;color:inherit;background:transparent;border:1px solid #8887;border-radius:8px;padding:7px 13px;cursor:pointer}
      button:focus-visible,input:focus-visible{outline:3px solid #e99a43;outline-offset:2px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.save{margin-left:auto;background:#bd5b0b;color:#fff}.note{font-size:12px;opacity:.8}.status{min-height:22px}.error{color:#d25536}
      @media(prefers-color-scheme:dark){dialog{color:var(--weibo-main-text-color,#eee);background:var(--weibo-card-background,#242424)}}
    </style><dialog aria-labelledby="pw-title"><h2 id="pw-title">Pure Weibo</h2><p>让关注成为首页，让浏览由你决定。</p>
      <form><div class="grid"></div><p class="note">严格模式保留关注者转发；无法确认来源的卡片仍会显示。搜索、详情和个人主页不限制作者。关闭清理不会自动重新开启视频连播。</p>
      <div class="actions"><button type="button" class="reset">恢复默认</button><button type="button" class="cancel">取消</button><button type="submit" class="save">保存</button></div>
      <p class="status" role="status" aria-live="polite"></p></form></dialog>`;
    dialog = shadow.querySelector('dialog'); status = shadow.querySelector('.status');
    for (const [key, title] of OPTIONS) {
      const row = document.createElement('label'), input = document.createElement('input');
      input.type = 'checkbox'; input.name = key; row.append(input, document.createTextNode(title)); shadow.querySelector('.grid').append(row);
    }
    shadow.querySelector('.cancel').addEventListener('click', () => dialog.close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
    shadow.querySelector('.reset').addEventListener('click', () => { fill(defaults); setStatus('已填入默认选项，保存后生效。'); });
    shadow.querySelector('form').addEventListener('submit', save);
    let outsideDown = false;
    const outside = e => { const r = dialog.getBoundingClientRect(); return e.target === dialog && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom); };
    dialog.addEventListener('pointerdown', e => { outsideDown = outside(e); });
    dialog.addEventListener('click', e => { if (outsideDown && outside(e)) dialog.close(); outsideDown = false; });
    dialog.addEventListener('close', () => lastFocus?.focus?.());
    document.body.append(ui);
  }
  function fill(value) { query('input', ui.shadowRoot).forEach(e => { e.checked = value[e.name]; }); }
  function setStatus(message, error = false) { status.textContent = message; status.classList.toggle('error', error); }
  function openSettings() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', openSettings, { once: true }); return; }
    ensureUI();
    if (dialog.open) return;
    lastFocus = document.activeElement; fill(settings); setStatus(''); dialog.showModal();
  }
  async function save(event) {
    event.preventDefault(); if (saving) return;
    const next = normalize(Object.fromEntries(query('input', ui.shadowRoot).map(e => [e.name, e.checked])));
    saving = true;
    query('button,input', ui.shadowRoot).forEach(e => { e.disabled = true; });
    try {
      if (typeof GM_setValue !== 'function') throw new Error('Storage unavailable');
      await GM_setValue(KEY, next);
      settings = next; schedule(); setStatus('已保存；支持的油猴管理器会同步到其他微博标签页。');
    } catch (_) { setStatus('保存失败，当前规则未改变。请检查油猴存储后重试。', true); }
    finally { saving = false; query('button,input', ui.shadowRoot).forEach(e => { e.disabled = false; }); }
  }
  function start() {
    stopped = false;
    if (!document.documentElement) { document.addEventListener('DOMContentLoaded', start, { once: true }); return; }
    observer ||= new MutationObserver(records => {
      if (records.some(r => {
        const el = r.target.nodeType === 1 ? r.target : r.target.parentElement;
        return el && !owned(el) && !el.closest('video,canvas,[contenteditable],textarea,.wbpv-control-bar');
      })) schedule();
    });
    observe(); schedule();
    clearInterval(timer);
    // Sandbox-safe SPA detection; do not patch page-owned history methods.
    timer = setInterval(() => { if (lastURL !== location.href) schedule(); }, 500);
  }
  try {
    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Pure Weibo：设置', openSettings);
      GM_registerMenuCommand('Pure Weibo：重新应用规则', schedule);
    }
    if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener(KEY, (_key, _old, value, remote) => {
      if (!remote) return;
      settings = normalize(value); schedule();
      if (dialog?.open) setStatus('其他页面已更新设置。当前草稿保留；重开可载入，保存会覆盖为当前选项。');
    });
  } catch (error) { console.warn('[Pure Weibo] 菜单或同步不可用', error); }
  // Vue router click handlers may ignore a modified href; capture only rewritten home links.
  document.addEventListener('click', event => {
    const a = event.target.closest?.('a');
    const record = rewritten.get(a);
    if (!record || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); event.stopImmediatePropagation(); location.assign(record.applied);
  }, true);
  window.addEventListener('popstate', schedule); window.addEventListener('hashchange', schedule);
  window.addEventListener('pagehide', () => { stopped = true; observer?.disconnect(); clearInterval(timer); cancelAnimationFrame(frame); frame = 0; });
  window.addEventListener('pageshow', () => { if (stopped) start(); else schedule(); });
  start();
})();
