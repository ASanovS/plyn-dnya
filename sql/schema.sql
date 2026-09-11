-- ==========================================================
-- Плин дня — схема бази даних (Supabase / PostgreSQL)
-- Виконати в Supabase Dashboard -> SQL Editor -> New query
-- ==========================================================

-- ---------- profiles ----------
-- Один рядок на користувача, лінкований 1:1 з auth.users.
-- premium / stripe_customer_id / subscription_id зберігаються тут,
-- а не у файлі, тому переживають перезапуск хостингу.
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  premium boolean not null default false,
  -- 'active' | 'past_due' | 'canceled' — окремо від premium, щоб фронтенд міг
  -- показати "оновіть картку" замість просто "безкоштовний план".
  subscription_status text not null default 'active',
  stripe_customer_id text,
  subscription_id text,
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

create policy "profiles_select_own" on profiles
  for select using (auth.uid() = id);

-- ВАЖЛИВО: навмисно немає UPDATE-політики для клієнта.
-- premium / subscription_status / stripe_customer_id / subscription_id
-- змінюються ВИКЛЮЧНО на сервері, через supabaseAdmin (service_role-ключ,
-- який ігнорує RLS) у обробнику вебхуків Stripe (server.js).
-- Якби існувала policy "for update using (auth.uid() = id)", будь-який
-- користувач міг би виконати з консолі браузера:
--   supabase.from('profiles').update({premium:true}).eq('id', myId)
-- і отримати Преміум без жодної оплати. Тому UPDATE для anon/authenticated
-- ролей лишається повністю забороненим RLS за замовчуванням.

-- Профіль створюється автоматично при реєстрації користувача.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ---------- day_settings ----------
-- Час початку кожного конкретного дня для користувача.
create table if not exists day_settings (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  day_start text not null default '09:00',
  primary key (user_id, day)
);

alter table day_settings enable row level security;

create policy "day_settings_owner" on day_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- tasks ----------
-- Замінює localStorage: завдання тепер у хмарі -> синхронізація між пристроями.
create table if not exists tasks (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  name text not null,
  planned_min integer not null,
  actual_min integer not null default 0,
  accumulated_min numeric not null default 0,
  category text not null default 'other',
  status text not null default 'pending',
  started_at bigint,
  position integer not null default 0,
  created_at timestamptz not null default now()
);

alter table tasks enable row level security;

create policy "tasks_owner" on tasks
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists tasks_user_day_idx on tasks(user_id, day);
create index if not exists idx_tasks_user_date on tasks (user_id, created_at);

-- ---------- templates ----------
create table if not exists templates (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null,
  tasks jsonb not null,
  created_at timestamptz not null default now()
);

alter table templates enable row level security;

create policy "templates_owner" on templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------- stripe_events ----------
-- Гарантія ідемпотентності вебхуків: Stripe іноді надсилає одну й ту саму
-- подію двічі. Перша спроба вставки проходить, повторна впаде на PRIMARY KEY.
create table if not exists stripe_events (
  id text primary key,
  created_at timestamptz not null default now()
);

-- До цієї таблиці звертається лише сервер через service_role ключ,
-- тому додаткові RLS-політики не потрібні (RLS вимкнено = доступ лише service_role).

-- ==========================================================
-- Автоматичний архів виконаних завдань старших за 90 днів
-- ==========================================================

-- Таблиця-архів з такою ж структурою, що й tasks.
create table if not exists archived_tasks (like tasks including all);

-- Функція: переносить старі виконані завдання в архів і видаляє з робочої таблиці.
create or replace function public.archive_old_tasks()
returns void as $$
begin
  insert into archived_tasks
    select * from tasks
    where status = 'done' and day < (current_date - interval '90 days');

  delete from tasks
    where status = 'done' and day < (current_date - interval '90 days');
end;
$$ language plpgsql security definer;

-- Розклад через pg_cron (= "Supabase Cron"): запускається щоночі о 03:00.
-- ПЕРЕД виконанням цього блоку: Dashboard -> Database -> Extensions -> увімкнути "pg_cron".
select cron.schedule(
  'archive-old-tasks-daily',
  '0 3 * * *',
  $$select public.archive_old_tasks();$$
);
