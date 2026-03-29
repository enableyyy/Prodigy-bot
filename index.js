const http = require('http');

const TG_TOKEN = process.env.TG_TOKEN || '';
const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const PORT = Number(process.env.PORT || 10000);

const DEFAULT_BOOKMAKERS = parseCsv(process.env.BOOKMAKERS || 'SingBet,Pinnacle,1xBet');
const DEFAULT_SPORTS = parseCsv(process.env.SPORTS || '');
const DEFAULT_DROP_PCT = toNumber(process.env.DROP_PCT, 4.5);
const DEFAULT_MIN_BOOKS = Math.max(1, toInt(process.env.MIN_BOOKS_FOR_SIGNAL, 2));
const DEFAULT_SCAN_INTERVAL_SEC = Math.max(15, toInt(process.env.CHECK_INTERVAL_SEC, 60));
const DEFAULT_ALERT_COOLDOWN_MIN = Math.max(1, toInt(process.env.ALERT_COOLDOWN_MIN, 15));
const DEFAULT_EVENT_LIMIT = Math.max(1, toInt(process.env.EVENT_LIMIT, 8));
const DEFAULT_INCLUDE_LIVE = String(process.env.INCLUDE_LIVE || 'true').toLowerCase() === 'true';
const DEFAULT_ADMIN_CHAT_IDS = new Set(parseCsv(process.env.ADMIN_CHAT_IDS || '').map(x => String(x)));

const state = {
  updateOffset: 0,
  subscribers: new Set([...DEFAULT_ADMIN_CHAT_IDS]),
  config: {
    bookmakers: DEFAULT_BOOKMAKERS,
    sports: DEFAULT_SPORTS,
    dropPct: DEFAULT_DROP_PCT,
    minBooksForSignal: DEFAULT_MIN_BOOKS,
    scanIntervalSec: DEFAULT_SCAN_INTERVAL_SEC,
    alertCooldownMin: DEFAULT_ALERT_COOLDOWN_MIN,
    eventLimit: DEFAULT_EVENT_LIMIT,
    includeLive: DEFAULT_INCLUDE_LIVE,
  },
  oddsSnapshot: new Map(),
  alertCooldowns: new Map(),
  sportsCache: [],
  lastScanAt: null,
  lastScanSummary: '',
  isScanning: false,
};

function parseCsv(value) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}
function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function toInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
function nowTs() { return Date.now(); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatDate(input) {
  if (!input) return '-';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return String(input);
  return d.toLocaleString('ru-RU', { timeZone: 'Europe/Amsterdam' });
}
function pctDrop(prev, next) {
  if (!prev || !next || prev <= 0 || next <= 0) return 0;
  return ((prev - next) / prev) * 100;
}
function shortText(text, limit = 3800) {
  const s = String(text || '');
  return s.length <= limit ? s : s.slice(0, limit - 3) + '...';
}
function chunkLines(lines, limit = 3800) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function tgApi(method, params = {}) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) {
    const err = data?.description || `${res.status} ${res.statusText}`;
    throw new Error(`Telegram API ${method} failed: ${err}`);
  }
  return data.result;
}
async function sendMessage(chatId, text) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text: shortText(text),
    disable_web_page_preview: true,
  });
}

async function oddsApi(path, params = {}, includeKey = true) {
  const url = new URL(`https://api.odds-api.io/v3${path}`);
  if (includeKey) url.searchParams.set('apiKey', ODDS_API_KEY);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || String(v).trim() === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Odds API ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}
function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.events)) return data.events;
  if (Array.isArray(data?.sports)) return data.sports;
  if (Array.isArray(data?.bookmakers)) return data.bookmakers;
  return [];
}
function eventTeams(event) {
  const home = event?.home || event?.home_team || event?.team1 || event?.teams?.[0] || event?.participants?.[0]?.name || 'Home';
  const away = event?.away || event?.away_team || event?.team2 || event?.teams?.[1] || event?.participants?.[1]?.name || 'Away';
  return { home, away };
}
function eventStart(event) {
  return event?.date || event?.startTime || event?.startsAt || event?.commence_time || event?.start_date || null;
}

