# Плин дня — продакшн-бекенд (Supabase + Stripe)

**Версія 2.1.0** — додано повну відповідність ТЗ «Компонент 1: Бекенд-інфраструктура, автентифікація та управління доступом»:
- Helmet (захисні HTTP-заголовки)
- Централізований error-middleware з єдиним форматом `{ error, errorType }`
- Глобальний + точковий rate-limiting
- `/api/health` для моніторингу
- Покращене логування невдалих JWT і Magic Link

Версія 2: файлова база (`users.json`) та `localStorage` замінені на Supabase
(PostgreSQL + Auth). Дані переживають перезапуск хостингу, завдання
синхронізуються між пристроями, доступ до чужих даних неможливий завдяки
Row Level Security та перевірці JWT на кожному захищеному маршруті.

## Що змінилось порівняно з прототипом
- **База даних**: `users.json` → таблиці `profiles`, `tasks`, `day_settings`, `templates` у Supabase.
- **Авторизація**: email + magic link через Supabase Auth. Жодних паролів для зберігання.
- **Безпека API**: `/api/status` видалено — статус підписки читається напряму з `profiles` через RLS (користувач бачить лише свій рядок). `/api/create-checkout-session` і `/api/cancel-subscription` вимагають дійсний JWT-токен, підмінити чужий email більше не можна.
- **XSS**: усі назви завдань/шаблонів проходять через `esc()` перед вставкою в HTML.
- **CORS**: обмежено конкретним доменом (`APP_URL`), а не `*`.
- **Ідемпотентність вебхуків**: таблиця `stripe_events` — повторна подія від Stripe ігнорується.
- **Helmet + централізовані помилки + rate-limits** (v2.1).

---

