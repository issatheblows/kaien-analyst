importScripts('domain.js');

const MAX_POSTS = 5000;
const JOB_TIMEOUT_MIN = { draft: 2, confirm: 30, auto: 10 };
const ALARM_NEXT = 'kaien-next';
const ALARM_TIMEOUT = 'kaien-job-timeout';

// ---------- storage helpers ----------
const store = {
  get: (defaults) => new Promise((resolve, reject) => chrome.storage.local.get(defaults, (v) => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(v)))),
  set: (values) => new Promise((resolve, reject) => chrome.storage.local.set(values, () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()))),
};

// Serialise all read-modify-write operations so several tabs can't overwrite each other.
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function getConfig() {
  const { config } = await store.get({ config: {} });
  return { ...KA.DEFAULTS, ...(config || {}) };
}

async function getState() {
  const { state } = await store.get({ state: null });
  const today = KA.dayKey();
  return state && state.day === today ? state : { day: today, sentToday: 0, draftedToday: 0 };
}

function log(message) {
  return locked(async () => {
    const { debugLogs } = await store.get({ debugLogs: [] });
    const logs = Array.isArray(debugLogs) ? debugLogs : [];
    logs.push({ ts: Date.now(), message: String(message).slice(0, 400) });
    await store.set({ debugLogs: logs.slice(-300) });
  });
}

// ---------- AI ----------
async function aiChat(messages) {
  const config = await getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(String(config.endpoint).replace(/\/$/, '') + (config.apiPath || KA.DEFAULTS.apiPath), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://x.com/',
        'X-Title': 'kaien analyst',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, stream: false, messages }),
    });
    if (!response.ok) return { ok: false, reason: `AI HTTP ${response.status}` };
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) return { ok: false, reason: 'empty-ai-response' };
    return { ok: true, content };
  } catch (error) {
    const msg = String(error?.message || error);
    if (error?.name === 'AbortError') return { ok: false, reason: 'AI timeout after 60s' };
    if (/failed to fetch|networkerror|econnrefused/i.test(msg)) return { ok: false, reason: 'AI endpoint недоступен: проверьте адрес и API key' };
    return { ok: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function allPosts() {
  const { posts } = await store.get({ posts: {} });
  return Object.values(posts || {});
}

async function generatePost(postId) {
  const config = await getConfig();
  const posts = await allPosts();
  const source = posts.find((p) => p.postId === postId);
  if (!source) return { ok: false, reason: 'post-not-found' };
  const agg = KA.aggregate(posts, { extraKeywords: config.extraKeywords });
  const insights = agg.finance >= 20 ? KA.insightsSummary(agg) : '';
  await log(`AI POST REQUEST @${source.handle} ${postId}`);
  let last = { ok: false, reason: 'no-attempt' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = KA.buildPostMessages(config, source, insights);
    if (attempt > 1) messages.push({ role: 'user', content: `Your previous answer was invalid (${last.reason}). Shorter, no links. JSON only.` });
    const result = await aiChat(messages);
    if (!result.ok) { await log(`AI ERROR: ${result.reason}`); return result; }
    const text = KA.parseAIPost(result.content);
    const check = KA.validatePost(text, config.maxChars);
    if (check.ok) { await log(`AI POST OK @${source.handle} len=${check.length}`); return { ok: true, text, length: check.length }; }
    last = { ok: false, reason: check.reason, text };
    await log(`AI POST INVALID @${source.handle}: ${check.reason}`);
  }
  return last;
}

// ---------- posts collected by content scripts ----------
function savePosts(incoming) {
  return locked(async () => {
    const { posts } = await store.get({ posts: {} });
    const map = posts || {};
    let added = 0;
    for (const p of incoming || []) {
      if (!p || !p.postId) continue;
      const prev = map[p.postId];
      if (!prev) added++;
      map[p.postId] = {
        ...prev,
        ...p,
        views: Math.max(Number(p.views) || 0, Number(prev?.views) || 0),
        firstSeenAt: prev?.firstSeenAt || p.seenAt || Date.now(),
      };
    }
    let entries = Object.values(map);
    if (entries.length > MAX_POSTS) {
      entries = entries.sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0)).slice(0, MAX_POSTS);
    }
    await store.set({ posts: Object.fromEntries(entries.map((p) => [p.postId, p])) });
    return { added, total: entries.length };
  });
}