async function listSports() {
  const data = await oddsApi('/sports', {}, true);
  const sports = unwrapList(data).map(item => {
    const slug = item?.slug || item?.key || item?.id || item?.name || '';
    const name = item?.name || item?.title || item?.displayName || slug;
    return { slug: String(slug), name: String(name) };
  });
  state.sportsCache = sports;
  return sports;
}
async function listBookmakers() {
  const data = await oddsApi('/bookmakers', {}, true);
  return unwrapList(data).map(item => {
    if (typeof item === 'string') return { slug: item, name: item };
    return {
      slug: String(item?.slug || item?.key || item?.id || item?.name || ''),
      name: String(item?.name || item?.title || item?.displayName || item?.slug || item?.key || item?.id || ''),
    };
  });
}
function filterEsportsSports(sports) {
  const re = /(esport|counter|strike|cs2|csgo|dota|league|lol|valorant|rainbow|starcraft|overwatch|rocket|call of duty|cod)/i;
  return sports.filter(s => re.test(`${s.slug} ${s.name}`));
}
async function resolveSports() {
  if (state.config.sports.length > 0) return state.config.sports;
  const sports = await listSports();
  const esports = filterEsportsSports(sports).map(s => s.slug);
  return esports.slice(0, 10);
}
async function getEventsForSport(sportSlug) {
  const params = {
    sport: sportSlug,
    limit: state.config.eventLimit,
    bookmaker: state.config.bookmakers[0] || undefined,
  };
  const data = await oddsApi('/events', params, true);
  let events = unwrapList(data);
  if (!state.config.includeLive) {
    events = events.filter(e => {
      const live = Boolean(e?.live || e?.isLive || e?.inplay || e?.inPlay);
      return !live;
    });
  }
  return events;
}
async function getOddsForEvent(eventId) {
  const params = { eventId, bookmakers: state.config.bookmakers.join(',') };
  return oddsApi('/odds', params, true);
}
function normalizeOdds(oddsResponse) {
  const rows = [];
  const bookmakers = oddsResponse?.bookmakers || oddsResponse?.data?.bookmakers || {};
  for (const [bookmakerName, markets] of Object.entries(bookmakers)) {
    const marketList = Array.isArray(markets) ? markets : [];
    for (const market of marketList) {
      const marketName = String(market?.name || market?.market || 'Unknown');
      const marketOdds = Array.isArray(market?.odds) ? market.odds : [];
      for (const odd of marketOdds) {
        const hdp = odd?.hdp ?? odd?.line ?? odd?.points ?? odd?.total ?? '';
        const possibleSides = [
          ['home', odd?.home],
          ['away', odd?.away],
          ['draw', odd?.draw],
          ['over', odd?.over],
          ['under', odd?.under],
          ['yes', odd?.yes],
          ['no', odd?.no],
        ];
        for (const [side, rawValue] of possibleSides) {
          const value = Number(rawValue);
          if (Number.isFinite(value) && value > 1.0001) {
            rows.push({
              bookmaker: bookmakerName,
              marketName,
              side,
              line: hdp === '' ? '' : String(hdp),
              odd: value,
            });
          }
        }
      }
    }
  }
  return rows;
}
function snapshotKey({ sport, eventId, bookmaker, marketName, side, line }) {
  return [sport, eventId, bookmaker, marketName, side, line].join('|');
}
function signalKey({ sport, eventId, marketName, side, line }) {
  return [sport, eventId, marketName, side, line].join('|');
}
function cleanupMemory() {
  const maxSnapshotAgeMs = 1000 * 60 * 60 * 12;
  const maxCooldownAgeMs = 1000 * 60 * 60 * 24;
  const now = nowTs();
  for (const [key, value] of state.oddsSnapshot.entries()) {
    if ((now - value.ts) > maxSnapshotAgeMs) state.oddsSnapshot.delete(key);
  }
  for (const [key, ts] of state.alertCooldowns.entries()) {
    if ((now - ts) > maxCooldownAgeMs) state.alertCooldowns.delete(key);
  }
}
function buildAlertMessage(event, sport, marketName, side, line, details) {
  const { home, away } = eventTeams(event);
  const start = formatDate(eventStart(event));
  const lines = [
    '📉 Прогруз',
    `Игра: ${home} vs ${away}`,
    `Спорт: ${sport}`,
    `Старт: ${start}`,
    `Маркет: ${marketName}`,
    `Сторона: ${side}${line ? ` | линия ${line}` : ''}`,
    `Подтверждено БК: ${details.length}`,
    '',
    ...details.map(item => `— ${item.bookmaker}: ${item.prev.toFixed(2)} → ${item.now.toFixed(2)} (-${item.drop.toFixed(2)}%)`),
  ];
  return lines.join('\n');
}

