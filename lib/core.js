/**
 * 雨课堂脚本 — 可测试核心模块
 * 仅包含纯逻辑函数，不含原型链拦截、飞书上报、DOM 操作。
 * 测试时 import，构建时内联到主脚本。
 */

// ========== 工具函数 ==========

/** 返回 HH:MM:SS 格式时间戳 */
export function ts() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map(n => String(n).padStart(2, '0'))
    .join(':');
}

/** 面板日志管理 */
export function createPanelLog() {
  const lines = [];

  function add(msg) {
    lines.push(`[${ts()}] ${msg}`);
    if (lines.length > 100) lines.shift();
  }

  return { lines, add };
}

/** 从 localStorage 读取/更新跨页面状态 */
export function updateSharedStatus(updates) {
  try {
    const raw = localStorage.getItem('_ykt_status');
    const cur = raw ? JSON.parse(raw) : {};
    Object.assign(cur, updates, { _ts: Date.now() });
    localStorage.setItem('_ykt_status', JSON.stringify(cur));
  } catch (_) {}
}

// ========== 页面类型检测 ==========

/** 基于 pathname 判断当前页面类型 */
export function detectPageType(pathname) {
  const p = pathname || '';
  if (p.includes('/pro/courselist') || p.includes('/v2/web/xcloud/courselist')) return 'course_list';
  // 华工: /pro/lms/.../video/...；长江: /v2/web/xcloud/video-student/...
  if (p.includes('/video/') || p.includes('/video-student/')) return 'video';
  if (p.endsWith('/score')) return 'score';
  if (p.endsWith('/studycontent')) return 'study';
  if (p.endsWith('/forum') || p.endsWith('/announcement')) return 'other';
  return 'unknown';
}

/** 判断是否为雨课堂域名 */
export function isYuketang(hostname) {
  return /yuketang\.cn/.test(hostname || '');
}