## Крок 1. Створити проєкт Supabase
1. [supabase.com](https://supabase.com) → New project (безкоштовний план достатній для старту).
2. Дочекайся ініціалізації бази (1-2 хв).

## Крок 2. Виконати схему бази даних
1. Dashboard → **SQL Editor** → **New query**.
2. Встав увесь вміст файлу `schema.sql` з цього проєкту → **Run**.
3. Перевір: у **Table Editor** мають з'явитись `profiles`, `tasks`, `day_settings`, `templates`, `stripe_events`.

## Крок 3. Увімкнути Email-авторизацію
1. Dashboard → **Authentication → Providers → Email** — вже увімкнено за замовчуванням.
2. **Authentication → URL Configuration** → додай свій майбутній домен (і `http://localhost:3000` для локальної розробки) у **Redirect URLs**.

## Крок 4. Скопіювати ключі Supabase
Dashboard → **Project Settings → API**:
- `Project URL` → `SUPABASE_URL`
- `anon public` ключ → `SUPABASE_ANON_KEY`
- `service_role` ключ → `SUPABASE_SERVICE_ROLE_KEY` (тримати в секреті!)

## Крок 5. Stripe — продукт, три ціни, ключі
(Так само, як у версії 1)
1. [stripe.com](https://stripe.com) → тестовий режим.
2. **Product catalog** → Add product → додай три Ціни (Recurring/monthly): 99 UAH, 2.99 USD, 2.79 EUR.
3. Скопіюй три **Price ID** → `.env`.
4. **Developers → API keys** → Secret key → `.env`.

## Крок 6. Деплой (Render / Railway / Fly.io)
1. Заливаєш проєкт у GitHub.
2. Створюєш сервіс на хостингу, підключаєш репозиторій.
3. Build: `npm install`, Start: `npm start`.
4. Додаєш усі змінні з `.env.example` у налаштування хостингу.
5. Після деплою — публічна адреса, встав її як `APP_URL` (і на хостингу, і локально).
6. Онови **Redirect URLs** у Supabase (крок 3) цією ж адресою.

## Крок 7. Вебхук Stripe
1. **Developers → Webhooks → Add endpoint** → `https://твій-домен/api/webhook`.
2. Події: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
3. Signing secret → `.env` як `STRIPE_WEBHOOK_SECRET`. Передеплой.

## Крок 8. Перевірка
1. Відкрий сайт → введи email → перейди за посиланням з листа.
2. Додай завдання, онови сторінку — має лишитись (тепер це база, не браузер).
3. Оформи тестову підписку карткою `4242 4242 4242 4242`.
4. Перевір у Supabase Table Editor → `profiles`, що `premium = true`.

## Локальний запуск
```bash
npm install
cp .env.example .env   # заповни ключами
npm start
```

## Що ще варто зробити перед реальним публічним запуском
- Перейти в Stripe Live mode і повторити кроки 5 та 7 з боєвими ключами.

---

## Крок 4 — LLM-звіти та теми оформлення

### Що нового
- **Аналітичний звіт** (`GET /api/reports/weekly`): агрегує статистику за 7 днів, надсилає в LLM, кешує результат на добу в `llm_reports`. **Доступно лише Преміум-користувачам** — кожен виклик коштує гроші на стороні LLM-провайдера, тому це навмисно платна фіча, а не просто UI-обмеження.
- **Гнучкий провайдер**: `LLM_PROVIDER=anthropic` (за замовчуванням, Claude) або `openai-compatible` — останній підходить і для OpenAI, і для локального Ollama (`LLM_API_URL=http://localhost:11434/v1`), без зміни коду.
- **Теми оформлення**: перемикач ◐/⚡/⚙ в хедері — Класична, Техно-магія (неонові акценти, глітч-ефект на кліках), Стімпанк (латунні кольори, синтезований механічний "клац" на сповіщеннях — той самий `AudioContext`, що й для бінаурального ритму, без нових файлів).
- Глітч-ефект обгорнутий у `@media (prefers-reduced-motion: no-preference)` — вимикається автоматично для людей з відповідною системною настройкою.

### Що зробити вручну
**1. Виконати нову міграцію** — `migration_005_llm_reports.sql` у Supabase SQL Editor (після `migration_004_gamification.sql`).

**2. Отримати ключ LLM-провайдера:**
- Anthropic (за замовчуванням): [console.anthropic.com](https://console.anthropic.com) → API Keys → додати `ANTHROPIC_API_KEY` у `.env`.
- Або локальний Ollama: встановити, запустити `ollama serve`, вказати `LLM_PROVIDER=openai-compatible` і `LLM_API_URL=http://localhost:11434/v1` (працює лише якщо сам сервер застосунку теж локальний або має доступ до цієї адреси — для продакшн-хостингу типу Render локальний Ollama на твоєму комп'ютері недосяжний, знадобиться або хмарний LLM, або окремо задеплоєний Ollama-сервер).

---

## Версія 3 — доопрацювання (адаптивність, надійність підписок, безпека)

### Що нового
- **Адаптивність**: бічне меню-навігація з'являється на екранах ширших за 1300px; список завдань перетворюється на сітку 2 колонки на екранах ширших за 900px.
- **Гарячі клавіші**: Enter у полі назви завдання — додати; Space (поза полями вводу) — почати перше завдання або завершити активне/на паузі.
- **Оптимістичний UI**: усі дії над завданнями (почати/пауза/завершити/прибрати/перемістити/додати) оновлюють інтерфейс миттєво, ще до відповіді від Supabase. Якщо запит не пройде (немає мережі) — зміна відкочується назад і з'явиться тост з поясненням.
- **invoice.payment_failed**: невдале списання одразу позначає `subscription_status='past_due'` і знімає Premium — користувач бачить банер "оновіть спосіб оплати".
- **Stripe Customer Portal**: кнопка "Керувати підпискою" відкриває офіційний кабінет Stripe — зміна картки, скасування, квитанції. Власний `/api/cancel-subscription` лишився в коді, портал просто зручніший.
- **Rate limiting**: запит magic link тепер іде через `/api/auth/request-link` (не напряму в Supabase), обмежено 5 запитів / 15 хв на IP.
- **Індекс** `idx_tasks_user_date` та **автоархів** завдань старших 90 днів — обидва в `schema.sql`.

### Два кроки, які треба зробити вручну (без них нове не запрацює)

**1. Увімкнути pg_cron (для автоархіву)**
Supabase Dashboard → **Database → Extensions** → знайти `pg_cron` → Enable.
Без цього кроку останній `select cron.schedule(...)` у `schema.sql` впаде з помилкою — виконай `schema.sql` двома заходами: спочатку все до архіву, потім увімкни розширення, потім решту.

**2. Увімкнути Stripe Customer Portal**
Stripe Dashboard → **Settings → Billing → Customer portal** → Activate.
Без активації `/api/create-portal-session` поверне помилку від Stripe API.

Якщо оновлюєш вже задеплоєний проєкт (а не ставиш з нуля) — виконай у Supabase SQL Editor лише нові частини `schema.sql` (колонку `subscription_status`, індекс, таблицю архіву й cron), не весь файл повторно.
