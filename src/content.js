(() => {
  'use strict';

  const SEL = {
    card: 'article[data-testid="tweet"]',
    text: '[data-testid="tweetText"]',
    status: 'a[href*="/status/"]',
    group: '[role="group"][aria-label]',
    video: '[data-testid="videoPlayer"], [data-testid="videoComponent"], video',
    image: '[data-testid="tweetPhoto"] img',
    time: 'time[datetime]',
    views: 'a[href$="/analytics"]',
    textbox: '[data-testid="tweetTextarea_0"], div[role="dialog"] div[role="textbox"], div[role="textbox"][contenteditable="true"]',
    sendButton: '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const normalize = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const sent = new Map(); // postId -> views already sent to background
  let config = { ...KA.DEFAULTS };
  let scanning = false;
  let sessionCount = 0;
  let stopRequested = false;

  const send = (message) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { ok: false, reason: chrome.runtime.lastError.message } : (r || { ok: false })));
    } catch (error) {
      resolve({ ok: false, reason: String(error?.message || error) });
    }
  });

  // ---------- reading posts ----------
  function statusMeta(card) {
    const links = [...card.querySelectorAll(SEL.status)];
    const main = links.find((a) => a.querySelector('time')) || links.find((a) => !a.closest('[role="link"] [role="link"]')) || links[0];
    const href = main?.getAttribute('href') || '';
    const m = href.match(/^\/([A-Za-z0-9_]+)\/status\/(\d+)/);
    return m ? { handle: m[1].toLowerCase(), postId: m[2], postUrl: `https://x.com/${m[1]}/status/${m[2]}` } : null;
  }

  function readCard(card) {
    const meta = statusMeta(card);
    if (!meta) return null;
    const raw = card.innerText || '';
    if (/\n(Ad|Promoted|Реклама)\n/.test(`\n${raw}\n`)) return null;
    const metrics = KA.parseGroupLabel(card.querySelector(SEL.group)?.getAttribute('aria-label'));
    if (!metrics.views) metrics.views = KA.parseCount(card.querySelector(SEL.views)?.getAttribute('aria-label'));
    const textNode = card.querySelector(SEL.text);
    return {
      ...meta,
      ...metrics,
      text: normalize(textNode?.innerText || textNode?.textContent).slice(0, 1500),
      hasVideo: !!card.querySelector(SEL.video),
      hasImage: !!card.querySelector(SEL.image),
      createdAt: card.querySelector(SEL.time)?.getAttribute('datetime') || null,
      seenAt: Date.now(),
    };
  }

  async function collectVisible() {
    const fresh = [];
    for (const card of document.querySelectorAll(SEL.card)) {
      const post = readCard(card);
      if (!post || !post.views) continue;
      if (sent.get(post.postId) === post.views) continue;
      sent.set(post.postId, post.views);
      fresh.push(post);
    }
    if (!fresh.length) return 0;
    const result = await send({ type: 'SAVE_POSTS', posts: fresh });
    if (result.ok) {
      sessionCount += result.added || 0;
      updatePanel(result.total);
      return result.added || 0;
    }
    return 0;
  }

  let collectTimer = null;
  const observer = new MutationObserver(() => {
    if (!/\/(intent|compose)\//.test(location.pathname)) addPanel();
    clearTimeout(collectTimer);
    collectTimer = setTimeout(() => collectVisible().catch(() => {}), 1500);
  });

  async function scan(scrolls) {
    if (scanning) return 0;
    scanning = true;
    stopRequested = false;
    let added = 0;
    setPanelState('SCANNING');
    try {
      for (let i = 0; i < scrolls && !stopRequested; i++) {
        added += await collectVisible();
        notify(`Сканирование: ${i + 1}/${scrolls} · новых постов: ${added}`);
        window.scrollBy({ top: Math.floor(window.innerHeight * 0.9), behavior: 'smooth' });
        await sleep(1200 + Math.random() * 1000);
      }
      added += await collectVisible();
      notify(stopRequested ? `Сканирование остановлено. Новых постов: ${added}` : `Готово. Новых постов: ${added}. Откройте дашборд.`);
    } finally {
      scanning = false;
      setPanelState('READY');
    }
    return added;
  }

  // ---------- composer (publishing) ----------
  async function waitFor(selector, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(300);
    }
    return null;
  }

  function setText(box, text) {
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    } catch (_) {}
    if (!normalize(box.innerText)) document.execCommand?.('insertText', false, text);
    return !!normalize(box.innerText);
  }

  async function runPublishTask(task) {
    const { job, mode } = task;
    const box = await waitFor(SEL.textbox, 25000);
    if (!box) return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'failed', reason: 'composer not found' });
    await sleep(800);
    if (!normalize(box.innerText) && !setText(box, `${job.text} ${job.postUrl}`)) {
      return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'failed', reason: 'text insert failed' });
    }

    if (mode === 'draft') {
      notify('Черновик готов: проверьте текст и цитату и опубликуйте сами.');
      return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'drafted' });
    }

    if (mode === 'confirm') {
      notify('Проверьте пост и нажмите «Опубликовать». Закройте окно, чтобы пропустить.');
      let clickedSend = false;
      const onClick = (e) => { if (e.target.closest?.(SEL.sendButton)) clickedSend = true; };
      const onKey = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) clickedSend = true; };
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      while (!stopRequested && document.querySelector(SEL.textbox)) await sleep(500);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      await sleep(1500);
      const failed = hasError();
      const outcome = stopRequested ? 'skipped' : clickedSend && !failed ? 'sent' : 'skipped';
      notify(outcome === 'sent' ? 'Опубликовано. Готовлю следующий пост…' : 'Пост пропущен.');
      return send({ type: 'JOB_RESULT', jobId: job.id, outcome, reason: failed ? 'X reported an error' : '' });
    }

    // auto
    const wait = KA.delayMs(task.preSendMinSec, task.preSendMaxSec);
    for (let left = Math.ceil(wait / 1000); left > 0; left--) {
      if (stopRequested) return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'skipped', reason: 'stopped' });
      notify(`Автопубликация через ${left} с`);
      await sleep(1000);
    }
    const button = await waitFor(`${SEL.sendButton}:not([aria-disabled="true"]):not([disabled])`, 8000);
    if (!button) return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'failed', reason: 'send button unavailable' });
    button.click();
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (hasError()) return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'failed', reason: 'X reported an error' });
      if (!document.querySelector(SEL.textbox)) {
        notify('Опубликовано автопилотом.');
        return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'sent' });
      }
    }
    return send({ type: 'JOB_RESULT', jobId: job.id, outcome: 'failed', reason: 'composer stayed open' });
  }

  function hasError() {
    return [...document.querySelectorAll('[role="alert"], [data-testid="toast"]')]
      .some((n) => /error|something went wrong|try again|ошиб|повтор|already said/i.test(n.innerText || ''));
  }

  // ---------- UI ----------
  function notify(text) {
    let el = document.getElementById('ka-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ka-status';
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, 12000);
  }

  function setPanelState(text) {
    const el = document.getElementById('ka-panel-state');
    if (el) el.textContent = text;
  }

  function updatePanel(total) {
    const el = document.getElementById('ka-panel-count');
    if (el) el.textContent = `база: ${total ?? '—'} · за сессию: +${sessionCount}`;
  }

  function injectStyles() {
    if (document.getElementById('ka-styles')) return;
    const style = document.createElement('style');
    style.id = 'ka-styles';
    style.textContent = `
      #ka-panel{position:fixed;z-index:2147483646;right:12px;top:72px;width:min(290px,calc(100vw - 24px));box-sizing:border-box;padding:12px;background:#0b1220;color:#e6edf6;border:1px solid #1e2a3d;border-radius:14px;box-shadow:0 12px 32px rgba(0,0,0,.35);font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}
      #ka-panel .ka-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
      #ka-panel .ka-title{font:700 10px/1 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.16em;color:#8aa0bd}
      #ka-panel #ka-panel-state{font:700 10px/1 ui-monospace,monospace;color:#34d399;padding:4px 7px;border-radius:999px;background:rgba(52,211,153,.12)}
      #ka-panel #ka-panel-count{color:#8aa0bd;font:11px ui-monospace,monospace;margin-bottom:10px;font-variant-numeric:tabular-nums}
      #ka-panel .ka-row{display:flex;gap:6px;flex-wrap:wrap}
      #ka-panel button{flex:1 1 auto;min-height:32px;padding:6px 10px;border-radius:9px;border:1px solid #243349;background:#111a2b;color:#e6edf6;font:600 12px system-ui,sans-serif;cursor:pointer}
      #ka-panel button:hover{border-color:#34d399}
      #ka-panel button.ka-primary{background:#10b981;border-color:#10b981;color:#04120c}
      #ka-panel button.ka-danger{color:#fb7185}
      #ka-panel button:focus-visible{outline:2px solid #34d399;outline-offset:2px}
      #ka-status{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 14px;background:#0b1220;color:#e6edf6;border:1px solid #1e2a3d;border-left:3px solid #10b981;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.35);font:13px/1.45 system-ui,sans-serif}
    `;
    document.documentElement.appendChild(style);
  }

  function addPanel() {
    if (document.getElementById('ka-panel') || !document.body) return;
    injectStyles();
    const box = document.createElement('div');
    box.id = 'ka-panel';
    box.innerHTML = `
      <div class="ka-head"><span class="ka-title">[ KAIEN ANALYST ]</span><span id="ka-panel-state">READY</span></div>
      <div id="ka-panel-count">база: — · за сессию: +0</div>
      <div class="ka-row">
        <button id="ka-scan" class="ka-primary" type="button">Сканировать</button>
        <button id="ka-find" type="button">Финансовые видео</button>
        <button id="ka-stop" class="ka-danger" type="button">Стоп</button>
      </div>`;
    box.querySelector('#ka-scan').onclick = () => scan(Number(config.scanScrolls) || 15);
    box.querySelector('#ka-find').onclick = () => { location.href = KA.searchUrl(config.extraKeywords); };
    box.querySelector('#ka-stop').onclick = () => { stopRequested = true; notify('Остановлено.'); };
    document.body.appendChild(box);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.emergencyStop?.newValue === true) { stopRequested = true; notify('Аварийная остановка.'); }
  });

  async function init() {
    const cfg = await send({ type: 'GET_CONFIG' });
    if (cfg.config) config = cfg.config;
    const isComposer = /\/(intent|compose)\//.test(location.pathname);
    if (!isComposer) addPanel();
    observer.observe(document.body, { childList: true, subtree: true });
    collectVisible().catch(() => {});

    // The background stores the task right after opening the tab, so a fast page may ask too early — retry briefly.
    let task = await send({ type: 'GET_TASK_FOR_TAB' });
    for (let i = 0; i < 8 && !task.task && (isComposer || /\/search/.test(location.pathname)); i++) {
      await sleep(1000);
      task = await send({ type: 'GET_TASK_FOR_TAB' });
    }
    if (task.task === 'publish') runPublishTask(task).catch((e) => send({ type: 'JOB_RESULT', jobId: task.job.id, outcome: 'failed', reason: String(e?.message || e) }));
    if (task.task === 'scan') {
      await sleep(4000);
      const added = await scan(Number(task.scrolls) || 15);
      send({ type: 'SCAN_DONE', added });
    }
  }

  init();
})();
