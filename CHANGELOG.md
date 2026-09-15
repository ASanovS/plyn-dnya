## v2.1.1 — Іконки S.P.E.C.I.A.L.
- Сім оригінальних жетонів характеристик + емблема блоку (`public/special/`).
- Радар показує іконки на вершинах; під радаром — сітка S/P/E/C/I/A/L з назвою і значенням.
- Service Worker: кеш `v3`, прекеш іконок.


## v2.1.0 — Безпека за ТЗ (Компонент 1)

### Що додано / змінено згідно з оновленим ТЗ
- **Helmet** — захисні HTTP-заголовки (XSS, clickjacking, MIME-sniffing).
- **Централізований error-middleware** — єдиний формат `{ error, errorType }` для всіх необроблених помилок.
- **Глобальний rate-limit** — 200 req/хв на IP.
- **Rate-limit на checkout** — 10 / годину на користувача.
- **`/api/health`** — health-check для моніторингу хостингу.
- Покращено `requireAuth`: логування невдалих JWT + `errorType: 'auth_error'`.
- Усі API-відповіді з помилками тепер повертають `errorType` (validation_error, auth_error, rate_limited, not_found, premium_required, server_error тощо).
- `.env.example` додано.
- Структура проєкту: `public/` для фронтенду, `sql/` для міграцій.

### Критерії приймання ТЗ (виконано)
- ✅ Magic Link через `/api/auth/request-link` з rate-limit 5/15хв
- ✅ JWT-валідація через `supabaseAdmin.auth.getUser()`
- ✅ RLS на всіх таблицях + заборона UPDATE на profiles для клієнта
- ✅ Helmet + CORS whitelist
- ✅ Централізований error-middleware
- ✅ Ідемпотентність вебхуків Stripe
- ✅ SERVICE_ROLE_KEY лише на сервері

---

## v2 — Реальна підписка
Stripe Checkout (₴/$/€), бекенд на Express, файлова база `users.json`.

## v3 — Продакшн-архітектура (Supabase)
- Supabase Postgres + Auth (magic link) замість файлів/localStorage.
- RLS на всіх таблицях; `profiles` — тільки читання для клієнта (запис лише через `supabaseAdmin` у вебхуках).
- Ідемпотентність вебхуків Stripe (`stripe_events`), Customer Portal, `invoice.payment_failed` → `past_due`.
- Rate limiting на magic link (`express-rate-limit`).
- UA/EN i18n, адаптивна верстка (бічне меню >1300px, сітка завдань >900px).
- Оптимістичний UI для всіх дій над завданнями.

## v4 (migration_004) — Гейміфікація + Clash Detection
- `start_time`/`end_time` (опціональні) + тригер `check_task_time_overlap()` — блокує перетин часу, код помилки `23P01`.
- S.P.E.C.I.A.L.: 7 характеристик + `level`/`xp` на `profiles`.
- `complete_task_and_award_xp()` — SECURITY DEFINER RPC, єдиний спосіб змінити XP/рівень.
- Серії (`current_streak`, `xp_multiplier`) через `pg_cron`.

## PWA-шар
- `sw.js` + `idb-queue.js`: офлайн-черга мутацій до Supabase, синтетична 200-відповідь при офлайні (щоб оптимістичний UI не відкочувався), Background Sync + ручний фолбек для Safari/iOS.

## Аудіостимуляція
- Бінауральний ритм 432/447 Гц (15 Гц біт) через Web Audio API, anti-click фікси (`cancelScheduledValues`, `.stop()` на аудіо-таймлайні).

## migration_005 — LLM-звіти + теми
- `GET /api/reports/weekly` — Premium-only, кеш на добу (`llm_reports`), Anthropic або OpenAI-сумісний провайдер.
- Теми: Класична / Техно-магія (глітч, `prefers-reduced-motion`) / Стімпанк (синтезований механічний клац).

## migration_006 + доопрацювання дат/помилок/UI
- **Локальна дата замість UTC**: `todayKey()` на фронтенді тепер рахує через `getFullYear()/getMonth()/getDate()`.
- Сервер (`/api/reports/weekly`) приймає локальну дату від клієнта (`?today=YYYY-MM-DD`).
- `migration_006_timezone_fix.sql`: `rollover_daily_streaks()` використовує `(now() at time zone 'Europe/Kyiv')::date`.
- Типізовані помилки LLM (`rate_limited`/`auth_error`/`unavailable`/`provider_error`).

## migration_007 — Бета-доступ
- `profiles.beta_premium_until` — тимчасовий Преміум для бета-тестерів, незалежний від Stripe.
- **Реальний ліміт 3 завдання/день тепер на рівні БД** (тригер `enforce_free_task_limit`), а не тільки в JS — раніше будь-хто міг обійти клієнтський ліміт напряму через Supabase REST API з консолі браузера, оскільки завдання пишуться client→Supabase, минаючи Express.
- Тригер коректно відрізняє "нове завдання" від "апдейт через upsert" (позначити done, редагувати) — інакше вже наявні завдання застрягли б, як тільки вичерпано ліміт.
- Бейдж "Преміум (бета)" на фронтенді — окремо від реальної Stripe-підписки, кнопка Customer Portal для нього не показується (немає реального stripe_customer_id, який можна відкрити).

## migration_008 — Явний вибір характеристики S.P.E.C.I.A.L.
- `tasks.target_stat` (nullable) — явний оверрайд характеристики для конкретного завдання, пріоритетний над дефолтним мапінгом категорії. Вирішує кейс "бокс → Сприйняття замість Сили": тепер можна вручну вказати Strength для конкретного завдання незалежно від категорії.
- Дві нові категорії: `agility` (Спритність/реакція → Agility), `habit` (Звичка → Luck). `health` навмисно лишився на Endurance — для кейсів типу "бокс" призначений саме `target_stat`, а не ще одна категорія з неоднозначним дефолтом.
- `complete_task_and_award_xp()` оновлено: спершу перевіряє `target_stat`, і лише якщо він NULL — падає на мапінг за категорією (як і раніше).
- Виправлено реальний баг: `upsertTask()` ніколи не перевіряв `error` від Supabase — блок від DB-тригера (ліміт завдань, конфлікт часу) тихо ігнорувався, завдання зникало без пояснення при наступному синку. Тепер помилка прокидається, і UI показує конкретний тост.