async function scanOnce() {
  if (state.isScanning) {
    return { alerts: [], summary: 'Скан пропущен: предыдущий ещё идёт.' };
  }
  state.isScanning = true;
  const scanStarted = nowTs();

  try {
    cleanupMemory();
    const sports = await resolveSports();
    if (!sports.length) {
      const msg = 'Не удалось определить esports-спорты. Открой /sports и потом задай /setsports slug1,slug2';
      state.lastScanAt = new Date().toISOString();
      state.lastScanSummary = msg;
      return { alerts: [], summary: msg };
    }

    const allAlerts = [];
    let totalEvents = 0;
    let processedSports = 0;

    for (const sport of sports) {
      let events = [];
      try {
        events = await getEventsForSport(sport);
      } catch (err) {
        allAlerts.push(`⚠️ Не удалось получить события для ${sport}: ${err.message}`);
        continue;
      }
      processedSports += 1;
      totalEvents += events.length;

      for (const event of events) {
        const eventId = event?.id || event?.eventId || event?.key;
        if (!eventId) continue;

        let odds;
        try {
          odds = await getOddsForEvent(eventId);
        } catch (err) {
          allAlerts.push(`⚠️ Не удалось получить коэффициенты для eventId=${eventId}: ${err.message}`);
          continue;
        }

        const rows = normalizeOdds(odds);
        const grouped = new Map();

        for (const row of rows) {
          const snapK = snapshotKey({
            sport,
            eventId,
            bookmaker: row.bookmaker,
            marketName: row.marketName,
            side: row.side,
            line: row.line,
          });

          const prevEntry = state.oddsSnapshot.get(snapK);
          if (prevEntry) {
            const drop = pctDrop(prevEntry.odd, row.odd);
            if (drop >= state.config.dropPct) {
              const sigK = signalKey({
                sport,
                eventId,
                marketName: row.marketName,
                side: row.side,
                line: row.line,
              });
              if (!grouped.has(sigK)) grouped.set(sigK, []);
              grouped.get(sigK).push({
                bookmaker: row.bookmaker,
                prev: prevEntry.odd,
                now: row.odd,
                drop,
              });
            }
          }

          state.oddsSnapshot.set(snapK, { odd: row.odd, ts: nowTs() });
        }

        for (const [sigK, details] of grouped.entries()) {
          if (details.length < state.config.minBooksForSignal) continue;
          const lastAlertTs = state.alertCooldowns.get(sigK) || 0;
          const cooldownMs = state.config.alertCooldownMin * 60 * 1000;
          if ((nowTs() - lastAlertTs) < cooldownMs) continue;

          const parts = sigK.split('|');
          const sportSlug = parts[0];
          const marketName = parts[2];
          const side = parts[3];
          const line = parts[4];

          const message = buildAlertMessage(event, sportSlug, marketName, side, line, details);
          allAlerts.push(message);
          state.alertCooldowns.set(sigK, nowTs());
        }
      }
    }

    const durationSec = ((nowTs() - scanStarted) / 1000).toFixed(1);
    const summary = `Готово. Спортов: ${processedSports}, матчей: ${totalEvents}, сигналов: ${allAlerts.filter(x => x.startsWith('📉')).length}, время: ${durationSec}s`;
    state.lastScanAt = new Date().toISOString();
    state.lastScanSummary = summary;
    return { alerts: allAlerts, summary };
  } finally {
    state.isScanning = false;
  }
}

function helpText() {
  return [
    'Команды:',
    '/start — включить уведомления для этого чата',
    '/help — показать команды',
    '/status — показать текущие настройки',
    '/sports — показать esports-спорты и их slug',
    '/bookmakers — показать букмекеров',
    '/setsports slug1,slug2 — выбрать спорты',
    '/setbooks book1,book2,... — выбрать букмекеров',
    '/setdrop 4.5 — порог падения коэффициента в %',
    '/setminbooks 2 — минимум БК для сигнала',
    '/setinterval 60 — интервал проверки в секундах',
    '/scan — ручной скан прямо сейчас',
    '/ping — проверка, жив ли бот',
    '',
    'Пример:',
    '/setsports counter-strike-2,dota-2,league-of-legends',
    '/setbooks SingBet,Pinnacle,1xBet',
    '/setdrop 5',
  ].join('\n');
}

