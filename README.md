# Esports line move Telegram bot

Телеграм-бот для отслеживания прогрузов по киберспорту через Odds-API.io.

## Что умеет

- шлёт сигналы о падении коэффициента
- сравнивает несколько букмекеров сразу
- умеет искать esports-спорты через `/sports`
- умеет показывать список букмекеров через `/bookmakers`
- настройки меняются прямо из Telegram-команд

## Переменные окружения

- `TG_TOKEN`
- `ODDS_API_KEY`
- `BOOKMAKERS`
- `SPORTS`
- `DROP_PCT`
- `MIN_BOOKS_FOR_SIGNAL`
- `CHECK_INTERVAL_SEC`
- `ALERT_COOLDOWN_MIN`
- `EVENT_LIMIT`
- `INCLUDE_LIVE`
- `ADMIN_CHAT_IDS`
