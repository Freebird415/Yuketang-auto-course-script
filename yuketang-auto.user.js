// ==UserScript==
// @name         雨课堂连播助手
// @namespace    https://greasyfork.org/users/1616996-acac1a
// @version      2.1.0
// @description  雨课堂自动静音二倍速刷课：进入视频页点「开始刷课」后自动播放、静音、2 倍速、自动连播，播完自动跳下一个未完成视频。适配 2026 新版「学习空间」（/ai-workspace/lms-graph），兼容旧版 /pro/lms 与长江雨课堂。内嵌 always-on-focus 可后台挂机，支持一键 BUG 上报。
// @author       Acac1a
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @grant        GM_xmlhttpRequest
// @connect      open.feishu.cn
// @license      MIT
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const SCRIPT_VERSION = '2.1.0';
  const IS_YUKETANG = /(^|\.)yuketang\.cn$/.test(location.hostname);

  // ===================================================================
  //  模块 0：always-on-focus（始终激活，不受开始/停止影响）
  //  后台挂机时播放器/心跳依赖页面可见，这里强制页面永远"可见+有焦点"
  // ===================================================================
  (function alwaysOnFocus() {
    if (!IS_YUKETANG) return;
    try {
      ['hidden', 'mozHidden', 'msHidden', 'webkitHidden'].forEach(p => {
        try { Object.defineProperty(document, p, { value: false }); } catch (_) {}
      });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
      Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible' });
      document.hasFocus = () => true;
      window.onblur = null;

      const block = (e) => {
        if (e.type === 'blur') {
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLAnchorElement ||
              e.target instanceof HTMLSpanElement || e.target instanceof HTMLParagraphElement) return;
          if (e.target.classList?.contains('ql-editor')) return;
        }
        if (['mouseleave', 'mouseout'].includes(e.type)) {
          if (!(e.target instanceof HTMLHtmlElement || e.target instanceof HTMLBodyElement ||
                e.target instanceof HTMLIFrameElement || e.target instanceof HTMLHeadElement)) return;
        }
        e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
      };
      ['visibilitychange', 'webkitvisibilitychange', 'blur', 'mouseleave', 'mouseout',
       'mozvisibilitychange', 'msvisibilitychange'].forEach(evt => {
        window.addEventListener(evt, block, true);
        document.addEventListener(evt, block, true);
      });
    } catch (e) {}
  })();

  // ===================================================================
  //  模块 0.5：倍速策略
  //
  //  雨课堂播放器 UI 最高只给 2x，服务端也不校验倍速（心跳里的 sp 恒为 1，
  //  rate 字段只记录完成比例）。真正的上限来自分片取流——实测：
  //      2x  有效速度 1.99x，0 卡顿
  //      3x  有效速度 3.00x，0 卡顿   ← 稳定
  //      4x  有效速度 1.63x，22 卡顿
  //      5x  有效速度 0.01x，37 卡顿  ← 崩掉
  //  所以默认 3x，并在实测跟不上时自动降档（而不是死守一个固定值）。
  // ===================================================================
  const RATE_LADDER = [3, 2.5, 2];

  /**
   * 是否应该降档（纯函数，便于单测）。
   * 依据：一个评估窗口内卡顿过多，或实测有效速度明显低于目标。
   */
  function shouldDropRate({ measuredSpeed, target, stalls, strikes, maxStrikes = 2 }) {
    if (stalls >= 3) return true;
    if (!(measuredSpeed > 0)) return false;
    return measuredSpeed < target * 0.75 && strikes >= maxStrikes;
  }

  // ===================================================================
  //  模块 1：条件性原型链拦截（仅在引擎激活时生效）
  //  任何后来创建的 <video> 都会被自动施加目标倍速 / 静音 / 防暂停
  // ===================================================================
  (function conditionalHack() {
    if (!IS_YUKETANG) return;
    try {
      window._yktEngineActive = false;
      window._yktRate = RATE_LADDER[0];
      window._yktVolume = 0;

      const rateDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
      if (rateDesc?.set) {
        const orig = rateDesc.set;
        rateDesc.set = function (val) {
          return window._yktEngineActive ? orig.call(this, window._yktRate) : orig.call(this, val);
        };
        Object.defineProperty(HTMLMediaElement.prototype, 'playbackRate', rateDesc);
      }

      const volDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'volume');
      if (volDesc?.set) {
        const orig = volDesc.set;
        volDesc.set = function (val) {
          return window._yktEngineActive ? orig.call(this, window._yktVolume) : orig.call(this, val);
        };
        Object.defineProperty(HTMLMediaElement.prototype, 'volume', volDesc);
      }

      const origPause = HTMLVideoElement.prototype.pause;
      HTMLVideoElement.prototype.pause = function () {
        if (!window._yktEngineActive) return origPause.call(this);
        if (this._scriptAllowPause) return origPause.call(this);
        if (this.ended) return origPause.call(this);
        if (document.hidden) return;
        this.play().catch(() => {});
      };
    } catch (e) { console.error('[雨课堂] 原型链失败:', e); }
  })();

  // ===================================================================
  //  工具函数
  // ===================================================================
  const DEBUG = true;
  const ts = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
  };
  function log(s, r, d) {
    if (!DEBUG) return;
    const i = { OK: '✅', FAIL: '❌', WAIT: '⏳', INFO: '📋' }[r] || '📋';
    if (d !== undefined) console.log(`[雨课堂] [${ts()}] ${i} ${s}`, d);
    else console.log(`[雨课堂] [${ts()}] ${i} ${s}`);
  }

  let panelLogLines = [];
  function panelLog(msg) {
    panelLogLines.push(`[${ts()}] ${msg}`);
    if (panelLogLines.length > 100) panelLogLines.shift();
    updatePanelLog();
  }

  function updateSharedStatus(updates) {
    try {
      const raw = localStorage.getItem('_ykt_status');
      const cur = raw ? JSON.parse(raw) : {};
      Object.assign(cur, updates, { _ts: Date.now() });
      localStorage.setItem('_ykt_status', JSON.stringify(cur));
    } catch (_) {}
  }

  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (_) {} }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (_) {} }

  // ===================================================================
  //  页面上下文解析
  //  新版：/ai-workspace/lms-graph/{classroomId}/{kind}/{leafId}
  //  旧版：/pro/lms/{sign}/{classroomId}/video/{leafId}
  //  长江：/v2/web/xcloud/video-student/{classroomId}/{leafId}
  // ===================================================================
  const KIND_MAP = {
    video: 'video', forum: 'forum', discussion: 'forum', quiz: 'quiz',
    homework: 'quiz', exam: 'quiz', live: 'live', document: 'doc', doc: 'doc',
  };

  function parsePageContext(pathname) {
    const p = pathname || location.pathname;
    let m = p.match(/^\/ai-workspace\/lms-graph\/(\d+)\/([A-Za-z-]+)\/(\d+)/);
    if (m) {
      return {
        version: 'new', classroomId: m[1], rawKind: m[2],
        kind: KIND_MAP[m[2]] || 'other', leafId: m[3],
      };
    }
    m = p.match(/^\/ai-workspace\/lms-graph\/(\d+)/);
    if (m) return { version: 'new', classroomId: m[1], rawKind: 'course', kind: 'course', leafId: null };

    m = p.match(/^\/pro\/lms\/([^/]+)\/(\d+)\/video\/(\d+)/);
    if (m) return { version: 'legacy', sign: m[1], classroomId: m[2], rawKind: 'video', kind: 'video', leafId: m[3] };
    m = p.match(/^\/pro\/lms\/([^/]+)\/(\d+)\/([A-Za-z_-]+)/);
    if (m) return { version: 'legacy', sign: m[1], classroomId: m[2], rawKind: m[3], kind: 'course', leafId: null };

    m = p.match(/^\/v2\/web\/xcloud\/video-student\/(\d+)\/(\d+)/);
    if (m) return { version: 'cj', classroomId: m[1], rawKind: 'video', kind: 'video', leafId: m[2] };

    return null;
  }

  function parsePageType(pathname) {
    const ctx = parsePageContext(pathname);
    if (!ctx) return 'unknown';
    if (ctx.kind === 'video') return 'video';
    if (ctx.kind === 'course') return 'course';
    return ctx.kind;
  }

  /** 构造某个 leaf 的视频页 URL */
  function buildVideoUrl(ctx, leafId) {
    if (!ctx) return null;
    if (ctx.version === 'new') {
      return `https://${location.hostname}/ai-workspace/lms-graph/${ctx.classroomId}/video/${leafId}` +
             `?node_id=0&fromProIframe=1&isyth=1&is_chapter=1`;
    }
    if (ctx.version === 'cj') {
      return `https://${location.hostname}/v2/web/xcloud/video-student/${ctx.classroomId}/${leafId}`;
    }
    return `https://${location.hostname}/pro/lms/${ctx.sign}/${ctx.classroomId}/video/${leafId}`;
  }

  const IS_VIDEO_PAGE = IS_YUKETANG && parsePageType(location.pathname) === 'video';

  log('脚本加载', 'INFO', `v${SCRIPT_VERSION} | ${location.pathname}`);

  // ===================================================================
  //  诊断：媒体事件史 / 错误史
  // ===================================================================
  const MEDIA_WATCH_EVENTS = ['play', 'pause', 'ended', 'seeked', 'stalled', 'waiting', 'canplay', 'loadeddata', 'emptied'];
  const mediaEventLog = [];
  const videoErrorLog = [];
  window._yktErrorLog = [];
  let lastMediaEventTs = 0;

  function captureMediaEvent(e) {
    const t = e.target;
    if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
    const now = Date.now();
    if ((e.type === 'stalled' || e.type === 'waiting')
      && mediaEventLog.length && mediaEventLog[mediaEventLog.length - 1].type === e.type
      && now - lastMediaEventTs < 5000) return;
    lastMediaEventTs = now;
    mediaEventLog.push({ t: ts(), type: e.type, ct: Math.round(t.currentTime || 0), rs: t.readyState ?? -1 });
    if (mediaEventLog.length > 20) mediaEventLog.shift();
  }
  if (document.addEventListener) {
    MEDIA_WATCH_EVENTS.forEach(evt => document.addEventListener(evt, captureMediaEvent, true));
    document.addEventListener('error', (e) => {
      const t = e.target;
      if (!t || (t.tagName !== 'VIDEO' && t.tagName !== 'AUDIO')) return;
      videoErrorLog.push({ t: ts(), code: t.error?.code ?? null, ct: Math.round(t.currentTime || 0) });
      if (videoErrorLog.length > 3) videoErrorLog.shift();
    }, true);
  }

  // ===================================================================
  //  课程接口层（新版 教学空间）
  //  GET /c27/online_courseware/course/classroom/{cid}/0/sku_list/
  //  GET /c27/online_courseware/course/classroom/{cid}/{sku}/todo_list/
  //  必需的头部：xtbz / university-id / platform-id / x-client / terminal-type / x-csrftoken
  //  这些值全部可以从 document.cookie 读到，无需额外登录态
  // ===================================================================
  function apiHeaders() {
    return buildApiHeaders(document.cookie);
  }

  /** 从 cookie 字符串构造接口所需头部（纯函数，便于单测） */
  function buildApiHeaders(cookieStr) {
    const val = (name) => {
      const m = String(cookieStr || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    };
    return {
      'xtbz': val('xtbz') || 'cloud',
      'university-id': val('university_id'),
      'platform-id': val('platform_id'),
      'x-client': 'web',
      'terminal-type': 'web',
      'x-csrftoken': val('csrftoken'),
      'accept': 'application/json, text/plain, */*',
    };
  }

  async function apiGet(path) {
    const r = await fetch(path, { headers: apiHeaders(), credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.success === false) throw new Error(j.msg || 'API error ' + j.error_code);
    return j;
  }

  async function apiGetSkuId(classroomId) {
    const cacheKey = '_ykt_sku_' + classroomId;
    const cached = lsGet(cacheKey);
    if (cached) return cached;
    const j = await apiGet(`/c27/online_courseware/course/classroom/${classroomId}/0/sku_list/?term=latest`);
    const sku = j?.data?.data_list?.[0]?.sku_id;
    if (sku) lsSet(cacheKey, String(sku));
    return sku ? String(sku) : null;
  }

  /** 取「未完成清单」。返回 [{leafId, type, name, url}]，顺序即课程顺序 */
  async function apiGetTodoList(classroomId) {
    const sku = await apiGetSkuId(classroomId);
    if (!sku) throw new Error('未取到 sku_id');
    const j = await apiGet(`/c27/online_courseware/course/classroom/${classroomId}/${sku}/todo_list/?client_type=web&term=latest`);
    const result = j?.data?.result || [];
    return result.map(it => ({
      leafId: String(it.leaf_id),
      type: it.type,               // 0=视频 4=讨论 5=作业/考试
      name: it.name,
      url: it.link_url,
    }));
  }

  /**
   * 从「未完成清单」中挑出下一个要刷的视频（纯函数）。
   * type: 0=视频，4=讨论，5=作业/考试 —— 只挑 type===0，因此讨论/作业会被自动跳过。
   * @param {Array<{leafId:string,type:number}>} list
   * @param {string|number|null} currentLeafId 当前所在 leaf
   */
  function pickNextVideo(list, currentLeafId) {
    const arr = Array.isArray(list) ? list : [];
    const videos = arr.filter(i => i.type === 0);
    const cur = currentLeafId === null || currentLeafId === undefined ? null : String(currentLeafId);
    const currentStillTodo = !!cur && videos.some(v => v.leafId === cur);
    const next = videos.find(v => v.leafId !== cur) || null;
    return { next, currentStillTodo, total: { all: arr.length, video: videos.length } };
  }

  /**
   * 决定「下一个该刷的视频」。
   * @returns {{next: Object|null, currentStillTodo: boolean, total: {all:number, video:number}}}
   */
  async function planNextTask(ctx) {
    const list = await apiGetTodoList(ctx.classroomId);
    return pickNextVideo(list, ctx.leafId);
  }

  // ===================================================================
  //  页面状态读取（新版 / 旧版兼容）
  // ===================================================================
  const SEL_RATE_TEXT = '.rate-detail .el-tooltip.text';
  const SEL_ACTIVE_LEAF = '.leaf-item.is-active';
  const SEL_NEXT_NEW = '.control-right i.unit-arrow.arrow-reverse';
  const SEL_PREV_NEW = '.control-right i.unit-arrow:not(.arrow-reverse)';
  const SEL_LEAF_DONE_ICON = '.leaf-item-status i[class*="yuanquangou"]';

  function qText(sel, root) {
    const el = (root || document).querySelector(sel);
    return el ? (el.textContent || '').trim() : '';
  }

  /** 当前视频完成状态：{completed, text, percent} */
  function getVideoStatus() {
    // —— 新版：顶部「完成度：3%」/「已完成」 ——
    const t = qText(SEL_RATE_TEXT);
    if (t) {
      if (/已(完成|学完)|已完成学习/.test(t)) return { completed: true, text: t };
      const m = t.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (m) return { completed: false, text: t, percent: parseFloat(m[1]) };
      return { completed: false, text: t, percent: undefined };
    }
    // —— 新版兜底：目录里当前 leaf 的完成图标 / 进度饼 ——
    const active = document.querySelector(SEL_ACTIVE_LEAF);
    if (active) {
      if (active.querySelector(SEL_LEAF_DONE_ICON)) return { completed: true, text: '(leaf-icon)' };
      const pie = active.querySelector('.status-pie');
      if (pie) {
        const p = (pie.getAttribute('style') || '').match(/--p:\s*([\d.]+)/);
        if (p) return { completed: parseFloat(p[1]) >= 100, text: `(leaf-pie:${p[1]})`, percent: parseFloat(p[1]) };
      }
      return { completed: false, text: '(leaf-empty)', percent: 0 };
    }
    // —— 旧版：span.text ——
    const spans = document.querySelectorAll('span.text');
    for (const sp of spans) {
      const tx = (sp.textContent || '').trim();
      if (tx === '已完成') return { completed: true, text: tx };
      const m = tx.match(/(\d{1,3})%/);
      if (m) return { completed: false, text: tx, percent: parseInt(m[1]) };
    }
    const fe = document.querySelector('.finish');
    if (fe) return { completed: true, text: '(finish)' };
    return { completed: false, text: '(unknown)', percent: 0 };
  }

  function getActiveLeafTitle() {
    return qText(SEL_ACTIVE_LEAF + ' .leaf-item-title');
  }

  // ===================================================================
  //  引擎激活/停用
  // ===================================================================
  function activateEngine() {
    window._yktEngineActive = true;
    lsSet('_ykt_engine_active', '1');
    updateSharedStatus({ active: true, status: 'playing' });
    panelLog('🔒 引擎已激活（2x + 静音 + 防暂停）');
  }

  function deactivateEngine() {
    window._yktEngineActive = false;
    lsDel('_ykt_engine_active');
    updateSharedStatus({ active: false, status: 'idle' });
    panelLog('🔓 引擎已停用，恢复正常播放');
    if (video) video._scriptAllowPause = true;
  }

  function isEngineActive() {
    return window._yktEngineActive === true || lsGet('_ykt_engine_active') === '1';
  }

  // ===================================================================
  //  面板 UI
  // ===================================================================
  function createPanel() {
    if (!IS_YUKETANG) return;
    // 只在视频播放页显示面板；课程目录页（/pro/lms/.../unfinished 等）不显示
    if (!IS_VIDEO_PAGE) return;
    if (document.getElementById('ykt-panel')) return;
    const mount = document.body || document.documentElement;
    if (!mount) { setTimeout(createPanel, 500); return; }

    if (!document.getElementById('ykt-anim-style')) {
      const style = document.createElement('style');
      style.id = 'ykt-anim-style';
      style.textContent = `
        #ykt-panel { animation: yktSlideUp 0.35s cubic-bezier(0.22, 0.61, 0.36, 1); }
        @keyframes yktSlideUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: translateY(0); } }
        #ykt-btn-toggle, #ykt-btn-copylog, #ykt-btn-report { transition: background .2s, color .2s, transform .15s, box-shadow .2s; }
        #ykt-btn-toggle:active, #ykt-btn-copylog:active, #ykt-btn-report:active { transform: scale(.96); }
        #ykt-btn-report:hover { box-shadow: 0 2px 8px rgba(255,77,79,.25); }
        #ykt-btn-toggle:hover { box-shadow: 0 2px 10px rgba(0,0,0,.12); }
        #ykt-panel-log-wrap { transition: max-height .25s ease, opacity .2s; }
        #ykt-report-overlay { animation: yktFadeIn .2s ease; }
        @keyframes yktFadeIn { from { opacity: 0 } to { opacity: 1 } }
        #ykt-report-overlay > div { animation: yktPopIn .3s cubic-bezier(.22,.61,.36,1); }
        @keyframes yktPopIn { from { opacity: 0; transform: scale(.9) translateY(12px) } to { opacity: 1; transform: scale(1) translateY(0) } }
        #ykt-rpt-yes, #ykt-rpt-no, #ykt-rpt-submit, #ykt-rpt-cancel,
        #ykt-rpt-done, #ykt-rpt-retry, #ykt-rpt-close { transition: background .2s, color .2s, transform .15s, box-shadow .2s; }
        #ykt-rpt-yes:active, #ykt-rpt-no:active, #ykt-rpt-submit:active,
        #ykt-rpt-cancel:active, #ykt-rpt-done:active, #ykt-rpt-retry:active, #ykt-rpt-close:active { transform: scale(.96); }
        #ykt-rpt-yes:hover { box-shadow: 0 2px 8px rgba(255,77,79,.3); }
        #ykt-rpt-submit:hover { box-shadow: 0 2px 8px rgba(22,119,255,.3); }
        #ykt-rpt-desc { transition: border-color .2s, box-shadow .2s; }
        #ykt-rpt-desc:focus { border-color: #1677ff; box-shadow: 0 0 0 2px rgba(22,119,255,.15); outline: none; }
        #ykt-panel-close { transition: color .2s, transform .15s; }
        #ykt-panel-close:hover { color: #ff4d4f; }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement('div');
    panel.id = 'ykt-panel';
    Object.assign(panel.style, {
      position: 'fixed', bottom: '20px', right: '20px', width: '340px',
      background: '#fff', borderRadius: '12px', boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      zIndex: '999998', fontFamily: '"Segoe UI","PingFang SC",Arial,sans-serif',
      fontSize: '13px', color: '#333', overflow: 'hidden', display: 'flex', flexDirection: 'column',
    });

    const active = isEngineActive();
    panel.innerHTML = `
      <div id="ykt-panel-header" style="background:#1677ff; color:#fff; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; cursor:move; font-weight:bold; font-size:14px;">
        <span>🎓 雨课堂连播助手 v${SCRIPT_VERSION}</span>
        <span id="ykt-panel-close" style="cursor:pointer;">✕</span>
      </div>
      <div style="background:#f0f5ff; padding:8px 14px; border-bottom:1px solid #e8e8e8; font-size:12px;">
        状态：<span id="ykt-status-text" style="color:#1677ff;">${active ? '运行中' : '就绪'}</span>
      </div>
      <div style="padding:8px 14px; border-bottom:1px solid #e8e8e8;">
        <button id="ykt-btn-toggle" style="
          width:100%; padding:8px 0; border:none; border-radius:6px;
          background:${active ? '#ff4d4f' : '#1677ff'}; color:#fff; cursor:pointer; font-size:14px;
        ">${active ? '⏹ 停止刷课' : '🚀 开始刷课'}</button>
      </div>
      <div style="padding:6px 14px; display:flex; justify-content:space-between; align-items:center;">
        <span id="ykt-log-toggle" style="cursor:pointer; color:#1677ff; font-size:12px; user-select:none;">📋 展开日志 ▸</span>
        <button id="ykt-btn-copylog" style="padding:2px 10px; border:1px solid #d9d9d9; border-radius:4px; background:#fff; color:#666; cursor:pointer; font-size:10px;">📋 复制</button>
        <button id="ykt-btn-report" style="padding:2px 10px; border:1px solid #ffccc7; border-radius:4px; background:#fff1f0; color:#ff4d4f; cursor:pointer; font-size:10px;">BUG上报</button>
      </div>
      <div id="ykt-panel-log-wrap" style="display:none;">
        <div id="ykt-panel-log" style="padding:6px 10px; font-size:11px; font-family:'Consolas','Monaco',monospace; background:#fafafa; color:#555; max-height:260px; overflow-y:auto; line-height:1.6; word-break:break-all;"></div>
      </div>
      <div id="ykt-panel-tip" style="padding:4px 14px 8px; font-size:10px; color:#aaa; text-align:center;">
        点「开始刷课」→ 自动 2 倍速静音播放，播完自动跳下一个未完成视频
      </div>
    `;
    mount.appendChild(panel);

    document.getElementById('ykt-panel-close').addEventListener('click', () => { panel.style.display = 'none'; });
    document.getElementById('ykt-btn-toggle').addEventListener('click', function () {
      if (isEngineActive()) {
        panelLog('手动停止');
        deactivateEngine();
        stopAll();
        this.textContent = '🚀 开始刷课';
        this.style.background = '#1677ff';
        updatePanelStatus('已停止', '#ff4d4f');
      } else {
        panelLog('手动开始');
        activateEngine();
        this.textContent = '⏹ 停止刷课';
        this.style.background = '#ff4d4f';
        updatePanelStatus('运行中', '#52c41a');
        startSession();
      }
    });
    document.getElementById('ykt-btn-copylog').addEventListener('click', () => {
      const t = panelLogLines.join('\n');
      navigator.clipboard.writeText(t).then(() => panelLog('📋 已复制')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = t;
        ta.style.cssText = 'position:fixed;left:-9999px;'; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      });
    });
    document.getElementById('ykt-btn-report').addEventListener('click', () => showBugReportDialog());
    let logExp = false;
    document.getElementById('ykt-log-toggle').addEventListener('click', function () {
      logExp = !logExp;
      document.getElementById('ykt-panel-log-wrap').style.display = logExp ? 'block' : 'none';
      this.innerHTML = logExp ? '📋 收起日志 ▾' : '📋 展开日志 ▸';
    });

    let dragging = false, sx, sy, px, py;
    document.getElementById('ykt-panel-header').addEventListener('mousedown', (e) => {
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); px = r.left; py = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = px + 'px'; panel.style.top = py + 'px';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      panel.style.left = (px + e.clientX - sx) + 'px';
      panel.style.top = (py + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });

    panelLog('面板已就绪');
  }

  function updatePanelLog() {
    const d = document.getElementById('ykt-panel-log');
    if (d) { d.innerHTML = panelLogLines.map(l => `<div>${l}</div>`).join(''); d.scrollTop = d.scrollHeight; }
  }
  function updatePanelStatus(text, color = '#1677ff') {
    const el = document.getElementById('ykt-status-text');
    if (el) { el.textContent = text; el.style.color = color; }
  }

  function initPanel() {
    if (!IS_YUKETANG) return;
    if (document.body) createPanel();
    else document.addEventListener('DOMContentLoaded', createPanel);
  }
  initPanel();

  // ===================================================================
  //  播放控制
  // ===================================================================
  let video = null;
  let keepAliveTimer = null;
  let healthTimer = null;
  let stopRequested = false;

  function findVideo(timeoutSec = 30) {
    return new Promise((resolve) => {
      let n = 0;
      const total = Math.ceil(timeoutSec);
      const t = setInterval(() => {
        n++;
        const v = document.querySelector('video');
        if (v && v.duration > 0) { clearInterval(t); video = v; resolve(v); return; }
        if (n >= total) { clearInterval(t); resolve(null); }
      }, 1000);
    });
  }

  /** 施加 2x + 静音 + 播放。注意：必须显式赋值，因为播放器在我们钩子之前就已初始化过一次 */
  function engagePlayback(v) {
    const el = v || video || document.querySelector('video');
    if (!el) return;
    video = el;
    el._scriptAllowPause = false;
    try { el.muted = true; } catch (_) {}
    try { el.volume = window._yktVolume; } catch (_) {}
    try { el.playbackRate = window._yktRate; } catch (_) {}
    const apply = () => {
      if (stopRequested) return;
      try { if (el.playbackRate !== window._yktRate) el.playbackRate = window._yktRate; } catch (_) {}
      try { if (el.volume !== window._yktVolume) el.volume = window._yktVolume; } catch (_) {}
      try { if (!el.muted) el.muted = true; } catch (_) {}
      if (el.paused && !el.ended) el.play().catch(() => {});
    };
    apply();
    setTimeout(apply, 800);
    setTimeout(apply, 2500);
  }

  function startKeepAlive() {
    stopKeepAlive();
    keepAliveTimer = setInterval(() => {
      if (!window._yktEngineActive || stopRequested) return;
      const el = document.querySelector('video');
      if (!el) return;
      if (el !== video) { panelLog('↻ 检测到新的 video 元素，重新绑定'); video = el; video._scriptAllowPause = false; engagePlayback(el); return; }
      if (el.paused && !el.ended) el.play().catch(() => {});
      if (el.playbackRate !== window._yktRate) el.playbackRate = window._yktRate;
      if (el.volume !== window._yktVolume) el.volume = window._yktVolume;
    }, 1000);
  }
  function stopKeepAlive() { if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; } }

  /** 播放健康守护：stalled / 元素重建 / 长时间不推进 / 倍速自适应降档 */
  const health = {
    lastCt: -1, stall: 0, reloads: 0, totalStalls: 0,
    rateIdx: 0, winCt: -1, winT: 0, winStall: 0, strikes: 0, lastSpeed: 0,
  };
  const RATE_WINDOW_MS = 5000;
  function startHealthWatch() {
    stopHealthWatch();
    health.lastCt = -1; health.stall = 0; health.totalStalls = 0;
    health.rateIdx = 0; window._yktRate = RATE_LADDER[0];
    health.winCt = -1; health.winT = 0; health.winStall = 0; health.strikes = 0; health.lastSpeed = 0;
    health.reloads = parseInt(ssGet('_ykt_health_reloads') || '0', 10) || 0;
    healthTimer = setInterval(() => {
      if (!window._yktEngineActive || stopRequested) return;
      const el = document.querySelector('video');
      if (!el || el.ended) return;
      const cur = el.currentTime;

      // ── 倍速自适应：每 5 秒评估一次实测有效速度 + 卡顿情况 ──
      const now = Date.now();
      if (health.winCt < 0) { health.winCt = cur; health.winT = now; health.winStall = health.totalStalls; }
      else if (now - health.winT >= RATE_WINDOW_MS) {
        const dt = (now - health.winT) / 1000;
        const speed = dt > 0 ? (cur - health.winCt) / dt : 0;
        const stallsInWin = health.totalStalls - health.winStall;
        const target = window._yktRate;
        health.lastSpeed = +speed.toFixed(2);
        if (speed > 0 && speed < target * 0.75) health.strikes++; else health.strikes = 0;
        if (shouldDropRate({ measuredSpeed: speed, target, stalls: stallsInWin, strikes: health.strikes })
            && health.rateIdx < RATE_LADDER.length - 1) {
          health.rateIdx++;
          window._yktRate = RATE_LADDER[health.rateIdx];
          panelLog(`⚙ 实测仅 ${speed.toFixed(2)}x（目标 ${target}x，卡顿 ${stallsInWin} 次）→ 降档至 ${window._yktRate}x`);
          try { el.playbackRate = window._yktRate; } catch (_) {}
          health.strikes = 0;
        }
        health.winCt = cur; health.winT = now; health.winStall = health.totalStalls;
      }

      if (cur === health.lastCt && el.readyState >= 3) {
        health.stall++;
        health.totalStalls++;
        if (health.stall === 8) {
          panelLog('⚠ 播放停滞，尝试恢复');
          const bb = document.querySelector('xt-bigbutton');
          if (bb && bb.offsetHeight > 0) { try { bb.click(); } catch (_) {} }
          el.play().catch(() => {});
        }
        if (health.stall >= 45) {
          if (health.reloads >= 3) {
            panelLog('❌ 连续卡死多次，停止自动恢复');
            stopAll();
            updatePanelStatus('播放卡死', '#ff4d4f');
            return;
          }
          health.reloads++;
          ssSet('_ykt_health_reloads', String(health.reloads));
          panelLog('❌ 播放卡死，刷新页面重试');
          location.reload();
        }
      } else if (cur !== health.lastCt) {
        health.stall = 0;
      }
      health.lastCt = cur;
    }, 1000);
  }
  function stopHealthWatch() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } }

  function stopAll() {
    stopRequested = true;
    stopKeepAlive();
    stopHealthWatch();
    if (video) { video._scriptAllowPause = true; }
  }

  function waitForVideoEnd() {
    return new Promise((resolve) => {
      const started = Date.now();
      const dur = (video && video.duration) ? video.duration : 600;
      const timeout = Math.max(180000, (dur / 2) * 1000 + 180000);
      const c = setInterval(() => {
        const el = document.querySelector('video');
        if (stopRequested) { clearInterval(c); resolve('stopped'); return; }
        if (!el) { clearInterval(c); resolve('gone'); return; }
        if (el.ended) { clearInterval(c); resolve('ended'); return; }
        if (getVideoStatus().completed) { clearInterval(c); resolve('completed'); return; }
        if (Date.now() - started > timeout) { clearInterval(c); resolve('timeout'); return; }
      }, 1000);
    });
  }

  /** 等「已完成」标记出现；percent 在涨则延长等待 */
  function waitForCompleted(maxSec = 10) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastPercent = null;
      const t = setInterval(() => {
        const st = getVideoStatus();
        if (st.completed) { clearInterval(t); resolve(true); return; }
        if (st.percent !== undefined && lastPercent !== null && st.percent > lastPercent) {
          panelLog(`  进度 ${lastPercent}% → ${st.percent}%`);
        }
        if (st.percent !== undefined) lastPercent = st.percent;
        if (Date.now() - start > maxSec * 1000) { clearInterval(t); resolve(false); }
      }, 1000);
    });
  }

  // ===================================================================
  //  导航
  // ===================================================================
  function gotoUrl(url) {
    panelLog('➡ 跳转: ' + url.replace(/^https?:\/\/[^/]+/, ''));
    location.href = url;
  }

  /** 点击站点自带「下一节」箭头（API 不可用时的兜底） */
  function clickNextArrow() {
    const nxt = document.querySelector(SEL_NEXT_NEW) || document.querySelector('.btn-next');
    if (!nxt) return false;
    if (/is-disable/.test(nxt.className || '')) return false;
    try { nxt.click(); return true; } catch (_) { return false; }
  }

  function attemptsKey(leafId) { return '_ykt_attempt_' + leafId; }
  function getAttempts(leafId) { return parseInt(ssGet(attemptsKey(leafId)) || '0', 10) || 0; }
  function bumpAttempts(leafId) { const n = getAttempts(leafId) + 1; ssSet(attemptsKey(leafId), String(n)); return n; }
  function clearAttempts(leafId) { ssDel(attemptsKey(leafId)); }

  async function finishAll() {
    panelLog('🎉 所有视频已完成！');
    updatePanelStatus('全部完成 🎉', '#1677ff');
    deactivateEngine();
    stopAll();
    const btn = document.getElementById('ykt-btn-toggle');
    if (btn) { btn.textContent = '🚀 开始刷课'; btn.style.background = '#1677ff'; }
  }

  /**
   * 结束当前视频，前往下一个未完成视频。
   * 优先用 todo_list 接口（能自动跳过讨论/作业），接口失败则退回点「下一节」箭头。
   */
  async function goNext(ctx, reason) {
    if (stopRequested) return 'stopped';
    const curLeaf = ctx && ctx.leafId ? String(ctx.leafId) : null;
    if (curLeaf && reason !== 'already-done') clearAttempts(curLeaf);

    let plan = null;
    try {
      plan = await planNextTask(ctx);
      panelLog(`📋 未完成：视频 ${plan.total.video} / 全部 ${plan.total.all}` +
        (plan.currentStillTodo ? '（当前视频服务端尚未确认完成）' : ''));
    } catch (e) {
      panelLog('⚠ 接口查询失败: ' + e.message);
    }

    if (plan) {
      if (plan.next) {
        if (plan.currentStillTodo && curLeaf) {
          const n = bumpAttempts(curLeaf);
          if (n <= 2 && reason !== 'no-video') {
            panelLog(`⚠ 服务端未确认完成，重播一次（第 ${n} 次）`);
            ssSet('_ykt_reload_check', '1');
            location.reload();
            return 'reload';
          }
          panelLog('⚠ 跳过未确认完成的视频，继续下一个');
        }
        gotoUrl(buildVideoUrl(ctx, plan.next.leafId));
        return 'continue';
      }
      // 没有 type=0 的未完成项了
      await finishAll();
      return 'done';
    }

    // —— 接口完全不可用：退回旧策略 ——
    if (clickNextArrow()) return 'continue';
    panelLog('❌ 无法确定下一个视频（接口失败且找不到下一节按钮）');
    updatePanelStatus('已停止', '#ff4d4f');
    stopAll();
    return 'error';
  }

  // ===================================================================
  //  主会话
  // ===================================================================
  async function runVideoPage() {
    stopRequested = false;
    const ctx = parsePageContext(location.pathname);
    if (!ctx || ctx.kind !== 'video') { panelLog('非视频页，跳过'); return 'skip'; }

    panelLog(`▶ 当前视频 leaf=${ctx.leafId} 课程=${ctx.classroomId} ${getActiveLeafTitle() ? '「' + getActiveLeafTitle() + '」' : ''}`);

    const st = getVideoStatus();
    panelLog(`状态: "${st.text}"${st.completed ? ' ✅' : ''}`);

    if (st.completed) {
      panelLog('⏭ 该视频已完成，直接下一个');
      return await goNext(ctx, 'already-done');
    }

    const found = await findVideo(20);
    if (!found) {
      const n = (parseInt(ssGet('_ykt_novideo_count') || '0', 10) || 0) + 1;
      ssSet('_ykt_novideo_count', String(n));
      panelLog(`⚠ 20s 未找到可播放 video（连续第 ${n} 次）`);
      if (n >= 3) {
        ssDel('_ykt_novideo_count');
        panelLog('❌ 连续多次找不到视频，停止（请检查网络或页面是否正常）');
        stopAll();
        updatePanelStatus('已停止', '#ff4d4f');
        return 'done';
      }
      return await goNext(ctx, 'no-video');
    }
    ssDel('_ykt_novideo_count');

    engagePlayback(found);
    startKeepAlive();
    startHealthWatch();
    monitorProgress();

    const result = await waitForVideoEnd();
    panelLog(`播放结束: ${result}`);
    stopKeepAlive();
    stopHealthWatch();
    ssDel('_ykt_health_reloads');
    if (stopRequested) return 'stopped';
    if (result === 'gone' || result === 'timeout') {
      panelLog('⚠ 播放异常结束，重试当前视频');
      const n = bumpAttempts(ctx.leafId);
      if (n <= 2) { ssSet('_ykt_reload_check', '1'); location.reload(); return 'reload'; }
      panelLog('⚠ 重试多次仍失败，跳过该视频');
      return await goNext(ctx, 'no-video');
    }

    panelLog('  等待「已完成」确认...');
    const ok = await waitForCompleted(10);
    if (!ok) {
      panelLog('  ⚠ 未等到「已完成」标记');
      // 用接口二次确认（心跳 videoend 已发出，服务端通常已记录）
      try {
        const plan = await planNextTask(ctx);
        const stillTodo = plan.currentStillTodo;
        panelLog('  接口确认：' + (stillTodo ? '仍未完成' : '已完成 ✅'));
        if (stillTodo) {
          const n = bumpAttempts(ctx.leafId);
          if (n <= 2) { ssSet('_ykt_reload_check', '1'); location.reload(); return 'reload'; }
        }
      } catch (e) {
        panelLog('  接口二次确认失败: ' + e.message);
      }
    } else {
      panelLog('  ✅ 已确认为已完成');
    }

    if (video) { video._shouldStop = true; video._scriptAllowPause = true; }
    return await goNext(ctx, 'done');
  }

  function monitorProgress() {
    const t = setInterval(() => {
      if (!window._yktEngineActive || stopRequested) { clearInterval(t); return; }
      const el = document.querySelector('video');
      if (!el || !el.duration) return;
      const pct = Math.round((el.currentTime / el.duration) * 100);
      updateSharedStatus({ progress: pct, status: 'playing', leaf: parsePageContext(location.pathname)?.leafId });
    }, 5000);
  }

  let sessionRunning = false;
  async function startSession() {
    if (sessionRunning) { panelLog('会话已在运行'); return; }
    sessionRunning = true;
    try {
      const pt = parsePageType(location.pathname);
      panelLog(`开始会话: ${pt}`);
      updatePanelStatus('运行中', '#52c41a');

      if (pt !== 'video') { panelLog('⚠ 请在视频播放页使用'); return; }

      let guard = 0;
      while (guard++ < 500) {
        const r = await runVideoPage();
        if (r !== 'continue' && r !== 'reload') break;
        if (r === 'reload') break;
        // SPA 内部发生了跳转（正常情况下一轮就是新页面，循环通常不执行第二次）
        await new Promise(res => setTimeout(res, 1000));
        if (parsePageType(location.pathname) !== 'video') break;
      }
    } finally {
      sessionRunning = false;
    }
  }

  // ===================================================================
  //  路由监听（SPA 内部跳转）
  // ===================================================================
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const pt = parsePageType(location.pathname);
    panelLog(`页面切换: ${pt}`);
    const panel = document.getElementById('ykt-panel');
    if (pt === 'video') {
      if (!panel) initPanel();
      else panel.style.display = 'flex';
      updatePanelStatus(window._yktEngineActive ? '运行中' : '视频页', window._yktEngineActive ? '#52c41a' : '#1677ff');
      if (isEngineActive()) setTimeout(startSession, 800);
    } else if (panel) {
      // 站点内切到非视频节点（讨论 / 作业等）时收起面板
      panel.style.display = 'none';
    }
  }).observe(document, { subtree: true, childList: true });

  // ===================================================================
  //  启动逻辑
  // ===================================================================
  function boot() {
    if (!IS_YUKETANG) return;
    if (ssGet('_ykt_reload_check') === '1') {
      ssDel('_ykt_reload_check');
      const st = getVideoStatus();
      panelLog(`🔄 刷新后重查："${st.text}"${st.completed ? ' ✅ 已完成' : '（未完成，继续播放）'}`);
    }
    if (isEngineActive() && !sessionRunning) {
      window._yktEngineActive = true;
      updateSharedStatus({ active: true, status: 'playing' });
      const btn = document.getElementById('ykt-btn-toggle');
      if (btn) { btn.textContent = '⏹ 停止刷课'; btn.style.background = '#ff4d4f'; }
      updatePanelStatus('运行中', '#52c41a');
      panelLog('🔄 恢复自动刷课...');
      setTimeout(startSession, 1200);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window._ykt = {
    start: () => { activateEngine(); createPanel(); startSession(); },
    stop: () => { deactivateEngine(); stopAll(); },
    version: SCRIPT_VERSION,
    context: () => parsePageContext(location.pathname),
    status: () => getVideoStatus(),
    plan: async () => planNextTask(parsePageContext(location.pathname)),
    /** 纯函数导出（供单元测试直接测出货代码，避免 core.js 镜像漂移） */
    pure: {
      parsePageContext,
      parsePageType,
      buildVideoUrl,
      pickNextVideo,
      buildApiHeaders,
      getVideoStatus,
      formatDiagnosticsText,
      shouldDropRate,
      RATE_LADDER,
    },
  };

  // ===================================================================
  //  BUG 上报（飞书群机器人）
  // ===================================================================
  const FEISHU_WEBHOOK_URL = 'https://open.feishu.cn/open-apis/bot/v2/hook/1babe215-e574-40e9-9333-ba426c824b92';

  function countSel(sel) { return document.querySelectorAll(sel).length; }

  function collectDiagnosticsJSON() {
    const v = document.querySelector('video');
    const ctx = parsePageContext(location.pathname);
    let leafSummary = { total: 0, done: 0, activeIdx: -1 };
    try {
      const items = Array.from(document.querySelectorAll('.leaf-item'));
      leafSummary = {
        total: items.length,
        done: items.filter(i => i.querySelector(SEL_LEAF_DONE_ICON)).length,
        activeIdx: items.findIndex(i => i.classList.contains('is-active')),
      };
    } catch (_) {}

    return {
      env: {
        timestamp: new Date().toISOString(),
        userAgent: navigator.userAgent,
        currentUrl: location.href.replace(/([?&])sessionid=[^&]*/g, '$1sessionid=***'),
        scriptVersion: SCRIPT_VERSION,
        engineActive: !!window._yktEngineActive,
        screen: { w: window.innerWidth || 0, h: window.innerHeight || 0, dpr: window.devicePixelRatio || 1 },
      },
      page: {
        pageType: parsePageType(location.pathname),
        context: ctx ? { version: ctx.version, classroomId: ctx.classroomId, leafId: ctx.leafId, kind: ctx.kind, rawKind: ctx.rawKind } : null,
        video: v ? {
          duration: Math.round((v.duration || 0) * 10) / 10,
          currentTime: Math.round((v.currentTime || 0) * 10) / 10,
          ended: v.ended, paused: v.paused, muted: v.muted,
          playbackRate: v.playbackRate, volume: v.volume,
          src: (v.currentSrc || v.src || '').replace(/\?.*$/, '?…'),
          readyState: v.readyState, networkState: v.networkState,
          error: v.error ? { code: v.error.code, message: v.error.message } : null,
          seeking: v.seeking, buffered: v.buffered?.length || 0,
        } : null,
        rateText: qText(SEL_RATE_TEXT) || null,
        activeLeafTitle: getActiveLeafTitle() || null,
        leafSummary,
        nextArrow: (() => {
          const n = document.querySelector(SEL_NEXT_NEW);
          if (!n) return null;
          return { cls: String(n.className).slice(0, 80), disabled: /is-disable/.test(n.className || '') };
        })(),
        oldBtns: { btnNext: countSel('.btn-next'), finish: countSel('.finish'), spanText: countSel('span.text') },
        xtPlayer: {
          speedText: qText('xt-speedvalue') || null,
          bigBtnVisible: (() => { const bb = document.querySelector('xt-bigbutton'); return bb ? bb.offsetHeight > 0 : null; })(),
          loadingVisible: (() => { const el = document.querySelector('xt-loading'); return el ? getComputedStyle(el).display !== 'none' : null; })(),
          alertText: qText('xt-alertbox') || qText('xt-alert') || null,
        },
        customElements: (() => {
          const tags = new Set();
          document.querySelectorAll('*').forEach(el => {
            const tag = el.tagName.toLowerCase();
            if (tag.includes('-')) tags.add(tag);
          });
          return Array.from(tags).slice(0, 40);
        })(),
        mediaEvents: mediaEventLog.slice(-20),
        videoErrors: videoErrorLog.slice(-3),
      },
      internal: {
        videoBound: !!video,
        keepAliveRunning: keepAliveTimer !== null,
        healthRunning: healthTimer !== null,
        stopRequested,
        sessionRunning,
        health: { stall: health.stall, reloads: health.reloads, rateIdx: health.rateIdx, targetRate: window._yktRate, lastMeasuredSpeed: health.lastSpeed },
        panelLogLines: panelLogLines.slice(-50),
        sessionFlags: (() => {
          try {
            const o = {};
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              if (k && k.startsWith('_ykt')) o[k] = sessionStorage.getItem(k);
            }
            return o;
          } catch (_) { return null; }
        })(),
        yktStatus: (() => {
          try { const r = lsGet('_ykt_status'); return r ? JSON.parse(r) : null; } catch (_) { return null; }
        })(),
      },
      errorLog: window._yktErrorLog.slice(-3),
    };
  }

  function formatDiagnosticsText(d, userMessage) {
    const lines = [];
    const L = (label, val) => lines.push(`  ${label}: ${val ?? '(null)'}`);

    if (userMessage) {
      lines.push('💬 用户描述');
      lines.push('  ' + userMessage.replace(/\n/g, '\n  '));
      lines.push('');
    }
    lines.push('🐛 雨课堂脚本 BUG 上报');
    lines.push('━━━━━━━━━━━━━━━━━━');
    lines.push('🔴 环境信息');
    L('时间', d.env.timestamp);
    L('脚本版本', d.env.scriptVersion);
    L('引擎状态', d.env.engineActive ? '激活' : '未激活');
    L('浏览器', d.env.userAgent);
    L('当前URL', d.env.currentUrl);
    if (d.env.screen) L('屏幕', `${d.env.screen.w}x${d.env.screen.h} dpr=${d.env.screen.dpr}`);
    lines.push('');
    lines.push('🟡 页面结构');
    L('页面类型', d.page.pageType);
    L('上下文', d.page.context ? JSON.stringify(d.page.context) : '(未识别)');
    if (d.page.video) {
      const v = d.page.video;
      L('video', `ct=${v.currentTime}/${v.duration} ended=${v.ended} paused=${v.paused} muted=${v.muted} rate=${v.playbackRate} vol=${v.volume}`);
      L('video.readyState', `${v.readyState} (${['无数据', '元数据', '当前数据', '未来数据', '足够数据'][v.readyState || 0]})`);
      L('video.networkState', `${v.networkState} (${['空', '闲置', '加载中', '无源'][v.networkState || 0]})`);
      L('video.seeking', v.seeking);
      L('video.buffered', (v.buffered || 0) + '段');
      L('video.error', v.error ? `code=${v.error.code} msg=${v.error.message}` : '(无)');
      L('video.src', v.src);
    } else {
      L('video', '(无)');
    }
    L('完成度文本', d.page.rateText);
    L('当前视频标题', d.page.activeLeafTitle);
    L('目录统计', JSON.stringify(d.page.leafSummary));
    L('下一节箭头', d.page.nextArrow ? `${d.page.nextArrow.disabled ? '禁用' : '可用'} ${d.page.nextArrow.cls}` : '(无)');
    L('旧版选择器', JSON.stringify(d.page.oldBtns));
    lines.push('');
    lines.push('🎬 播放器状态');
    L('xt.speedText', d.page.xtPlayer?.speedText || '(无)');
    L('xt.bigBtnVisible', d.page.xtPlayer?.bigBtnVisible === null ? '(无xt-bigbutton)' : (d.page.xtPlayer?.bigBtnVisible ? '可见' : '隐藏'));
    L('xt.loadingVisible', d.page.xtPlayer?.loadingVisible === null ? '(无xt-loading)' : (d.page.xtPlayer?.loadingVisible ? '可见' : '隐藏'));
    L('xt.alertText', d.page.xtPlayer?.alertText || '(无)');
    if (d.page.customElements?.length) L('自定义元素', d.page.customElements.join(','));
    if (d.page.mediaEvents?.length) {
      lines.push('  mediaEvents:');
      d.page.mediaEvents.forEach(m => lines.push(`    [${m.t}] ${m.type} ct=${m.ct}s rs=${m.rs}`));
    }
    if (d.page.videoErrors?.length) {
      lines.push('  videoErrors:');
      d.page.videoErrors.forEach(m => lines.push(`    [${m.t}] code=${m.code} ct=${m.ct}s`));
    }
    lines.push('');
    lines.push('🟢 脚本内部');
    L('video已绑定', d.internal.videoBound ? '是' : '否');
    L('keepAlive', d.internal.keepAliveRunning ? '运行中' : '停');
    L('healthWatch', d.internal.healthRunning ? '运行中' : '停');
    L('stopRequested', d.internal.stopRequested);
    L('sessionRunning', d.internal.sessionRunning);
    L('health', JSON.stringify(d.internal.health));
    if (d.internal.sessionFlags) L('sessionFlags', JSON.stringify(d.internal.sessionFlags));
    L('ykt_status', d.internal.yktStatus ? JSON.stringify(d.internal.yktStatus) : '(无)');
    lines.push('');
    lines.push('🔴 错误信息');
    if (d.errorLog?.length) {
      d.errorLog.forEach((er, i) => L(`[${i}] ${er.t || '?'}`, `${er.message || '(无)'}${er.stack ? ' | ' + String(er.stack).slice(0, 300) : ''}`));
    } else {
      L('error', '(无)');
    }
    lines.push('');
    lines.push('📋 最近日志');
    d.internal.panelLogLines.forEach(l => lines.push(`  ${l}`));
    lines.push('━━━━━━━━━━━━━━━━━━');
    return lines.join('\n');
  }

  function sendBugReport(userMessage, callback) {
    if (typeof GM_xmlhttpRequest !== 'function') {
      panelLog('⚠ 当前环境不支持 GM_xmlhttpRequest');
      if (callback) callback(false, '当前环境不支持 GM_xmlhttpRequest');
      return;
    }
    let diag;
    try { diag = collectDiagnosticsJSON(); }
    catch (e) { if (callback) callback(false, '采集失败: ' + e.message); return; }
    const text = formatDiagnosticsText(diag, userMessage);
    GM_xmlhttpRequest({
      method: 'POST',
      url: FEISHU_WEBHOOK_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ msg_type: 'text', content: { text: text } }),
      onload: function (r) {
        try {
          const resp = JSON.parse(r.responseText);
          if (r.status === 200 && resp.code === 0) { if (callback) callback(true, 'ok'); }
          else { if (callback) callback(false, 'HTTP ' + r.status + ' / code=' + (resp.code ?? '?')); }
        } catch (_) { if (callback) callback(r.status === 200, 'HTTP ' + r.status); }
      },
      onerror: function (e) { if (callback) callback(false, '网络错误: ' + (e.error || 'unknown')); },
      ontimeout: function () { if (callback) callback(false, '请求超时'); },
      timeout: 15000,
    });
  }

  function showBugReportDialog() {
    const old = document.getElementById('ykt-report-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ykt-report-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
      background: 'rgba(0,0,0,0.45)', zIndex: '9999999',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    });
    const box = document.createElement('div');
    Object.assign(box.style, {
      background: '#fff', borderRadius: '12px', boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
      width: '420px', maxWidth: '90vw', padding: '24px', fontFamily: '"PingFang SC","Segoe UI",Arial,sans-serif',
      fontSize: '14px', color: '#333',
    });
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function showStep1() {
      box.innerHTML = `
        <div>
        <div style="font-size:17px; font-weight:bold; margin-bottom:6px;">🐛 BUG 上报</div>
        <div style="color:#666; margin-bottom:18px;">脚本运行时是否出现了异常？</div>
        <div style="display:flex; gap:10px; justify-content:flex-end;">
          <button id="ykt-rpt-no" style="padding:8px 20px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px;">否，没有异常</button>
          <button id="ykt-rpt-yes" style="padding:8px 20px; border:none; border-radius:6px; background:#ff4d4f; color:#fff; cursor:pointer; font-size:14px;">是，出现异常</button>
        </div>
        </div>`;
      box.querySelector('#ykt-rpt-no').addEventListener('click', () => { panelLog('🐛 用户取消上报：无异常'); overlay.remove(); });
      box.querySelector('#ykt-rpt-yes').addEventListener('click', showStep2);
    }

    function showStep2() {
      box.innerHTML = `
        <div>
        <div style="font-size:17px; font-weight:bold; margin-bottom:10px;">📤 确认上报</div>
        <div style="background:#fff7e6; border:1px solid #ffd591; border-radius:8px; padding:12px; margin-bottom:14px; font-size:12px; color:#8c6d00; line-height:1.7;">
          ⚠️ 点击确认后，可能会弹出油猴的<strong>「跨源资源请求」</strong>安全确认对话框，这是脚本通过 Webhook 发送诊断信息的必要步骤，<strong>请放心点击「总是允许此域名」</strong>。<br>
          💡 无需在浏览器控制台执行任何命令——脚本已自动采集页面结构、播放器事件与运行日志。直接描述你看到的现象即可。
        </div>
        <textarea id="ykt-rpt-desc" placeholder="如果你能更详细地描述遇到的问题，尤其是体验方面的问题，会更有利于开发者帮你解决。当然也可以留空。" style="
          width:100%; height:90px; border:1px solid #d9d9d9; border-radius:8px; padding:12px;
          font-size:13px; font-family:inherit; color:#333; resize:vertical; box-sizing:border-box;
        "></textarea>
        <div style="display:flex; gap:10px; justify-content:flex-end; margin-top:14px;">
          <button id="ykt-rpt-cancel" style="padding:8px 20px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px;">取消</button>
          <button id="ykt-rpt-submit" style="padding:8px 24px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px; font-weight:bold;">确认上报</button>
        </div>
        </div>`;
      box.querySelector('#ykt-rpt-cancel').addEventListener('click', () => { panelLog('🐛 用户取消上报'); overlay.remove(); });
      box.querySelector('#ykt-rpt-submit').addEventListener('click', () => {
        const desc = (box.querySelector('#ykt-rpt-desc').value || '').trim();
        box.innerHTML = `<div style="text-align:center; padding:20px;">
            <div style="font-size:28px; margin-bottom:12px;">⏳</div>
            <div style="font-size:15px; color:#666;">正在发送诊断信息...</div></div>`;
        panelLog('🐛 正在上报...');
        sendBugReport(desc, (ok, msg) => {
          if (ok) {
            box.innerHTML = `<div style="text-align:center; padding:20px;">
                <div style="font-size:36px; margin-bottom:10px;">✅</div>
                <div style="font-size:16px; font-weight:bold; margin-bottom:6px;">上报成功</div>
                <div style="font-size:13px; color:#999; margin-bottom:16px;">开发者已收到你的诊断信息，感谢反馈！ (≧v≦) ♡</div>
                <button id="ykt-rpt-done" style="padding:8px 30px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px;">完成</button></div>`;
            box.querySelector('#ykt-rpt-done').addEventListener('click', () => overlay.remove());
            panelLog('✅ 上报成功');
          } else {
            box.innerHTML = `<div style="text-align:center; padding:20px;">
                <div style="font-size:36px; margin-bottom:10px;">❌</div>
                <div style="font-size:16px; font-weight:bold; margin-bottom:6px;">上报失败</div>
                <div style="font-size:13px; color:#999; margin-bottom:16px;">${msg}</div>
                <button id="ykt-rpt-retry" style="padding:8px 16px; border:1px solid #d9d9d9; border-radius:6px; background:#fff; color:#666; cursor:pointer; font-size:14px; margin-right:8px;">重试</button>
                <button id="ykt-rpt-close" style="padding:8px 16px; border:none; border-radius:6px; background:#1677ff; color:#fff; cursor:pointer; font-size:14px;">关闭</button></div>`;
            box.querySelector('#ykt-rpt-retry').addEventListener('click', () => { showStep2(); const ta = box.querySelector('#ykt-rpt-desc'); if (ta) ta.value = desc; });
            box.querySelector('#ykt-rpt-close').addEventListener('click', () => overlay.remove());
            panelLog('❌ 上报失败: ' + msg);
          }
        });
      });
    }

    showStep1();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // 全局错误捕获（供 BUG 上报使用，环形 3 条）
  window.addEventListener('error', (e) => {
    const entry = { t: ts(), message: e.message || String(e), stack: e.error?.stack || '' };
    window._yktErrorLog.push(entry);
    if (window._yktErrorLog.length > 3) window._yktErrorLog.shift();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const entry = { t: ts(), message: e.reason?.message || String(e.reason), stack: e.reason?.stack || '' };
    window._yktErrorLog.push(entry);
    if (window._yktErrorLog.length > 3) window._yktErrorLog.shift();
  });

  log('就绪', 'INFO', `v${SCRIPT_VERSION} 面板+引擎+接口 全部就绪`);
})();
