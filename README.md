# 🏠 Cost-Rental Watcher

> Телеграм-бот, который следит за тремя ирландскими сайтами cost-rental и присылает
> уведомление, как только открывается приём заявок на жильё с нужным числом спален
> (по умолчанию **2–3 комнаты**).

![Node](https://img.shields.io/badge/node-%E2%89%A520.6-339933?logo=node.js&logoColor=white)
![Tests](https://img.shields.io/badge/tests-46%20passing-brightgreen)
![Deploy](https://img.shields.io/badge/deploy-standalone%20%7C%20Vercel-black)
![License](https://img.shields.io/badge/license-MIT-blue)

Отслеживаемые сайты: **LDA** · **Tuath Housing** · **Respond**.

## Содержание
- [Как это работает](#как-это-работает)
- [Залить в свой репозиторий](#-залить-в-свой-репозиторий)
- [Вариант A — Vercel (Cron + Supabase)](#-вариант-a--vercel-cron--supabase)
- [Вариант B — Standalone (всегда включён)](#-вариант-b--standalone-всегда-включён)
- [Watchdog и heartbeat](#watchdog-и-heartbeat)
- [Настройки](#настройки)
- [Тесты и структура](#тесты)

## Как это работает

У этих организаций нет «живого» каталога свободных квартир. Это *cost rental* — жильё
раздаётся через **лотерею**: периодически открывается окно подачи заявок на конкретный ЖК
(обычно ~7 дней), потом закрывается. Бот ловит момент, когда схема с подходящими спальнями
переходит в статус «открыто», и сразу шлёт в Telegram ссылку. Уведомление приходит
**один раз** на каждое открытие; если схему закроют и снова откроют — придёт новое.

Сигнал статуса у каждого сайта свой: LDA — метка `APPLICATIONS NOW CLOSED`; Tuath —
`Apply now!` / `CLOSED`; Respond — секция `Current Listings` (выше `Closed Listings`).

Один и тот же движок (`lib/core.mjs`) работает в двух режимах:
- **Vercel** — serverless `/api/check` по расписанию, состояние в **Supabase**.
- **Standalone** — постоянный процесс (VPS / Raspberry Pi), состояние в `state.json`.

---

## 📦 Залить в свой репозиторий

Чтобы переиспользовать **существующий неиспользуемый** репозиторий и полностью заменить его
содержимым бота (чистая история, одним коммитом):

```bash
cd cost-rental-bot
git init
git add .
git commit -m "Cost-rental watcher"
git branch -M main
git remote add origin https://github.com/<логин>/<репозиторий>.git
git push --force --set-upstream origin main   # перезатирает старый проект
```

> `--force` затрёт старое содержимое ветки `main` — именно то, что нужно для «очистить и залить».
> Если хочешь сохранить старую историю — вместо этого склонируй репо, `git rm -rf .`, скопируй
> файлы бота, закоммить и запушь обычным `git push`.

`.env`, `node_modules`, `state.json` уже в `.gitignore` — секреты не утекут (в репозиторий
попадает только `.env.example` с плейсхолдерами).

> ⚠️ Бесплатный Vercel Hobby **нельзя** подключать к репозиториям, принадлежащим GitHub-**организации**.
> Держи репозиторий под личным аккаунтом.

---

## ☁️ Вариант A — Vercel (Cron + Supabase)

### Частота проверок — важно
На **Hobby (бесплатно)** cron запускается максимум **раз в сутки** (±час). Для жилья мало.
Три пути:

1. **Vercel Pro** ($20/мес) — нативный cron хоть каждые 15 минут (`*/15 * * * *` в `vercel.json`).
2. **Hobby + внешний планировщик (бесплатно)** — оставь endpoint на Vercel, дёргай его каждые
   15 мин через **cron-job.org**: URL `https://<проект>.vercel.app/api/check?key=<CRON_SECRET>`.
   Блок `crons` из `vercel.json` тогда можно удалить.
3. **GitHub Actions** по расписанию вместо Vercel-cron (см. примечание ниже).

### Шаги
1. **Supabase** → SQL editor → выполни `supabase.sql` (создаёт таблицы `cost_rental_schemes`
   и `watcher_meta`).
2. **Vercel** → Add New… → Project → импортируй репозиторий. Framework preset: **Other**.
3. **Environment Variables** в настройках проекта:

   | Переменная | Значение |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
   | `TELEGRAM_CHAT_ID` | твой chat_id |
   | `SUPABASE_URL` | `https://….supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | service-role ключ (Project Settings → API) |
   | `CRON_SECRET` | длинная случайная строка (16+ символов) |

4. **Deploy** и проверь вручную:
   `https://<проект>.vercel.app/api/check?key=<CRON_SECRET>` — вернёт JSON-сводку и пришлёт
   уведомления, если что-то открыто.

> `SUPABASE_SERVICE_ROLE_KEY` — серверный ключ, обходит RLS; используется только на сервере.

---

## 🖥️ Вариант B — Standalone (всегда включён)

Нужен **Node.js 20.6+**.

```bash
npm install
cp .env.example .env       # впиши TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID
npm start
```

Узнать chat_id: напиши боту любое сообщение, затем `npm run chatid`.

24/7 через pm2:
```bash
npm i -g pm2
pm2 start cost-rental-bot.mjs --name rental --node-args="--env-file=.env"
pm2 save && pm2 startup
```

---

## Watchdog и heartbeat

Чтобы бот не «умер тихо»:

- **Watchdog** — если сайт недоступен или распарсилось 0 схем (например, поменяли вёрстку),
  после `WATCHDOG_AFTER` неудачных проверок подряд приходит предупреждение в Telegram (один раз
  на сбой). Когда сайт снова отвечает — приходит «восстановлено».
- **Heartbeat** — не чаще раза в `HEARTBEAT_HOURS` часов приходит короткое «бот жив, проверка
  выполнена, открытого нет/есть то-то». Поставь `HEARTBEAT_HOURS=0`, чтобы отключить.

---

## Настройки

`.env` (standalone) или Environment Variables (Vercel):

| Переменная | По умолчанию | Что делает |
|---|---|---|
| `WANT_BEDROOMS` | `2,3` | какие спальни отслеживать (`0` = студия) |
| `NOTIFY_ON_UNKNOWN` | `true` | слать, даже если число спален не определилось |
| `WATCHDOG_AFTER` | `3` | предупредить после N неудачных проверок подряд (`0` = выкл.) |
| `HEARTBEAT_HOURS` | `24` | «бот жив» не чаще раза в N часов (`0` = выкл.) |
| `POLL_INTERVAL_MIN` | `15` | интервал проверки (только standalone) |
| `SEND_STARTUP` | `true` | пинг при старте (только standalone) |
| `STATE_FILE` | `./state.json` | файл состояния (только standalone) |

---

## Тесты

```bash
npm test
```
- `test.mjs` — разбор страниц (открыто/закрыто, спальни) на фикстурах со структурой реальных сайтов.
- `core-test.mjs` — поведение движка: алерты, дедуп, перевзвод, спальни с детальной страницы,
  watchdog (алерт + восстановление), heartbeat (троттлинг).
- `filestore-test.mjs` — round-trip файлового хранилища.

CI (`.github/workflows/ci.yml`) гоняет тесты на Node 20 и 22 при каждом push/PR.

## Структура

```
parser.mjs            — разбор листингов + правила статуса по сайтам
lib/core.mjs          — единый цикл (scrape → match → dedupe → watchdog → heartbeat)
lib/telegram.mjs      — отправка в Telegram
lib/filestore.mjs     — JSON-хранилище для standalone
cost-rental-bot.mjs   — standalone-рантайм (цикл + state.json)
api/check.js          — Vercel-функция (состояние в Supabase)
vercel.json           — расписание cron
supabase.sql          — таблицы состояния
```

## Если сайт перестроят

Сайты на WordPress — вёрстку могут менять. Парсер устойчив (опирается на ссылки/заголовки/текст,
не на CSS-классы), но при сильных изменениях watchdog пришлёт предупреждение, а в логах/JSON
будет `0 schemes parsed`. Чинить — в `parser.mjs` (`extractEntries` и блок `SITES`).

## License

MIT
