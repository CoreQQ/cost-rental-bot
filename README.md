# Cost-Rental Watcher 🏠

Телеграм-бот: следит за тремя сайтами и присылает уведомление, как только открывается
**приём заявок** на жильё с нужным числом спален (по умолчанию **2–3 комнаты**):

- **LDA** — lda.ie/affordable-homes/lda-cost-rental
- **Tuath Housing** — tuathhousing.ie/cost-rental
- **Respond** — respond.ie/cost-rental

Работает в двух режимах из одного репозитория:
- **Standalone** — постоянный процесс (VPS / Raspberry Pi / pm2), состояние в `state.json`.
- **Vercel** — serverless `/api/check` по расписанию (Cron), состояние в **Supabase**.

## Как это работает

У этих организаций нет «живого» каталога свободных квартир. Это *cost rental* — жильё
раздаётся через **лотерею**: периодически открывается окно подачи заявок на конкретный ЖК
(обычно ~7 дней), потом закрывается. Бот ловит момент, когда схема с 2–3 спальнями переходит
в статус «открыто», и сразу шлёт в Telegram ссылку. Уведомление приходит **один раз** на
каждое открытие. Закрыли и снова открыли — придёт новое.

Сигнал статуса у каждого сайта свой: LDA — метка `APPLICATIONS NOW CLOSED`; Tuath —
`Apply now!` / `CLOSED`; Respond — секция `Current Listings` (выше `Closed Listings`).

---

## 📦 Залить на GitHub

```bash
cd cost-rental-bot
git init
git add .
git commit -m "Cost-rental watcher: standalone + Vercel"
```

Дальше любой из вариантов:

**A. Через GitHub CLI (быстрее):**
```bash
gh repo create cost-rental-bot --private --source . --push
```

**B. Вручную:** создай пустой репозиторий на github.com (без README), затем:
```bash
git remote add origin https://github.com/<твой-логин>/cost-rental-bot.git
git branch -M main
git push -u origin main
```

`.env` и `node_modules` уже в `.gitignore` — секреты не утекут. В репозиторий попадает только
`.env.example` с плейсхолдерами.

> ⚠️ На бесплатном Vercel Hobby нельзя подключать репозитории, принадлежащие GitHub-**организации**
> — держи репозиторий под личным аккаунтом.

---

## ☁️ Режим 1 — Vercel (Cron + Supabase)

### Важно про частоту проверок
На **Hobby (бесплатно)** cron запускается **максимум раз в сутки** (и то ±час). Для жилья
этого мало. Три варианта:

1. **Vercel Pro** ($20/мес) — cron хоть каждые 15 минут. В `vercel.json` поставь `*/15 * * * *`.
2. **Hobby + внешний планировщик (бесплатно)** — оставь endpoint на Vercel, а дёргай его
   каждые 15 мин бесплатным **cron-job.org** (URL `https://<проект>.vercel.app/api/check?key=<CRON_SECRET>`).
   В этом случае блок `crons` из `vercel.json` можно удалить.
3. **GitHub Actions** вместо Vercel-cron — гоняет тот же endpoint по расписанию.

### Шаги
1. **Supabase:** в SQL-редакторе выполни `supabase.sql` (создаёт таблицу `cost_rental_schemes`).
2. **Импортируй репозиторий в Vercel** (Add New… → Project). Framework preset: **Other**.
3. **Environment Variables** в настройках проекта Vercel:

   | Переменная | Значение |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
   | `TELEGRAM_CHAT_ID` | твой chat_id |
   | `SUPABASE_URL` | `https://….supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | service-role ключ (Project Settings → API) |
   | `CRON_SECRET` | длинная случайная строка (16+ символов) |
   | `WANT_BEDROOMS` | `2,3` (опционально) |

4. **Deploy.** Проверить вручную:
   `https://<проект>.vercel.app/api/check?key=<CRON_SECRET>` — вернёт JSON-сводку и пришлёт
   уведомления, если что-то открыто.

> `SUPABASE_SERVICE_ROLE_KEY` — серверный ключ, он обходит RLS. Используется только внутри
> функции на сервере, клиенту не отдаётся.

---

## 🖥️ Режим 2 — Standalone (всегда включён)

Нужен **Node.js 20.6+**.

```bash
npm install
cp .env.example .env       # впиши TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
npm start
```

Узнать chat_id: напиши боту любое сообщение, затем `npm run chatid`.

Для 24/7 — pm2:
```bash
npm i -g pm2
pm2 start cost-rental-bot.mjs --name rental --node-args="--env-file=.env"
pm2 save && pm2 startup
```

---

## Настройки (`.env` / Vercel env)

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `WANT_BEDROOMS` | `2,3` | какие спальни отслеживать (`0` = студия) |
| `NOTIFY_ON_UNKNOWN` | `true` | слать, даже если число спален не определилось |
| `POLL_INTERVAL_MIN` | `15` | интервал проверки (только standalone) |
| `SEND_STARTUP` | `true` | пинг «бот запущен» при старте (только standalone) |
| `STATE_FILE` | `./state.json` | файл состояния (только standalone) |

---

## Тесты

```bash
npm test
```
- `test.mjs` — разбор страниц (открыто/закрыто, спальни) на фикстурах со структурой реальных сайтов (19).
- `smoke.mjs` — сквозной прогон standalone с мок-сетью: алерты, дедуп, перевзвод (12).
- `vercel-test.mjs` — то же для Vercel-цикла `runCheck` с in-memory store (9).

## Структура

```
parser.mjs            — разбор листингов + правила статуса по сайтам (общий код)
cost-rental-bot.mjs   — standalone-рантайм (цикл + Telegram + state.json)
api/check.js          — Vercel-функция (один цикл, состояние в Supabase)
vercel.json           — расписание cron
supabase.sql          — таблица состояния
```

## Если сайт перестроят

Сайты на WordPress — вёрстку могут менять. Парсер устойчив (опирается на ссылки/заголовки/текст,
не на CSS-классы), но при сильных изменениях в логах/JSON появится `0 parsed — layout changed?`.
Чинить — в `parser.mjs` (`extractEntries` и блок `SITES`).