/** 判断是否为视频页（华工 /pro/lms/.../video/...；长江 /v2/web/xcloud/video-student/...） */
export function isVideoPage(pathname, hostname) {
  return isYuketang(hostname)
    && (/\/pro\/lms\/.*\/video\//.test(pathname || '') || /\/v2\/web\/xcloud\/video-student\//.test(pathname || ''));
}

/** 判断是否为成绩单页 */
export function isScorePage(pathname, hostname) {
  return isYuketang(hostname)
    && (/\/pro\/lms\/.*\/score/.test(pathname || '') || /\/v2\/web\/xcloud\/.*\/score/.test(pathname || ''));
}

/**
 * 解析长江雨课堂视频页 URL：/v2/web/xcloud/video-student/{courseId}/{leafId}
 * @param {string} pathname
 * @returns {{courseId: string, leafId: string} | null}
 */
export function parseVideoStudentUrl(pathname) {
  const m = (pathname || '').match(/^\/v2\/web\/xcloud\/video-student\/(\d+)\/(\d+)$/);
  if (!m) return null;
  return { courseId: m[1], leafId: m[2] };
}

/**
 * 构造下一个视频的跳转 URL
 * 长江: /v2/web/xcloud/video-student/{courseId}/{leafId} → 替换 leafId
 * 华工: /pro/lms/{sig}/{cid}/video/{leafId} → 替换 leafId
 * 长江路径失配时回退到传入 hostname（避免跨站跳到华工域名）
 * @param {string} pathname - 当前页面 pathname
 * @param {string|number} nid - 下一个视频 leafId
 * @param {string} [hostname] - 当前站点 hostname（默认华工）
 * @returns {string}
 */
export function buildNextVideoUrl(pathname, nid, hostname = 'scut.yuketang.cn') {
  const cj = parseVideoStudentUrl(pathname);
  if (cj) return `https://changjiang.yuketang.cn/v2/web/xcloud/video-student/${cj.courseId}/${nid}`;
  const sig = (pathname || '').split('/')[3];
  const cid = (pathname || '').split('/')[4];
  return `https://${hostname}/pro/lms/${sig}/${cid}/video/${nid}`;
}

// ========== 状态检测 ==========

/**
 * 从 span.text 元素中检测视频状态
 * @param {Function} querySelectorAll - document.querySelectorAll 或 mock
 * @returns {{ completed: boolean, text: string, percent?: number }}
 */
export function getVideoStatus(querySelectorAll) {
  const spans = querySelectorAll('span.text');
  for (const sp of spans) {
    const t = (sp.textContent || '').trim();
    if (t === '已完成') return { completed: true, text: t };
    // 支持三种百分比格式："50%" / "完成度：0%" / "完成度: 50%"
    const m = t.match(/(\d{1,3})%/);
    if (m) return { completed: false, text: t, percent: parseInt(m[1]) };
  }

  // .finish 元素兜底
  const fe = document.querySelector?.('.finish');
  if (fe) {
    const sib = fe.parentElement?.querySelector?.('span.text');
    if (sib) {
      const tx = (sib.textContent || '').trim();
      return { completed: tx === '已完成', text: tx };
    }
    return { completed: true, text: '(finish)' };
  }
  return { completed: false, text: '(unknown)', percent: 0 };
}

// ========== 诊断采集 ==========

/**
 * 采集页面诊断数据（不访问 DOM 的纯数据部分）
 * @param {Object} env - { timestamp, userAgent, currentUrl, scriptVersion, engineActive, screen? }
 * @param {Object} page - { pageType, video (null | object), spanText, finishExists, documentTitle, btnNextExists, vueInfo, nextLeaf, preLeaf, xtPlayer, cj?, customElements?, playerInfo?, uiSummary?, mediaEvents?, videoErrors? }
 * @param {Object} internal - { keepAliveRunning, progressRunning, panelLogLines, yktStatus, yktScoreData, sessionFlags?, engineFlags? }
 * @param {Object|Null} error - { message, stack } 或 null
 * @param {Array} [errorLog] - 最近错误史（带时间戳）
 */
export function buildDiagnosticsJSON(env, page, internal, error, errorLog) {
  return {
    env: {
      timestamp: env.timestamp,
      userAgent: env.userAgent,
      currentUrl: env.currentUrl,
      scriptVersion: env.scriptVersion,
      engineActive: !!env.engineActive,
      screen: env.screen || null,
    },
    page: {
      pageType: page.pageType,
      video: page.video || null,
      spanText: page.spanText || [],
      finishExists: !!page.finishExists,
      documentTitle: page.documentTitle || '',
      btnNextExists: !!page.btnNextExists,
      btnNextRect: page.btnNextRect || null,
      vueInstance: page.vueInfo || { exists: false, depth: -1, keys: [], hasRouter: false, hasGetPreAndNextLeaf: false },
      nextLeaf: page.nextLeaf || null,
      preLeaf: page.preLeaf || null,
      xtPlayer: page.xtPlayer || {},
      cj: page.cj || null,
      customElements: page.customElements || [],
      playerInfo: page.playerInfo || null,
      uiSummary: page.uiSummary || [],
      mediaEvents: (page.mediaEvents || []).slice(-20),
      videoErrors: (page.videoErrors || []).slice(-3),
    },
    internal: {
      keepAliveRunning: !!internal.keepAliveRunning,
      progressRunning: !!internal.progressRunning,
      panelLogLines: (internal.panelLogLines || []).slice(-50),
      sessionFlags: internal.sessionFlags || null,
      engineFlags: internal.engineFlags || null,
      yktStatus: sanitizeYktStatus(internal.yktStatus),
      yktScoreData: sanitizeYktScoreData(internal.yktScoreData),
    },
    error: error ? { message: error.message, stack: String(error.stack || '').slice(0, 2000) } : null,
    errorLog: (errorLog || []).slice(-3),
  };
}

function sanitizeYktStatus(raw) {
  if (!raw) return null;
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (p.total !== undefined) delete p.items;
    return { _ts: p._ts, active: p.active, status: p.status, progress: p.progress, total: p.total };
  } catch (_) { return null; }
}