async function handleCommand(chatId, text) {
  const raw = String(text || '').trim();
  const [commandPart, ...restParts] = raw.split(' ');
  const command = commandPart.split('@')[0].toLowerCase();
  const argText = restParts.join(' ').trim();

  if (command === '/start') {
    state.subscribers.add(String(chatId));
    await sendMessage(chatId, 'Уведомления включены.\n\n' + helpText());
    return;
  }
  if (command === '/help') {
    await sendMessage(chatId, helpText());
    return;
  }
  if (command === '/ping') {
    await sendMessage(chatId, 'Бот работает.');
    return;
  }
  if (command === '/status') {
    const lines = [
      'Текущие настройки:',
      `BOOKMAKERS=${state.config.bookmakers.join(',') || '-'}`,
      `SPORTS=${state.config.sports.join(',') || '(автоопределение esports)'}`,
      `DROP_PCT=${state.config.dropPct}`,
      `MIN_BOOKS_FOR_SIGNAL=${state.config.minBooksForSignal}`,
      `CHECK_INTERVAL_SEC=${state.config.scanIntervalSec}`,
      `ALERT_COOLDOWN_MIN=${state.config.alertCooldownMin}`,
      `EVENT_LIMIT=${state.config.eventLimit}`,
      `INCLUDE_LIVE=${state.config.includeLive}`,
      `Подписчиков=${state.subscribers.size}`,
      `Последний скан=${state.lastScanAt ? formatDate(state.lastScanAt) : '-'}`,
      `Итог последнего скана=${state.lastScanSummary || '-'}`,
    ];
    await sendMessage(chatId, lines.join('\n'));
    return;
  }
  if (command === '/sports') {
    const sports = await listSports();
    const esports = filterEsportsSports(sports);
    if (!esports.length) {
      await sendMessage(chatId, 'Не удалось найти esports-спорты через /sports.');
      return;
    }
    const lines = ['Найденные esports-спорты (используй slug в /setsports):'];
    for (const item of esports.slice(0, 60)) lines.push(`${item.slug} — ${item.name}`);
    for (const chunk of chunkLines(lines, 3800)) await sendMessage(chatId, chunk);
    return;
  }
  if (command === '/bookmakers') {
    const books = await listBookmakers();
    if (!books.length) {
      await sendMessage(chatId, 'Не удалось получить список букмекеров.');
      return;
    }
    const preferredRe = /(singbet|pinnacle|1xbet|bet365|betfair|stake|ggbet|parimatch|xbet)/i;
    const preferred = books.filter(b => preferredRe.test(`${b.slug} ${b.name}`));
    const lines = ['Букмекеры (копируй имя из первой колонки в /setbooks):'];
    for (const item of (preferred.length ? preferred : books).slice(0, 40)) lines.push(`${item.slug} — ${item.name}`);
    for (const chunk of chunkLines(lines, 3800)) await sendMessage(chatId, chunk);
    return;
  }
  if (command === '/setsports') {
    const sports = parseCsv(argText);
    if (!sports.length) {
      await sendMessage(chatId, 'Формат: /setsports slug1,slug2,slug3');
      return;
    }
    state.config.sports = sports;
    await sendMessage(chatId, `Готово.\nSPORTS=${sports.join(',')}`);
    return;
  }
  if (command === '/setbooks') {
    const books = parseCsv(argText);
    if (!books.length) {
      await sendMessage(chatId, 'Формат: /setbooks SingBet,Pinnacle,1xBet');
      return;
    }
    state.config.bookmakers = books;
    await sendMessage(chatId, `Готово.\nBOOKMAKERS=${books.join(',')}`);
    return;
  }
  if (command === '/setdrop') {
    const value = Number(argText);
    if (!Number.isFinite(value) || value <= 0) {
      await sendMessage(chatId, 'Формат: /setdrop 4.5');
      return;
    }
    state.config.dropPct = value;
    await sendMessage(chatId, `Готово.\nDROP_PCT=${value}`);
    return;
  }
  if (command === '/setminbooks') {
    const value = parseInt(argText, 10);
    if (!Number.isFinite(value) || value < 1) {
      await sendMessage(chatId, 'Формат: /setminbooks 2');
      return;
    }
    state.config.minBooksForSignal = value;
    await sendMessage(chatId, `Готово.\nMIN_BOOKS_FOR_SIGNAL=${value}`);
    return;
  }
  if (command === '/setinterval') {
    const value = parseInt(argText, 10);
    if (!Number.isFinite(value) || value < 15) {
      await sendMessage(chatId, 'Формат: /setinterval 60 (минимум 15)');
      return;
    }
    state.config.scanIntervalSec = value;
    await sendMessage(chatId, `Готово.\nCHECK_INTERVAL_SEC=${value}`);
    return;
  }
  if (command === '/scan') {
    await sendMessage(chatId, 'Запускаю скан...');
    const result = await scanOnce();
    await sendMessage(chatId, result.summary);
    const onlySignals = result.alerts.filter(x => x.startsWith('📉'));
    if (!onlySignals.length) {
      const nonSignalErrors = result.alerts.filter(x => x.startsWith('⚠️'));
      if (nonSignalErrors.length) {
        for (const msg of nonSignalErrors.slice(0, 5)) await sendMessage(chatId, msg);
      } else {
        await sendMessage(chatId, 'Сильных прогрузов по текущим настройкам не найдено.');
      }
      return;
    }
    for (const msg of onlySignals.slice(0, 10)) await sendMessage(chatId, msg);
    return;
  }
  await sendMessage(chatId, 'Неизвестная команда.\n\n' + helpText());
}

