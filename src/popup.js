(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MODE_LABEL = { draft: 'Черновик', confirm: 'Подтверждение', auto: 'Авто' };

  chrome.storage.local.get({ config: {}, posts: {}, state: {}, autopilot: false, emergencyStop: false }, (s) => {
    const c = { ...KA.DEFAULTS, ...(s.config || {}) };
    const sent = s.state?.day === KA.dayKey() ? s.state.sentToday || 0 : 0;
    $('p-posts').textContent = KA.formatNumber(Object.keys(s.posts || {}).length);
    $('p-sent').textContent = `${sent}/${c.dailyCap}`;
    $('p-mode').textContent = s.emergencyStop ? 'Остановлено' : MODE_LABEL[c.mode] || c.mode;
    $('p-auto').textContent = s.autopilot ? 'Включён' : 'Выключен';
    $('p-find').onclick = () => chrome.tabs.create({ url: KA.searchUrl(c.extraKeywords) });
  });

  $('p-dashboard').onclick = () => chrome.runtime.openOptionsPage();
  $('p-stop').onclick = () => chrome.runtime.sendMessage({ type: 'EMERGENCY_STOP' }, () => { $('p-mode').textContent = 'Остановлено'; $('p-auto').textContent = 'Выключен'; });
})();