function sanitizeYktScoreData(raw) {
  if (!raw) return null;
  try {
    const d = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { time: d.time, total: d.total };
  } catch (_) { return null; }
}

// ========== 诊断格式化 ==========

/**
 * 将诊断 JSON 格式化为飞书消息文本
 * @param {Object} d - buildDiagnosticsJSON 的输出
 * @param {string} [userMessage] - 用户可选描述
 * @returns {string}
 */
export function formatDiagnosticsText(d, userMessage) {
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

  if (d.page.video) {
    L('video.duration', d.page.video.duration);
    L('video.currentTime', d.page.video.currentTime);
    L('video.ended', d.page.video.ended);
    L('video.paused', d.page.video.paused);
    L('video.muted', d.page.video.muted);
    L('video.playbackRate', d.page.video.playbackRate);
    L('video.readyState', d.page.video.readyState + ' (' +
      ['无数据', '元数据', '当前数据', '未来数据', '足够数据'][d.page.video.readyState || 0] + ')');
    L('video.networkState', d.page.video.networkState + ' (' +
      ['空', '闲置', '加载中', '无源'][d.page.video.networkState || 0] + ')');
    L('video.seeking', d.page.video.seeking);
    L('video.buffered', (d.page.video.buffered || 0) + '段');
    L('video.error', d.page.video.error
      ? `code=${d.page.video.error.code} msg=${d.page.video.error.message}`
      : '(无)');
    L('video.src', d.page.video.src);
  } else {
    L('video', '(无)');
  }

  L('document.title', d.page.documentTitle);
  L('span.text', JSON.stringify(d.page.spanText));
  L('.finish', d.page.finishExists ? '存在' : '不存在');
  L('.btn-next', d.page.btnNextExists ? '存在' : '不存在');

  if (d.page.btnNextRect) {
    L('  btnNext.rect', `x=${d.page.btnNextRect.x} y=${d.page.btnNextRect.y} ${d.page.btnNextRect.w}x${d.page.btnNextRect.h}`);
  }

  L('Vue实例', d.page.vueInstance.exists
    ? `depth=${d.page.vueInstance.depth} keys=[${(d.page.vueInstance.keys || []).join(',')}]`
    : '未找到');
  L('$router', d.page.vueInstance.hasRouter ? '有' : '无');
  L('getPreAndNextLeaf', d.page.vueInstance.hasGetPreAndNextLeaf ? '有' : '无');
  L('nextLeaf', d.page.nextLeaf ? JSON.stringify(d.page.nextLeaf) : '(无)');
  L('preLeaf', d.page.preLeaf ? JSON.stringify(d.page.preLeaf) : '(无)');
  lines.push('');
  lines.push('🎬 播放器状态');
  L('xt.speedText', d.page.xtPlayer?.speedText || '(无)');
  L('xt.bigBtnVisible', d.page.xtPlayer?.bigBtnVisible === null
    ? '(无xt-bigbutton)' : (d.page.xtPlayer?.bigBtnVisible ? '可见' : '隐藏'));
  L('xt.loadingVisible', d.page.xtPlayer?.loadingVisible === null
    ? '(无xt-loading)' : (d.page.xtPlayer?.loadingVisible ? '可见' : '隐藏'));
  L('xt.alertText', d.page.xtPlayer?.alertText || '(无)');
  if (d.page.cj) {
    L('cj.videoStudent', d.page.cj.parsed ? JSON.stringify(d.page.cj.parsed) : '(非长江视频页)');
    L('cj.links', d.page.cj.videoStudentLinks?.length
      ? JSON.stringify(d.page.cj.videoStudentLinks.slice(0, 5)) : '(无 video-student 链接)');
    L('cj.videoCount', (d.page.cj.videoCount ?? 0) + '个');
  }
  if (d.page.customElements?.length) {
    L('自定义元素', d.page.customElements.join(','));
  }
  if (d.page.playerInfo) {
    L('playerGlobals', d.page.playerInfo.globals?.length ? JSON.stringify(d.page.playerInfo.globals) : '(无)');
    if (d.page.playerInfo.videoAttrs) L('videoAttrs', JSON.stringify(d.page.playerInfo.videoAttrs));
  }
  if (d.page.uiSummary?.length) {
    lines.push('  uiSummary:');
    d.page.uiSummary.forEach(u => lines.push(
      `    ${u.sel} ×${u.count}${u.tag ? ` <${u.tag} class="${u.cls}">` : ''}${u.text ? ` text="${u.text}"` : ''}`));
  }
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
  L('keepAliveTimer', d.internal.keepAliveRunning ? '运行中' : '停');
  L('progressTimer', d.internal.progressRunning ? '运行中' : '停');
  if (d.internal.sessionFlags) L('sessionFlags', JSON.stringify(d.internal.sessionFlags));
  if (d.internal.engineFlags) L('engineFlags', JSON.stringify(d.internal.engineFlags));
  L('ykt_status', d.internal.yktStatus ? JSON.stringify(d.internal.yktStatus) : '(无)');
  L('ykt_score_data', d.internal.yktScoreData ? JSON.stringify(d.internal.yktScoreData) : '(无)');
  lines.push('');
  lines.push('🔴 错误信息');
  if (d.errorLog?.length) {
    d.errorLog.forEach((er, i) => {
      L(`[${i}] ${er.t || '?'}`, `${er.message || '(无)'}${er.stack ? ' | ' + String(er.stack).slice(0, 300) : ''}`);
    });
  } else if (d.error) {
    L('error.message', d.error.message);
    L('error.stack', d.error.stack);
  } else {
    L('error', '(无)');
  }
  lines.push('');
  lines.push('📋 最近日志');
  (d.internal.panelLogLines || []).forEach(l => lines.push(`  ${l}`));
  lines.push('━━━━━━━━━━━━━━━━━━');
  return lines.join('\n');
}