// ---------- queue ----------
async function getQueue() {
  const { queue } = await store.get({ queue: [] });
  return Array.isArray(queue) ? queue : [];
}

function updateQueue(mutator) {
  return locked(async () => {
    const queue = await getQueue();
    const next = (await mutator(queue)) || queue;
    await store.set({ queue: next.slice(-200) });
    return next;
  });
}

async function addJob(post, text, origin = 'manual') {
  const job = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    postId: post.postId,
    postUrl: post.postUrl || `https://x.com/${post.handle}/status/${post.postId}`,
    handle: post.handle,
    views: post.views,
    text,
    origin,
    status: 'pending',
    createdAt: Date.now(),
  };
  await updateQueue((q) => { q.push(job); return q; });
  await log(`QUEUE add @${post.handle} ${post.postId} (${origin})`);
  return job;
}

async function setJobStatus(jobId, status, extra = {}) {
  await updateQueue((q) => q.map((j) => (j.id === jobId ? { ...j, ...extra, status, updatedAt: Date.now() } : j)));
}

// ---------- publishing via X composer ----------
async function runJob(job) {
  const config = await getConfig();
  const { emergencyStop } = await store.get({ emergencyStop: false });
  if (emergencyStop) return { ok: false, reason: 'emergency-stop' };
  const mode = config.mode;
  if (mode !== 'draft') {
    const gate = KA.canPublish(config, await getState());
    if (!gate.ok) { await log(`PUBLISH blocked: ${gate.reason}`); return { ok: false, reason: gate.reason }; }
  }
  const check = KA.validatePost(job.text, config.maxChars);
  if (!check.ok) { await setJobStatus(job.id, 'failed', { reason: check.reason }); return { ok: false, reason: check.reason }; }
  const tab = await chrome.tabs.create({ url: KA.buildIntentUrl(job.text, job.postUrl), active: mode !== 'auto' });
  await store.set({ activeJob: { jobId: job.id, tabId: tab.id, mode, startedAt: Date.now() } });
  await setJobStatus(job.id, 'open');
  chrome.alarms.create(ALARM_TIMEOUT, { delayInMinutes: JOB_TIMEOUT_MIN[mode] || 10 });
  await log(`COMPOSER open @${job.handle} mode=${mode}`);
  return { ok: true };
}

async function finishJob(jobId, outcome, reason = '') {
  const { activeJob, used, history } = await store.get({ activeJob: null, used: {}, history: [] });
  if (!activeJob || activeJob.jobId !== jobId) return;
  chrome.alarms.clear(ALARM_TIMEOUT);
  await store.set({ activeJob: null });
  const queue = await getQueue();
  const job = queue.find((j) => j.id === jobId);
  await setJobStatus(jobId, outcome, reason ? { reason } : {});
  await log(`JOB ${outcome.toUpperCase()} @${job?.handle || '?'}${reason ? `: ${reason}` : ''}`);
  if (job && (outcome === 'sent' || outcome === 'drafted')) {
    const state = await getState();
    if (outcome === 'sent') state.sentToday = (state.sentToday || 0) + 1;
    else state.draftedToday = (state.draftedToday || 0) + 1;
    const nextHistory = (Array.isArray(history) ? history : []).concat({ ts: Date.now(), postId: job.postId, handle: job.handle, text: job.text, outcome });
    await store.set({ state, used: { ...used, [job.postId]: Date.now() }, history: nextHistory.slice(-2000) });
  }
  if (activeJob.mode === 'auto' && outcome === 'sent') setTimeout(() => chrome.tabs.remove(activeJob.tabId).catch(() => {}), 4000);
  await scheduleNext(activeJob.mode, outcome);
}

async function scheduleNext(mode, outcome) {
  const { queueRunning, autopilot, emergencyStop } = await store.get({ queueRunning: false, autopilot: false, emergencyStop: false });
  if (emergencyStop) return;
  if (mode === 'confirm' && queueRunning) {
    setTimeout(() => processNext().catch((e) => log(`RUNNER ERROR: ${e.message}`)), 4000);
  } else if (mode === 'auto' && autopilot) {
    const config = await getConfig();
    const ms = outcome === 'sent' ? KA.delayMs(config.minDelayMin * 60, config.maxDelayMin * 60) : 5 * 60000;
    chrome.alarms.create(ALARM_NEXT, { when: Date.now() + ms });
    await store.set({ nextRunAt: Date.now() + ms });
    await log(`AUTOPILOT next in ${Math.round(ms / 60000)} min`);
  }
}

