const test = require('node:test');
const assert = require('node:assert/strict');
const KA = require('../src/domain.js');

const NOW = Date.parse('2026-10-01T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();
const post = (over = {}) => ({ postId: '1', handle: 'finclips', text: 'Warren Buffett on why you should never bet against America', views: 100000, likes: 2000, reposts: 300, replies: 100, bookmarks: 400, hasVideo: true, createdAt: hoursAgo(10), ...over });

test('parseCount handles plain, grouped, K/M/B and Russian units', () => {
  assert.equal(KA.parseCount('340'), 340);
  assert.equal(KA.parseCount('5,100'), 5100);
  assert.equal(KA.parseCount('5.1K'), 5100);
  assert.equal(KA.parseCount('1.2M views'), 1200000);
  assert.equal(KA.parseCount('2B'), 2000000000);
  assert.equal(KA.parseCount('1,2 тыс.'), 1200);
  assert.equal(KA.parseCount('3,4 млн'), 3400000);
  assert.equal(KA.parseCount('1 200 000 просмотров'), 1200000);
  assert.equal(KA.parseCount('88 bookmarks'), 88);
  assert.equal(KA.parseCount(''), 0);
});

test('parseGroupLabel reads English and Russian action bar labels', () => {
  assert.deepEqual(
    KA.parseGroupLabel('12 replies, 340 reposts, 5,100 likes, 88 bookmarks, 1234567 views'),
    { replies: 12, reposts: 340, likes: 5100, bookmarks: 88, views: 1234567 },
  );
  assert.deepEqual(
    KA.parseGroupLabel('12 ответов, 340 репостов, 5100 отметок «Нравится», 88 закладок, 1 200 000 просмотров'),
    { replies: 12, reposts: 340, likes: 5100, bookmarks: 88, views: 1200000 },
  );
});

test('detectTopics and isFinance recognise finance content', () => {
  assert.deepEqual(KA.detectTopics('Buffett and Munger at Berkshire meeting'), ['buffett', 'munger']);
  assert.ok(KA.detectTopics('Powell says rate cut is coming').includes('fed'));
  assert.ok(KA.isFinance({ text: 'Why $NVDA is ripping today' }));
  assert.ok(KA.isFinance({ text: 'my cat video' }, 'cat') === true);
  assert.equal(KA.isFinance({ text: 'Funny cat compilation' }), false);
});

test('hookType classifies first lines', () => {
  assert.equal(KA.hookType('🚨 BREAKING: Fed cuts rates'), 'breaking');
  assert.equal(KA.hookType('Why do most investors lose money?'), 'question');
  assert.equal(KA.hookType('90% of traders fail in year one'), 'number');
  assert.equal(KA.hookType('"Be fearful when others are greedy"'), 'quote');
  assert.equal(KA.hookType('Rules:\n1. Save\n2. Invest'), 'list');
  assert.equal(KA.hookType('Compounding is underrated'), 'statement');
});

test('score favours fast-growing, engaging posts', () => {
  const fresh = post({ createdAt: hoursAgo(2) });
  const old = post({ createdAt: hoursAgo(60) });
  assert.ok(KA.score(fresh, NOW) > KA.score(old, NOW));
  assert.ok(Math.abs(KA.engagementRate(post()) - 0.028) < 1e-9);
});

test('rankVideos filters by video, views, age, self, used and finance', () => {
  const posts = [
    post({ postId: 'a' }),
    post({ postId: 'b', hasVideo: false }),
    post({ postId: 'c', views: 100 }),
    post({ postId: 'd', createdAt: hoursAgo(200) }),
    post({ postId: 'e', handle: 'kaienphase' }),
    post({ postId: 'f', text: 'Funny cat compilation' }),
    post({ postId: 'g' }),
  ];
  const out = KA.rankVideos(posts, { now: NOW, onlyVideo: true, minViews: 50000, maxAgeHours: 72, myHandle: '@KaienPhase', used: { g: 1 } });
  assert.deepEqual(out.map((p) => p.postId), ['a']);
  assert.deepEqual(out[0].topics, ['buffett']);
});

test('aggregate and recommendations produce useful stats', () => {
  const posts = [];
  for (let i = 0; i < 6; i++) posts.push(post({ postId: `v${i}`, views: 200000 + i }));
  for (let i = 0; i < 6; i++) posts.push(post({ postId: `t${i}`, hasVideo: false, text: 'Inflation data is out today, markets react', views: 20000 + i }));
  const agg = KA.aggregate(posts);
  assert.equal(agg.finance, 12);
  assert.equal(agg.videos, 6);
  assert.equal(agg.byTopic[0].key, 'buffett');
  const tips = KA.recommendations(agg);
  assert.ok(tips.some((t) => t.includes('Warren Buffett')));
  assert.ok(tips.some((t) => t.includes('10.0×')));
  assert.match(KA.recommendations({})[0], /мало данных/);
});

test('parseAIPost reads JSON and plain answers', () => {
  assert.equal(KA.parseAIPost('{"post":"Buffett keeps it simple."}'), 'Buffett keeps it simple.');
  assert.equal(KA.parseAIPost('Sure! {"post":"Hi"}'), 'Hi');
  assert.equal(KA.parseAIPost('"Plain text"'), 'Plain text');
});

test('xLength and validatePost respect X limits', () => {
  assert.equal(KA.xLength('hello'), 5);
  assert.equal(KA.xLength('привет'), 6);
  assert.equal(KA.xLength('📈'), 2);
  assert.equal(KA.xLength('see https://example.com/very/long/path'), 27);
  assert.deepEqual(KA.validatePost(''), { ok: false, reason: 'empty' });
  assert.deepEqual(KA.validatePost('look https://x.com'), { ok: false, reason: 'contains-link' });
  assert.equal(KA.validatePost('a'.repeat(256)).ok, true);
  assert.equal(KA.validatePost('a'.repeat(257)).ok, false);
  assert.equal(KA.validatePost('a'.repeat(1000), 4000).ok, true);
});

test('buildIntentUrl encodes text and attaches quoted post', () => {
  const url = new URL(KA.buildIntentUrl('Buffett & cash?', 'https://x.com/a/status/1'));
  assert.equal(url.origin + url.pathname, 'https://x.com/intent/post');
  assert.equal(url.searchParams.get('text'), 'Buffett & cash?');
  assert.equal(url.searchParams.get('url'), 'https://x.com/a/status/1');
});

test('canPublish enforces mode, daily cap and active hours', () => {
  const noon = new Date(2026, 9, 1, 12);
  const night = new Date(2026, 9, 1, 3);
  const day = KA.dayKey(noon);
  assert.deepEqual(KA.canPublish({ mode: 'draft' }, {}, noon), { ok: false, reason: 'draft-mode' });
  assert.deepEqual(KA.canPublish({ mode: 'auto', dailyCap: 2 }, { day, sentToday: 2 }, noon), { ok: false, reason: 'daily-cap' });
  assert.deepEqual(KA.canPublish({ mode: 'auto', dailyCap: 2 }, { day: '2000-01-01', sentToday: 9 }, noon), { ok: true });
  assert.deepEqual(KA.canPublish({ mode: 'auto', dailyCap: 5, activeFrom: 9, activeTo: 22 }, {}, night), { ok: false, reason: 'outside-active-hours' });
  assert.deepEqual(KA.canPublish({ mode: 'confirm', dailyCap: 5 }, {}, night), { ok: true });
  assert.equal(KA.inActiveHours({ activeFrom: 22, activeTo: 6 }, night), true);
});

test('buildPostMessages includes persona, language, limit and source', () => {
  const [system, user] = KA.buildPostMessages({ language: 'Russian', maxChars: 280 }, post(), 'Topics: Buffett');
  assert.match(system.content, /Write in Russian/);
  assert.match(system.content, /256 characters/);
  assert.match(system.content, /Topics: Buffett/);
  assert.match(user.content, /@finclips \(100K views\)/);
});

test('helpers: formatNumber, delayMs, searchUrl', () => {
  assert.equal(KA.formatNumber(1500), '1.5K');
  assert.equal(KA.formatNumber(2000000), '2M');
  assert.equal(KA.delayMs(10, 20, 0), 10000);
  assert.equal(KA.delayMs(20, 10, 1), 20000);
  const q = new URL(KA.searchUrl('Tesla, Elon Musk')).searchParams.get('q');
  assert.match(q, /filter:videos/);
  assert.match(q, /Tesla OR "Elon Musk"/);
});