// ========== 成绩单解析 ==========

/**
 * 从成绩单页面解析视频列表
 * @param {Array<{textContent: string, querySelector: Function}>} liElements
 * @returns {{ totalVideos: number, titles: Array<{title: string, completed: boolean}> }}
 */
export function parseScorePageItems(liElements) {
  const items = [];
  liElements.forEach((li) => {
    const typeText = (li.querySelector?.('span.cursorpoint.unit-name-hover')?.textContent
      || li.querySelector?.('span[class*="unit-name"]')?.textContent || '').trim();
    const title = (li.querySelector?.('div.chapter-name-td')?.textContent
      || li.querySelector?.('div[class*="chapter-name"]')?.textContent || '').trim();
    if (typeText === 'Video' && title) {
      const done = /已完成/.test(li.textContent || '');
      items.push({ title, completed: done });
    }
  });
  const videoItems = items.filter(it => it.title.includes('、') || it.title.length > 3);
  return {
    totalVideos: videoItems.length,
    titles: videoItems,
  };
}

// ========== 视频标题匹配 ==========

/**
 * 在成绩数据中匹配当前视频标题的索引
 * @param {Array<{title: string, completed: boolean}>} titles
 * @param {string} currentTitle
 * @returns {{ index: number, total: number } | null}
 */
export function matchVideoTitle(titles, currentTitle) {
  if (!titles?.length || !currentTitle) return null;

  for (let i = 0; i < titles.length; i++) {
    if (titles[i].title === currentTitle) {
      return { index: i + 1, total: titles.length, title: currentTitle };
    }
  }
  // 模糊匹配
  for (let i = 0; i < titles.length; i++) {
    if (currentTitle.includes(titles[i].title) || titles[i].title.includes(currentTitle)) {
      return { index: i + 1, total: titles.length, title: titles[i].title };
    }
  }
  return null;
}
