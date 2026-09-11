-- ==========================================================
-- Плин дня — Міграція 005: кеш аналітичних LLM-звітів
-- Виконати ПІСЛЯ migration_004_gamification.sql
-- ==========================================================

-- Один звіт на користувача на день (кеш, щоб не платити за LLM повторно
-- при кожному відкритті сторінки — генерація максимум раз на добу,
-- або за явним запитом "regenerate", теж обмеженим rate-limit'ом на сервері).
create table if not exists llm_reports (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  report_text text not null,
  generated_at timestamptz not null default now(),
  primary key (user_id, day)
);

alter table llm_reports enable row level security;

-- Клієнт може тільки читати свої звіти. Запис — лише supabaseAdmin
-- (service_role) на сервері, після реальної відповіді від LLM.
create policy "llm_reports_select_own" on llm_reports
  for select using (auth.uid() = user_id);