async function handleTelegramUpdate(update) {
  const message = update?.message || update?.edited_message;
  if (!message?.chat?.id) return;
  const chatId = message.chat.id;
  const text = message.text || '';
  if (!text.startsWith('/')) return;
  try {
    await handleCommand(chatId, text);
  } catch (err) {
    console.error('handleCommand error:', err);
    try { await sendMessage(chatId, `Ошибка: ${err.message}`); } catch (sendErr) { console.error('send error:', sendErr); }
  }
}

async function telegramPollingLoop() {
  while (true) {
    try {
      const updates = await tgApi('getUpdates', {
        timeout: 30,
        offset: state.updateOffset,
        allowed_updates: ['message', 'edited_message'],
      });
      for (const update of updates) {
        state.updateOffset = Math.max(state.updateOffset, update.update_id + 1);
        await handleTelegramUpdate(update);
      }
    } catch (err) {
      console.error('Polling error:', err.message);
      await sleep(3000);
    }
  }
}
async function backgroundScanLoop() {
  while (true) {
    try {
      if (state.subscribers.size > 0) {
        const result = await scanOnce();
        const onlySignals = result.alerts.filter(x => x.startsWith('📉'));
        for (const msg of onlySignals.slice(0, 20)) {
          for (const chatId of state.subscribers) {
            try {
              await sendMessage(chatId, msg);
              await sleep(150);
            } catch (err) {
              console.error(`Failed sending alert to ${chatId}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      console.error('Background scan error:', err.message);
    }
    await sleep(state.config.scanIntervalSec * 1000);
  }
}
function bootSummary() {
  return [
    'Bot booted',
    `PORT=${PORT}`,
    `BOOKMAKERS=${state.config.bookmakers.join(',') || '-'}`,
    `SPORTS=${state.config.sports.join(',') || '(auto)'}`,
    `DROP_PCT=${state.config.dropPct}`,
    `MIN_BOOKS_FOR_SIGNAL=${state.config.minBooksForSignal}`,
    `CHECK_INTERVAL_SEC=${state.config.scanIntervalSec}`,
    `ALERT_COOLDOWN_MIN=${state.config.alertCooldownMin}`,
    `EVENT_LIMIT=${state.config.eventLimit}`,
  ].join(' | ');
}

http.createServer((req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({
      ok: true,
      scanning: state.isScanning,
      subscribers: state.subscribers.size,
      config: state.config,
      lastScanAt: state.lastScanAt,
      lastScanSummary: state.lastScanSummary,
    }, null, 2);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('esports tg bot is running');
}).listen(PORT, '0.0.0.0', () => {
  console.log(bootSummary());
});

telegramPollingLoop().catch(err => console.error('telegramPollingLoop fatal:', err));
backgroundScanLoop().catch(err => console.error('backgroundScanLoop fatal:', err));
