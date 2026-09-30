(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = KA.formatNumber;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const send = (message) => new Promise((resolve) => chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { ok: false, reason: chrome.runtime.lastError.message } : (r || { ok: false }))));
  const get = (defaults) => new Promise((resolve) => chrome.storage.local.get(defaults, resolve));

  const SETTING_KEYS = ['mode', 'myHandle', 'language', 'maxChars', 'dailyCap', 'minDelayMin', 'maxDelayMin', 'preSendMinSec', 'preSendMaxSec', 'activeFrom', 'activeTo',
    'minViews', 'maxAgeHours', 'onlyVideo', 'scanScrolls', 'extraKeywords', 'endpoint', 'apiPath', 'model', 'apiKey', 'persona'];
  const NUMERIC = ['maxChars', 'dailyCap', 'minDelayMin', 'maxDelayMin', 'preSendMinSec', 'preSendMaxSec', 'activeFrom', 'activeTo', 'minViews', 'maxAgeHours', 'scanScrolls'];
  const MODE_LABEL = { draft: 'ЧЕРНОВИК', confirm: 'ПОДТВЕРЖДЕНИЕ', auto: 'АВТО' };
  const STATUS_LABEL = { pending: 'в очереди', open: 'открыт', sent: 'опубликован', drafted: 'черновик', skipped: 'пропущен', failed: 'ошибка', timeout: 'таймаут' };

  let data = { config: { ...KA.DEFAULTS }, posts: {}, state: {}, queue: [], used: {}, debugLogs: [] };
  let filters = null;
  let selected = null;

  function status(el, text, isError = false) {
    const node = $(el);
    node.textContent = text;
    node.classList.toggle('err', !!isError);
  }

  // ---------- tabs ----------
  document.querySelectorAll('[data-tab]').forEach((tab) => tab.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${tab.dataset.tab}`; });
    try { localStorage.setItem('ka-tab', tab.dataset.tab); } catch (_) {}
  }));
  try {
    const saved = localStorage.getItem('ka-tab');
    if (saved) document.querySelector(`[data-tab="${saved}"]`)?.click();
  } catch (_) {}

  // ---------- tooltip ----------
  const tip = $('tooltip');
  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.hidden = true; return; }
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
  });
  document.addEventListener('mousemove', (e) => {
    if (tip.hidden) return;
    const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    tip.style.left = `${x}px`;
    tip.style.top = `${e.clientY + 16}px`;
  });

  // ---------- charts ----------
  function bars(el, rows, labelFn = (r) => r.key) {
    const node = $(el);
    if (!rows.length) { node.innerHTML = '<div class="empty">Недостаточно данных</div>'; return; }
    const max = Math.max(...rows.map((r) => r.medianViews), 1);
    node.innerHTML = rows.slice(0, 8).map((r) => {
      const label = labelFn(r);
      const tipText = `${label}: медиана ${fmt(r.medianViews)} просмотров · ${r.count} постов · ER ${pct(r.avgER)}`;
      return `<div class="bar-row" data-tip="${esc(tipText)}"><span class="bar-label">${esc(label)}</span><span class="bar-track"><span class="bar-fill" style="width:${(r.medianViews / max * 100).toFixed(1)}%;display:block"></span></span><span class="bar-value">${fmt(r.medianViews)}</span></div>`;
    }).join('');
  }

  function hours(rows) {
    const byHour = new Map(rows.map((r) => [Number(r.key), r]));
    const max = Math.max(...rows.map((r) => r.medianViews), 1);
    $('c-hours').innerHTML = Array.from({ length: 24 }, (_, h) => {
      const r = byHour.get(h);
      const height = r ? Math.max(2, r.medianViews / max * 100) : 2;
      const tipText = r ? `${String(h).padStart(2, '0')}:00 — медиана ${fmt(r.medianViews)} просмотров · ${r.count} постов` : `${String(h).padStart(2, '0')}:00 — нет данных`;
      return `<div class="col" data-tip="${esc(tipText)}"><div class="col-fill${r ? '' : ' none'}" style="height:${height.toFixed(1)}%"></div><div class="col-label">${h % 3 === 0 ? h : ''}</div></div>`;
    }).join('');
  }

  // ---------- analytics ----------
  function renderAnalytics() {
    const posts = Object.values(data.posts || {});
    const c = data.config;
    const agg = KA.aggregate(posts, { extraKeywords: c.extraKeywords });
    const sentToday = data.state?.day === KA.dayKey() ? data.state.sentToday || 0 : 0;
    $('k-total').textContent = fmt(agg.total);
    $('k-finance').textContent = fmt(agg.finance);
    $('k-videos').textContent = fmt(agg.videos);
    $('k-median').textContent = agg.finance ? fmt(agg.medianViews) : '—';
    $('k-sent').textContent = `${sentToday}/${c.dailyCap}`;
    $('empty-hint').hidden = agg.finance > 0;
    $('tips').innerHTML = KA.recommendations(agg).map((t) => `<li>${esc(t)}</li>`).join('');
    bars('c-topics', agg.byTopic, (r) => KA.topicLabel(r.key));
    bars('c-media', agg.byMedia);
    bars('c-hooks', agg.byHook);
    bars('c-length', agg.byLength);
    hours(agg.byHour);
    $('t-authors').innerHTML = agg.topAuthors.length
      ? agg.topAuthors.map((r) => `<tr><td><a href="https://x.com/${esc(r.key)}" target="_blank" rel="noopener">@${esc(r.key)}</a></td><td class="num">${r.count}</td><td class="num">${fmt(r.medianViews)}</td><td class="num">${pct(r.avgER)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="empty">Нужно больше данных</td></tr>';
  }

  $('ai-insights').addEventListener('click', async () => {
    const out = $('ai-insights-out');
    out.hidden = false;
    out.textContent = 'Анализирую…';
    const r = await send({ type: 'AI_INSIGHTS' });
    out.textContent = r.ok ? r.text : `Ошибка: ${r.reason}`;
  });

  // ---------- videos ----------
  function ageLabel(post) {
    const h = KA.ageHours(post);
    if (h === null) return '—';
    return h < 1 ? '<1 ч' : h < 48 ? `${Math.round(h)} ч` : `${Math.round(h / 24)} д`;
  }

  function renderVideos() {
    const posts = Object.values(data.posts || {});
    const opts = { ...data.config, ...filters, used: filters.showUsed ? {} : data.used };
    const list = KA.rankVideos(posts, opts).slice(0, 100);
    $('v-count').textContent = `найдено: ${list.length}`;
    $('t-videos').innerHTML = list.length ? list.map((p, i) => `
      <tr data-id="${esc(p.postId)}" class="${selected?.postId === p.postId ? 'selected' : ''}">
        <td class="num">${i + 1}</td>
        <td class="post-cell">
          <div class="post-author"><a href="${esc(p.postUrl)}" target="_blank" rel="noopener">@${esc(p.handle)}</a> ${p.hasVideo ? '▶' : ''}</div>
          <div class="post-text">${esc(p.text || '(без текста)')}</div>
          <div class="chips">${p.topics.map((t) => `<span class="chip">${esc(KA.topicLabel(t))}</span>`).join('')}${data.used[p.postId] ? '<span class="chip used">использовано</span>' : ''}</div>
        </td>
        <td class="num">${fmt(p.views)}</td>
        <td class="num">${pct(p.er)}</td>
        <td class="num">${ageLabel(p)}</td>
        <td><button class="small write" type="button">Написать пост</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Нет видео под фильтры. Отсканируйте поиск на x.com или ослабьте фильтры.</td></tr>';
  }

  $('t-videos').addEventListener('click', (e) => {
    const btn = e.target.closest('button.write');
    if (!btn) return;
    const id = btn.closest('tr').dataset.id;
    selected = data.posts[id];
    renderVideos();
    generate();
  });

  ['f-minViews', 'f-maxAgeHours', 'f-onlyVideo', 'f-showUsed'].forEach((id) => $(id).addEventListener('input', () => {
    filters = {
      minViews: Number($('f-minViews').value) || 0,
      maxAgeHours: Number($('f-maxAgeHours').value) || 0,
      onlyVideo: $('f-onlyVideo').checked,
      showUsed: $('f-showUsed').checked,
    };
    renderVideos();
  }));

  function updateCounter() {
    const limit = KA.maxTextChars(data.config.maxChars);
    const len = KA.xLength($('ed-text').value.trim());
    $('ed-len').textContent = `${len} / ${limit}`;
    $('ed-len').classList.toggle('over', len > limit);
    const ok = !!selected && KA.validatePost($('ed-text').value, data.config.maxChars).ok;
    $('ed-queue').disabled = !ok;
    $('ed-open').disabled = !ok;
  }
  $('ed-text').addEventListener('input', updateCounter);

  async function generate() {
    if (!selected) return;
    $('ed-source').innerHTML = `Источник: <a href="${esc(selected.postUrl)}" target="_blank" rel="noopener">@${esc(selected.handle)}</a> · ${fmt(selected.views)} просмотров`;
    $('ed-regen').disabled = true;
    status('ed-status', 'AI пишет пост…');
    const r = await send({ type: 'GENERATE_POST', postId: selected.postId });
    $('ed-regen').disabled = false;
    if (r.text) $('ed-text').value = r.text;
    status('ed-status', r.ok ? 'Готово. Можно отредактировать.' : `AI: ${r.reason}${r.text ? ' — поправьте вручную' : ''}`, !r.ok);
    updateCounter();
  }
  $('ed-regen').addEventListener('click', generate);

  async function queueCurrent() {
    const r = await send({ type: 'QUEUE_ADD', postId: selected.postId, text: $('ed-text').value.trim() });
    if (!r.ok) status('ed-status', r.reason, true);
    return r;
  }
  $('ed-queue').addEventListener('click', async () => {
    const r = await queueCurrent();
    if (r.ok) status('ed-status', 'Добавлено в очередь.');
  });
  $('ed-open').addEventListener('click', async () => {
    const r = await queueCurrent();
    if (!r.ok) return;
    const o = await send({ type: 'OPEN_JOB', jobId: r.job.id });
    status('ed-status', o.ok ? 'Открыл X с готовым постом и цитатой.' : `Не открыто: ${o.reason}`, !o.ok);
  });

  // ---------- queue ----------
  function renderQueue() {
    const q = [...(data.queue || [])].reverse();
    const pending = q.filter((j) => j.status === 'pending').length;
    $('queue-badge').hidden = !pending;
    $('queue-badge').textContent = pending;
    const c = data.config;
    const sentToday = data.state?.day === KA.dayKey() ? data.state.sentToday || 0 : 0;
    const parts = [`режим: ${MODE_LABEL[c.mode] || c.mode}`, `сегодня ${sentToday}/${c.dailyCap}`];
    if (data.autopilot) parts.push(`автопилот ВКЛ${data.nextRunAt ? ` · следующий пост ~${new Date(data.nextRunAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`);
    if (data.queueRunning) parts.push('очередь запущена');
    $('runner-status').textContent = parts.join(' · ');
    $('q-auto-on').disabled = c.mode !== 'auto' || data.autopilot;
    $('q-auto-off').disabled = !data.autopilot;
    $('q-start').disabled = c.mode !== 'confirm';
    $('q-list').innerHTML = q.length ? q.map((j) => `
      <div class="q-item" data-id="${esc(j.id)}">
        <div>
          <div class="q-text">${esc(j.text)}</div>
          <div class="q-meta">Цитата: <a href="${esc(j.postUrl)}" target="_blank" rel="noopener">@${esc(j.handle)}</a> · ${fmt(j.views)} просмотров · ${new Date(j.createdAt).toLocaleString()}${j.origin === 'autopilot' ? ' · автопилот' : ''}${j.reason ? ` · ${esc(j.reason)}` : ''}</div>
        </div>
        <div class="q-actions">
          <span class="st st-${esc(j.status)}">${esc(STATUS_LABEL[j.status] || j.status)}</span>
          ${j.status === 'pending' ? '<button class="small q-open" type="button">Открыть</button><button class="small danger q-del" type="button">✕</button>' : ''}
        </div>
      </div>`).join('') : '<div class="card empty">Очередь пуста. Выберите видео во вкладке «Видео».</div>';
  }

  $('q-list').addEventListener('click', async (e) => {
    const id = e.target.closest('.q-item')?.dataset.id;
    if (!id) return;
    if (e.target.closest('.q-open')) {
      const r = await send({ type: 'OPEN_JOB', jobId: id });
      status('q-status', r.ok ? 'Открыто в X.' : r.reason, !r.ok);
    }
    if (e.target.closest('.q-del')) await send({ type: 'QUEUE_REMOVE', jobId: id });
  });
  $('q-start').addEventListener('click', async () => { const r = await send({ type: 'START_QUEUE' }); status('q-status', r.ok ? 'Очередь запущена.' : r.reason, !r.ok); });
  $('q-auto-on').addEventListener('click', async () => { const r = await send({ type: 'AUTOPILOT', on: true }); status('q-status', r.ok ? 'Автопилот включён.' : r.reason, !r.ok); });
  $('q-auto-off').addEventListener('click', async () => { const r = await send({ type: 'AUTOPILOT', on: false }); status('q-status', r.ok ? 'Автопилот выключен.' : r.reason, !r.ok); });
  $('q-clear').addEventListener('click', () => send({ type: 'QUEUE_CLEAR_DONE' }));
  $('panic').addEventListener('click', async () => { await send({ type: 'EMERGENCY_STOP' }); status('q-status', 'Всё остановлено.'); });

  // ---------- settings ----------
  function fillSettings() {
    const c = data.config;
    SETTING_KEYS.forEach((k) => {
      const el = $(k);
      if (el.type === 'checkbox') el.checked = !!c[k];
      else el.value = c[k] ?? '';
    });
  }

  $('save').addEventListener('click', async () => {
    const config = {};
    SETTING_KEYS.forEach((k) => { const el = $(k); config[k] = el.type === 'checkbox' ? el.checked : el.value.trim(); });
    NUMERIC.forEach((k) => { const n = Number(config[k]); config[k] = Number.isFinite(n) && config[k] !== '' ? n : KA.DEFAULTS[k]; });
    config.myHandle = config.myHandle.replace(/^@/, '');
    config.dailyCap = Math.min(30, Math.max(1, config.dailyCap));
    config.minDelayMin = Math.max(10, config.minDelayMin);
    config.maxDelayMin = Math.max(config.minDelayMin, config.maxDelayMin);
    config.preSendMaxSec = Math.max(config.preSendMinSec, config.preSendMaxSec);
    config.activeFrom = Math.min(23, Math.max(0, config.activeFrom));
    config.activeTo = Math.min(23, Math.max(0, config.activeTo));
    await chrome.storage.local.set({ config });
    if (config.mode !== 'auto' && data.autopilot) await send({ type: 'AUTOPILOT', on: false });
    status('s-status', 'Сохранено.');
  });
  $('openrouter').addEventListener('click', () => {
    $('endpoint').value = 'https://openrouter.ai/api/v1';
    $('apiPath').value = '/chat/completions';
    $('model').value = 'openrouter/free';
    status('s-status', 'OpenRouter Free выбран — вставьте API key и сохраните.');
  });
  $('resetPersona').addEventListener('click', () => { $('persona').value = KA.DEFAULT_PERSONA; status('s-status', 'Стиль сброшен — сохраните.'); });

  $('export').addEventListener('click', () => {
    const cols = ['postId', 'handle', 'postUrl', 'createdAt', 'views', 'likes', 'reposts', 'replies', 'bookmarks', 'hasVideo', 'text'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = Object.values(data.posts || {}).map((p) => cols.map((c) => cell(p[c])).join(','));
    const blob = new Blob([[cols.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kaien-analyst-${KA.dayKey()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('wipe').addEventListener('click', async () => {
    if (!confirm('Удалить все собранные посты? Очередь и история публикаций останутся.')) return;
    await chrome.storage.local.set({ posts: {} });
    status('s-status', 'Собранные посты удалены.');
  });

  // ---------- logs ----------
  function renderLogs() {
    const logs = Array.isArray(data.debugLogs) ? data.debugLogs : [];
    $('logs').innerHTML = logs.length ? logs.map((l) => {
      const cls = /ERROR|FAILED|INVALID|TIMEOUT|blocked|EMERGENCY/i.test(l.message) ? 'log-err' : /SENT|OK|DRAFTED|add/i.test(l.message) ? 'log-ok' : '';
      return `<div class="${cls}">[${new Date(l.ts).toLocaleTimeString()}] ${esc(l.message)}</div>`;
    }).join('') : 'Логов пока нет.';
    $('logs').scrollTop = $('logs').scrollHeight;
  }
  $('clearLogs').addEventListener('click', () => chrome.storage.local.set({ debugLogs: [] }));

  // ---------- load & live updates ----------
  function renderHeader() {
    const pill = $('mode-pill');
    pill.textContent = data.emergencyStop ? 'STOPPED' : MODE_LABEL[data.config.mode] || data.config.mode;
    pill.classList.toggle('off', !!data.emergencyStop);
  }

  async function load(first = false) {
    const s = await get({ config: {}, posts: {}, state: {}, queue: [], used: {}, debugLogs: [], autopilot: false, queueRunning: false, nextRunAt: 0, emergencyStop: false });
    data = { ...s, config: { ...KA.DEFAULTS, ...(s.config || {}) } };
    if (!filters) {
      filters = { minViews: data.config.minViews, maxAgeHours: data.config.maxAgeHours, onlyVideo: data.config.onlyVideo, showUsed: false };
      $('f-minViews').value = filters.minViews;
      $('f-maxAgeHours').value = filters.maxAgeHours;
      $('f-onlyVideo').checked = filters.onlyVideo;
    }
    if (first) fillSettings();
    renderHeader();
    renderAnalytics();
    renderVideos();
    renderQueue();
    renderLogs();
    updateCounter();
  }

  let reloadTimer = null;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => load(false), 300);
  });

  load(true);
})();
