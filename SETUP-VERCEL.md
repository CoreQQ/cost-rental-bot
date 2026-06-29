# Запуск бота на Vercel (мгновенные команды через webhook)

Бот переносится с GitHub Actions на Vercel:
- **Команды (`/all`)** — мгновенно, через Telegram webhook (`/api/telegram`).
- **Проверка новых открытий + алерты** — `/api/scan` (Vercel Cron раз в сутки; для каждые 15 мин — внешний пинговщик).
- **Состояние** — Upstash Redis (бесплатно), чтобы не было циклов деплоя.

## Готовые секреты (уже сгенерированы)
- `CRON_SECRET`     = `de65f0f7d58b697bb412537b670039fea504`
- `WEBHOOK_SECRET`  = `96d4f7cf6a0b6f5ec3480a91859c5d9e3c16`
- `TELEGRAM_CHAT_ID` = `-1004438936269`  (реальный ID группы, бот его выучил)

---

## 1. Деплой на Vercel
1. vercel.com → войти через GitHub.
2. **Add New → Project** → импортировать репозиторий `CoreQQ/cost-rental-bot`.
3. Framework Preset оставить **Other**, настройки сборки не трогать → **Deploy**.
   (Первый деплой пройдёт, но бот ещё не настроен — это нормально.)

## 2. Хранилище (Upstash Redis)
4. В проекте → вкладка **Storage** → **Create Database** → **Upstash → Redis**.
5. Регион — поближе к Ирландии (eu-west). Создать и **Connect** к проекту.
   Это само добавит переменные `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN`.

## 3. Переменные окружения
6. Project → **Settings → Environment Variables** — добавить:
   - `TELEGRAM_BOT_TOKEN` = новый токен от BotFather (сначала **перевыпустить**!)
   - `TELEGRAM_CHAT_ID`   = `-1004438936269`
   - `CRON_SECRET`        = `de65f0f7d58b697bb412537b670039fea504`
   - `WEBHOOK_SECRET`     = `96d4f7cf6a0b6f5ec3480a91859c5d9e3c16`
   - (необязательно) `ADMIN_USER_ID` = твой Telegram ID — тогда `/all` в личке доступен только тебе
   - (необязательно) `WANT_BEDROOMS` = `2,3`, `LIST_PAGES` = `2`

## 4. Передеплой
7. **Deployments** → на последнем `⋯` → **Redeploy** (чтобы подхватились переменные и Upstash).

## 5. Привязать webhook (один раз)
8. Открыть в браузере (заменив адрес на свой):
   `https://<твой-проект>.vercel.app/api/setup?key=de65f0f7d58b697bb412537b670039fea504`
   Ответ `{"ok":true,...}` = webhook привязан. Теперь Telegram шлёт сообщения боту напрямую.

## 6. Проверка
9. В группе напиши **`/all`** — список должен прийти **мгновенно**.

## 7. Частая проверка открытий (по желанию)
- Из коробки: Vercel Cron дёргает `/api/scan` **раз в сутки** (лимит бесплатного плана).
- Для **каждые 15 минут**: бесплатный job на **cron-job.org**:
  - URL: `https://<твой-проект>.vercel.app/api/scan?key=de65f0f7d58b697bb412537b670039fea504`
  - Метод: GET, интервал: 15 минут.

## 8. Выключить старый бот на GitHub
10. GitHub → репозиторий → **Actions** → workflow **watch** → `⋯` → **Disable workflow**.
    Расписание уже убрано; это останавливает ручные запуски. После этого **удали утёкший PAT**.

---

### Эндпоинты
- `POST /api/telegram` — webhook (Telegram). Защищён `WEBHOOK_SECRET`.
- `GET  /api/scan`     — одна проверка. Защищён `CRON_SECRET` (заголовок `Authorization: Bearer …` от Vercel Cron, либо `?key=…`).
- `GET  /api/setup?key=…` — разовая привязка webhook к текущему деплою.