async function tabAlive(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch (_) { return false; }
}

async function processNext() {
  const config = await getConfig();
  const { emergencyStop, activeJob, autopilot, queueRunning, lastAutoScanAt } = await store.get({ emergencyStop: false, activeJob: null, autopilot: false, queueRunning: false, lastAutoScanAt: 0 });
  if (emergencyStop) return;
  if (activeJob) {
    if (await tabAlive(activeJob.tabId)) return;
    await finishJob(activeJob.jobId, 'skipped', 'tab closed');
    return;
  }
  const running = (config.mode === 'confirm' && queueRunning) || (config.mode === 'auto' && autopilot);
  if (!running) return;

  const gate = KA.canPublish(config, await getState());
  if (!gate.ok) {
    await log(`RUNNER paused: ${gate.reason}`);
    if (config.mode === 'auto') {
      chrome.alarms.create(ALARM_NEXT, { delayInMinutes: 30 });
      await store.set({ nextRunAt: Date.now() + 30 * 60000 });
    } else {
      await store.set({ queueRunning: false });
    }
    return;
  }

  let job = (await getQueue()).find((j) => j.status === 'pending');
  if (!job && config.mode === 'auto') {
    const { used } = await store.get({ used: {} });
    const [best] = KA.rankVideos(await allPosts(), { ...config, used });
    if (!best) {
      if (Date.now() - (lastAutoScanAt || 0) > 20 * 60000) {
        await store.set({ lastAutoScanAt: Date.now() });
        const tab = await chrome.tabs.create({ url: KA.searchUrl(config.extraKeywords), active: false });
        await store.set({ activeScan: { tabId: tab.id, startedAt: Date.now() } });
        await log('AUTOPILOT no candidates → scanning search');
        return;
      }
      await log('AUTOPILOT no candidates after scan, retry in 30 min');
      chrome.alarms.create(ALARM_NEXT, { delayInMinutes: 30 });
      await store.set({ nextRunAt: Date.now() + 30 * 60000 });
      return;
    }
    const generated = await generatePost(best.postId);
    if (!generated.ok) {
      await store.set({ used: { ...used, [best.postId]: -Date.now() } });
      chrome.alarms.create(ALARM_NEXT, { delayInMinutes: 5 });
      return;
    }
    job = await addJob(best, generated.text, 'autopilot');
  }
  if (!job) {
    await log('QUEUE empty — runner stopped');
    await store.set({ queueRunning: false });
    return;
  }
  const result = await runJob(job);
  if (!result.ok && config.mode === 'auto') chrome.alarms.create(ALARM_NEXT, { delayInMinutes: 5 });
}

async function emergencyStop() {
  await store.set({ emergencyStop: true, queueRunning: false, autopilot: false, nextRunAt: 0 });
  await chrome.alarms.clearAll();
  const { activeJob } = await store.get({ activeJob: null });
  if (activeJob) await finishJob(activeJob.jobId, 'skipped', 'emergency stop');
  await log('EMERGENCY STOP');
}

// ---------- events ----------
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NEXT) processNext().catch((e) => log(`RUNNER ERROR: ${e.message}`));
  if (alarm.name === ALARM_TIMEOUT) {
    const { activeJob } = await store.get({ activeJob: null });
    if (activeJob) await finishJob(activeJob.jobId, 'timeout', 'no result from composer');
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeJob, activeScan } = await store.get({ activeJob: null, activeScan: null });
  if (activeJob?.tabId === tabId) await finishJob(activeJob.jobId, activeJob.mode === 'draft' ? 'drafted' : 'skipped', 'tab closed');
  if (activeScan?.tabId === tabId) {
    await store.set({ activeScan: null });
    processNext().catch(() => {});
  }
});

