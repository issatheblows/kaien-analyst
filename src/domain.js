(() => {
  'use strict';

  const DEFAULT_PERSONA = [
    'You write posts for @kaienphase, an X account about investing and personal finance.',
    'Voice: calm, sharp, practical. No hype, no financial advice disclaimers inside the text, no hashtags spam (max 1), max 1 emoji.',
    'Structure: a strong first-line hook, 1-3 short lines with the key idea from the video in your own words, one takeaway or question for the reader.',
    'Never invent quotes or numbers that are not in the source post. If the source is vague, stay general.',
  ].join(' ');

  const DEFAULTS = Object.freeze({
    mode: 'draft',
    myHandle: 'kaienphase',
    language: 'English',
    maxChars: 280,
    dailyCap: 5,
    minDelayMin: 45,
    maxDelayMin: 120,
    preSendMinSec: 5,
    preSendMaxSec: 12,
    activeFrom: 9,
    activeTo: 22,
    minViews: 50000,
    maxAgeHours: 72,
    onlyVideo: true,
    scanScrolls: 15,
    extraKeywords: '',
    endpoint: 'https://openrouter.ai/api/v1',
    apiPath: '/chat/completions',
    apiKey: '',
    model: 'openrouter/free',
    persona: DEFAULT_PERSONA,
  });

  const TOPICS = [
    { id: 'buffett', label: 'Warren Buffett', re: /buffett|berkshire|баффет/i },
    { id: 'munger', label: 'Charlie Munger', re: /munger|мангер/i },
    { id: 'dalio', label: 'Ray Dalio', re: /dalio|bridgewater|далио/i },
    { id: 'burry', label: 'Michael Burry', re: /burry|бьюрри|берри/i },
    { id: 'lynch', label: 'Peter Lynch', re: /peter lynch|питер линч/i },
    { id: 'wood', label: 'Cathie Wood / ARK', re: /cathie wood|\bark invest|кэти вуд/i },
    { id: 'fed', label: 'ФРС и ставки', re: /\bfed\b|federal reserve|powell|rate cut|rate hike|interest rate|фрс|пауэлл|ключев\w* ставк/i },
    { id: 'inflation', label: 'Инфляция', re: /inflation|\bcpi\b|инфляц/i },
    { id: 'stocks', label: 'Акции и рынок', re: /s&p ?500|nasdaq|dow jones|stock market|stocks?\b|equities|\betf\b|акци|фондов\w* рын/i },
    { id: 'crypto', label: 'Крипта', re: /bitcoin|\bbtc\b|crypto|ethereum|\beth\b|биткоин|крипт/i },
    { id: 'gold', label: 'Золото', re: /\bgold\b|золот/i },
    { id: 'realestate', label: 'Недвижимость', re: /real estate|housing market|mortgage|недвижим|ипотек/i },
    { id: 'macro', label: 'Макро и рецессия', re: /recession|\bgdp\b|debt ceiling|national debt|рецесси|ввп|госдолг/i },
    { id: 'personal', label: 'Личные финансы', re: /compound|saving|budget|retire|passive income|net worth|financial freedom|сложн\w* процент|пассивн\w* доход|сбережен|пенси/i },
    { id: 'earnings', label: 'Отчёты компаний', re: /earnings|revenue|quarterly results|guidance|отчётност|отчетност|выручк/i },
  ];

  const HOOKS = {
    breaking: 'BREAKING / 🚨',
    question: 'Вопрос',
    number: 'Цифра в начале',
    quote: 'Цитата',
    list: 'Список',
    statement: 'Утверждение',
  };

  function parseCount(value) {
    let s = String(value ?? '').trim().toLowerCase().replace(/ /g, ' ');
    if (!s) return 0;
    const m = s.match(/(\d[\d\s.,]*)\s*(?:(k|m|b|тыс\.?|млн|млрд)(?![a-zа-яё]))?/i);
    if (!m) return 0;
    let num = m[1].replace(/\s/g, '');
    const unit = (m[2] || '').replace('.', '');
    if (unit) {
      num = num.replace(',', '.');
    } else if (/^\d{1,3}([.,]\d{3})+$/.test(num)) {
      num = num.replace(/[.,]/g, '');
    } else {
      num = num.replace(',', '.');
    }
    const n = parseFloat(num);
    if (!Number.isFinite(n)) return 0;
    const mult = { k: 1e3, 'тыс': 1e3, m: 1e6, 'млн': 1e6, b: 1e9, 'млрд': 1e9 }[unit] || 1;
    return Math.round(n * mult);
  }

  const METRIC_PATTERNS = {
    replies: /(repl|ответ)/i,
    reposts: /(repost|retweet|репост|ретвит)/i,
    likes: /(like|нравится|отмет)/i,
    bookmarks: /(bookmark|заклад)/i,
    views: /(view|просмотр)/i,
  };

  // Parses X action bar label, e.g. "12 replies, 340 reposts, 5.1K likes, 88 bookmarks, 1.2M views"
  // or "12 ответов, 340 репостов, 5100 отметок «Нравится», 88 закладок, 1 200 000 просмотров".
  function parseGroupLabel(label) {
    const out = { replies: 0, reposts: 0, likes: 0, bookmarks: 0, views: 0 };
    String(label || '').split(/,(?!\d{3}\b)|;/).forEach((part) => {
      const chunk = part.trim();
      if (!/\d/.test(chunk)) return;
      for (const [key, re] of Object.entries(METRIC_PATTERNS)) {
        if (re.test(chunk)) { out[key] = parseCount(chunk); break; }
      }
    });
    return out;
  }

  function detectTopics(text, extraKeywords = '') {
    const src = String(text || '');
    const found = TOPICS.filter((t) => t.re.test(src)).map((t) => t.id);
    const extras = String(extraKeywords || '').split(',').map((k) => k.trim()).filter(Boolean);
    if (extras.some((k) => src.toLowerCase().includes(k.toLowerCase()))) found.push('custom');
    return found;
  }

  function isFinance(post, extraKeywords = '') {
    const text = String(post?.text || '');
    return detectTopics(text, extraKeywords).length > 0 || /\$[A-Z]{1,5}\b/.test(text);
  }

  function hookType(text) {
    const first = String(text || '').trim().split(/\n/)[0].trim();
    if (!first) return 'statement';
    if (/^(breaking|just in|🚨)|🚨/i.test(first)) return 'breaking';
    if (/^["“«']/.test(first) || /^[A-Z][\w .]{1,30}:\s*["“«]/.test(first)) return 'quote';
    if (/^[$€£]?\d/.test(first)) return 'number';
    if (/\n\s*(\d+[.)]|[-•])\s+/.test(String(text))) return 'list';
    if (/\?\s*$/.test(first)) return 'question';
    return 'statement';
  }

  function lengthBucket(text) {
    const n = String(text || '').length;
    if (n < 80) return '< 80';
    if (n < 160) return '80–160';
    if (n <= 280) return '160–280';
    return '> 280';
  }

  function ageHours(post, now = Date.now()) {
    const t = Date.parse(post?.createdAt || '');
    if (!Number.isFinite(t)) return null;
    return Math.max(0, (now - t) / 3600000);
  }

  function engagementRate(post) {
    const views = Number(post?.views) || 0;
    if (!views) return 0;
    const actions = (Number(post.likes) || 0) + (Number(post.reposts) || 0) + (Number(post.replies) || 0) + (Number(post.bookmarks) || 0);
    return actions / views;
  }

  function score(post, now = Date.now()) {
    const views = Number(post?.views) || 0;
    const age = Math.max(1, ageHours(post, now) ?? 24);
    const velocity = views / Math.pow(age, 0.8);
    return Math.round(velocity * (1 + 10 * engagementRate(post)));
  }

  function median(values) {
    const arr = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!arr.length) return 0;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function groupStats(posts, keyFn) {
    const groups = new Map();
    for (const post of posts) {
      const keys = [].concat(keyFn(post)).filter((k) => k !== null && k !== undefined);
      for (const key of keys) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(post);
      }
    }
    return [...groups.entries()].map(([key, items]) => ({
      key,
      count: items.length,
      medianViews: Math.round(median(items.map((p) => Number(p.views) || 0))),
      avgER: items.reduce((s, p) => s + engagementRate(p), 0) / items.length,
    })).sort((a, b) => b.medianViews - a.medianViews);
  }

  function aggregate(posts, options = {}) {
    const list = (posts || []).filter((p) => p && (Number(p.views) || 0) > 0);
    const finance = list.filter((p) => isFinance(p, options.extraKeywords));
    const minSample = options.minSample ?? 3;
    const keep = (rows) => rows.filter((r) => r.count >= minSample);
    return {
      total: (posts || []).length,
      withViews: list.length,
      finance: finance.length,
      videos: finance.filter((p) => p.hasVideo).length,
      medianViews: Math.round(median(finance.map((p) => Number(p.views) || 0))),
      byTopic: groupStats(finance, (p) => detectTopics(p.text, options.extraKeywords)),
      byMedia: groupStats(finance, (p) => (p.hasVideo ? 'Видео' : p.hasImage ? 'Картинка' : 'Текст')),
      byHook: keep(groupStats(finance, (p) => HOOKS[hookType(p.text)])),
      byLength: keep(groupStats(finance, (p) => lengthBucket(p.text))),
      byHour: groupStats(finance, (p) => { const t = Date.parse(p.createdAt || ''); return Number.isFinite(t) ? new Date(t).getHours() : null; })
        .sort((a, b) => a.key - b.key),
      topAuthors: groupStats(finance, (p) => p.handle).filter((r) => r.count >= 2).slice(0, 10),
    };
  }

  function topicLabel(id) {
    if (id === 'custom') return 'Свои ключевые слова';
    return TOPICS.find((t) => t.id === id)?.label || id;
  }

  function recommendations(agg) {
    const tips = [];
    const best = (rows) => rows.find((r) => r.count >= 3);
    const topic = best(agg.byTopic || []);
    if (topic) tips.push(`Тема с лучшими охватами: ${topicLabel(topic.key)} — медиана ${formatNumber(topic.medianViews)} просмотров (${topic.count} постов).`);
    const media = agg.byMedia || [];
    const video = media.find((r) => r.key === 'Видео');
    const text = media.find((r) => r.key === 'Текст');
    if (video && text && text.medianViews > 0) tips.push(`Посты с видео собирают в ${(video.medianViews / text.medianViews).toFixed(1)}× больше просмотров, чем текстовые.`);
    const hook = best(agg.byHook || []);
    if (hook) tips.push(`Лучший тип первой строки: «${hook.key}».`);
    const length = best(agg.byLength || []);
    if (length) tips.push(`Лучшая длина текста: ${length.key} символов.`);
    const hours = (agg.byHour || []).filter((r) => r.count >= 2).sort((a, b) => b.medianViews - a.medianViews).slice(0, 3);
    if (hours.length) tips.push(`Сильнее всего заходят посты, опубликованные в ${hours.map((h) => `${String(h.key).padStart(2, '0')}:00`).join(', ')} (ваше время).`);
    if (!tips.length) tips.push('Пока мало данных. Отсканируйте поиск по финансовым темам — нужно хотя бы 30–50 постов.');
    return tips;
  }

  function rankVideos(posts, options = {}) {
    const now = Number(options.now) || Date.now();
    const used = options.used || {};
    const me = String(options.myHandle || '').replace(/^@/, '').toLowerCase();
    return (posts || [])
      .filter((p) => p && p.postId && !used[p.postId])
      .filter((p) => !options.onlyVideo || p.hasVideo)
      .filter((p) => (Number(p.views) || 0) >= (Number(options.minViews) || 0))
      .filter((p) => { const age = ageHours(p, now); return age === null || !options.maxAgeHours || age <= options.maxAgeHours; })
      .filter((p) => !me || String(p.handle || '').toLowerCase() !== me)
      .filter((p) => isFinance(p, options.extraKeywords))
      .map((p) => ({ ...p, score: score(p, now), er: engagementRate(p), topics: detectTopics(p.text, options.extraKeywords) }))
      .sort((a, b) => b.score - a.score);
  }

  function insightsSummary(agg) {
    const rows = (list, n = 4) => (list || []).slice(0, n).map((r) => `${r.key === undefined ? '' : topicLabel(r.key)} (median ${formatNumber(r.medianViews)} views, n=${r.count})`).join('; ');
    return [
      `Topics that perform best: ${rows(agg.byTopic)}`,
      `Best first-line hooks: ${rows(agg.byHook, 3)}`,
      `Best text length: ${rows(agg.byLength, 2)}`,
    ].join('\n');
  }

  function buildPostMessages(config, post, insights = '') {
    const c = { ...DEFAULTS, ...(config || {}) };
    const limit = maxTextChars(c.maxChars);
    const system = [
      c.persona || DEFAULT_PERSONA,
      `Write in ${c.language || 'English'}.`,
      `Hard limit: ${limit} characters. The original video will be attached as a quote, so do not paste links and do not say "watch this video" as the whole post — add your own insight.`,
      insights ? `What currently performs well in this niche:\n${insights}` : '',
      'Return JSON only: {"post":"..."}',
    ].filter(Boolean).join('\n\n');
    const user = `Source post by @${post.handle} (${formatNumber(post.views)} views):\n${String(post.text || '').slice(0, 1500) || '(no text, video only)'}`;
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
  }

  function buildInsightsMessages(agg, language = 'Russian') {
    return [
      { role: 'system', content: `You are a social media analyst for a finance account on X. Based on the stats, give 5 concrete, actionable recommendations on what to post and how to write it (topics, hooks, length, timing, formats). Be specific, no fluff. Answer in ${language}. Plain text, numbered list.` },
      { role: 'user', content: `Stats from ${agg.finance} finance posts (${agg.videos} with video), median views ${agg.medianViews}.\n${insightsSummary(agg)}\nMedia: ${(agg.byMedia || []).map((r) => `${r.key} median ${r.medianViews}`).join(', ')}` },
    ];
  }

  function parseAIPost(raw) {
    const text = String(raw || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const value = JSON.parse(match[0]);
        if (value && typeof value.post === 'string') return value.post.trim();
      } catch (_) {}
    }
    return text.replace(/^```\w*\s*|```$/g, '').replace(/^["«]|["»]$/g, '').trim();
  }

  // Approximation of X weighted length: Latin/Cyrillic/punctuation = 1, emoji/CJK = 2, URLs = 23.
  function xLength(text) {
    const withoutUrls = String(text || '').replace(/https?:\/\/\S+/g, (m) => 'x'.repeat(23));
    let n = 0;
    for (const ch of withoutUrls) {
      const cp = ch.codePointAt(0);
      const light = cp <= 0x10ff || (cp >= 0x2000 && cp <= 0x200d) || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
      n += light ? 1 : 2;
    }
    return n;
  }

  function maxTextChars(maxChars) {
    // The quoted post URL takes 23 chars + a space.
    return Math.max(20, (Number(maxChars) || 280) - 24);
  }

  function validatePost(text, maxChars = 280) {
    const value = String(text || '').trim();
    if (!value) return { ok: false, reason: 'empty' };
    if (/https?:\/\//i.test(value)) return { ok: false, reason: 'contains-link' };
    const len = xLength(value);
    const limit = maxTextChars(maxChars);
    if (len > limit) return { ok: false, reason: `too-long ${len}/${limit}` };
    return { ok: true, length: len };
  }

  function buildIntentUrl(text, postUrl) {
    const params = new URLSearchParams({ text: String(text || '') });
    if (postUrl) params.set('url', postUrl);
    return `https://x.com/intent/post?${params.toString()}`;
  }

  function dayKey(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function delayMs(minSec, maxSec, random = Math.random()) {
    const lo = Math.max(1, Number(minSec) || 1);
    const hi = Math.max(lo, Number(maxSec) || lo);
    return Math.round((lo + Math.min(1, Math.max(0, random)) * (hi - lo)) * 1000);
  }

  function inActiveHours(config, date = new Date()) {
    const from = Number(config?.activeFrom ?? DEFAULTS.activeFrom);
    const to = Number(config?.activeTo ?? DEFAULTS.activeTo);
    const h = date.getHours();
    if (from === to) return true;
    return from < to ? h >= from && h < to : h >= from || h < to;
  }

  function canPublish(config, state, date = new Date()) {
    if (!['confirm', 'auto'].includes(config?.mode)) return { ok: false, reason: 'draft-mode' };
    const sent = state && state.day === dayKey(date) ? Number(state.sentToday) || 0 : 0;
    if (sent >= Math.max(1, Number(config.dailyCap) || DEFAULTS.dailyCap)) return { ok: false, reason: 'daily-cap' };
    if (config.mode === 'auto' && !inActiveHours(config, date)) return { ok: false, reason: 'outside-active-hours' };
    return { ok: true };
  }

  function formatNumber(n) {
    const v = Number(n) || 0;
    if (v >= 1e9) return `${(v / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return String(Math.round(v));
  }

  function searchUrl(extraKeywords = '') {
    const terms = ['buffett', 'munger', 'dalio', '"stock market"', 'investing', 'inflation', '"federal reserve"']
      .concat(String(extraKeywords || '').split(',').map((k) => k.trim()).filter(Boolean).map((k) => (/\s/.test(k) ? `"${k}"` : k)));
    const q = `(${terms.join(' OR ')}) filter:videos min_faves:300`;
    return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`;
  }

  const api = {
    DEFAULTS, DEFAULT_PERSONA, TOPICS, HOOKS,
    parseCount, parseGroupLabel, detectTopics, isFinance, hookType, lengthBucket, ageHours, engagementRate, score, median,
    aggregate, topicLabel, recommendations, rankVideos, insightsSummary, buildPostMessages, buildInsightsMessages,
    parseAIPost, xLength, maxTextChars, validatePost, buildIntentUrl, dayKey, delayMs, inActiveHours, canPublish, formatNumber, searchUrl,
  };
  if (typeof module !== 'undefined') module.exports = api;
  if (typeof window !== 'undefined') window.KA = api;
  else if (typeof globalThis !== 'undefined') globalThis.KA = api;
})();