const handlers = {
  async GET_CONFIG() {
    const { apiKey, ...config } = await getConfig();
    const { emergencyStop } = await store.get({ emergencyStop: false });
    return { ok: true, config, hasKey: !!apiKey, emergencyStop };
  },
  async SAVE_POSTS(message) { return { ok: true, ...(await savePosts(message.posts)) }; },
  async GENERATE_POST(message) { return generatePost(message.postId); },
  async AI_INSIGHTS() {
    const config = await getConfig();
    const agg = KA.aggregate(await allPosts(), { extraKeywords: config.extraKeywords });
    if (agg.finance < 10) return { ok: false, reason: 'Мало данных: нужно хотя бы 10 финансовых постов' };
    const result = await aiChat(KA.buildInsightsMessages(agg, 'Russian'));
    return result.ok ? { ok: true, text: result.content.trim() } : result;
  },
  async QUEUE_ADD(message) {
    const post = (await allPosts()).find((p) => p.postId === message.postId);
    if (!post) return { ok: false, reason: 'post-not-found' };
    const job = await addJob(post, String(message.text || '').trim());
    return { ok: true, job };
  },
  async QUEUE_REMOVE(message) {
    await updateQueue((q) => q.filter((j) => j.id !== message.jobId || j.status === 'open'));
    return { ok: true };
  },
  async QUEUE_CLEAR_DONE() {
    await updateQueue((q) => q.filter((j) => ['pending', 'open'].includes(j.status)));
    return { ok: true };
  },
  async OPEN_JOB(message) {
    const { activeJob } = await store.get({ activeJob: null });
    if (activeJob && (await tabAlive(activeJob.tabId))) return { ok: false, reason: 'Уже открыт другой пост — завершите его' };
    if (activeJob) await store.set({ activeJob: null });
    await store.set({ emergencyStop: false });
    const job = (await getQueue()).find((j) => j.id === message.jobId);
    if (!job) return { ok: false, reason: 'job-not-found' };
    return runJob(job);
  },
  async START_QUEUE() {
    const config = await getConfig();
    if (config.mode !== 'confirm') return { ok: false, reason: 'Очередь запускается в режиме «Подтверждение»' };
    await store.set({ queueRunning: true, emergencyStop: false });
    await log('QUEUE runner started');
    processNext().catch((e) => log(`RUNNER ERROR: ${e.message}`));
    return { ok: true };
  },
  async AUTOPILOT(message) {
    const config = await getConfig();
    if (message.on) {
      if (config.mode !== 'auto') return { ok: false, reason: 'Автопилот работает только в режиме «Автоматический»' };
      if (!config.apiKey && /openrouter/.test(config.endpoint)) return { ok: false, reason: 'Добавьте API key в настройках' };
      await store.set({ autopilot: true, emergencyStop: false });
      await log('AUTOPILOT on');
      processNext().catch((e) => log(`RUNNER ERROR: ${e.message}`));
    } else {
      await store.set({ autopilot: false, nextRunAt: 0 });
      chrome.alarms.clear(ALARM_NEXT);
      await log('AUTOPILOT off');
    }
    return { ok: true };
  },
  async EMERGENCY_STOP() { await emergencyStop(); return { ok: true }; },
  async GET_TASK_FOR_TAB(message, sender) {
    const tabId = sender.tab?.id;
    const { activeJob, activeScan } = await store.get({ activeJob: null, activeScan: null });
    const config = await getConfig();
    if (activeJob && activeJob.tabId === tabId) {
      const job = (await getQueue()).find((j) => j.id === activeJob.jobId);
      if (job) return { ok: true, task: 'publish', job, mode: activeJob.mode, preSendMinSec: config.preSendMinSec, preSendMaxSec: config.preSendMaxSec };
    }
    if (activeScan && activeScan.tabId === tabId) return { ok: true, task: 'scan', scrolls: config.scanScrolls };
    return { ok: true, task: null };
  },
  async JOB_RESULT(message) { await finishJob(message.jobId, message.outcome, message.reason); return { ok: true }; },
  async SCAN_DONE(message, sender) {
    const { activeScan } = await store.get({ activeScan: null });
    if (activeScan?.tabId === sender.tab?.id) {
      await store.set({ activeScan: null });
      await log(`AUTOPILOT scan done, new posts: ${message.added || 0}`);
      chrome.tabs.remove(sender.tab.id).catch(() => {});
      processNext().catch((e) => log(`RUNNER ERROR: ${e.message}`));
    }
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || sender.id !== chrome.runtime.id) return;
  const handler = handlers[message.type];
  if (!handler) return;
  handler(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
  return true;
});
