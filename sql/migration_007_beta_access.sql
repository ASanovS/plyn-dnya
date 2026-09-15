-- ==========================================================
-- Плин дня — Міграція 007: бета-доступ + реальний ліміт на сервері
-- Виконати ПІСЛЯ migration_006_timezone_fix.sql
-- ==========================================================

-- ---------- Бета-доступ ----------
-- Тимчасовий Преміум для бета-тестерів, незалежний від Stripe.
alter table profiles add column if not exists beta_premium_until timestamptz;

-- Єдине місце визначення "чи преміум" — реальна підписка АБО активний
-- бета-грант. Використовується і тригером нижче, і може викликатись з
-- бекенду, щоб не дублювати цю логіку в кількох місцях.
create or replace function public.is_effectively_premium(p_user_id uuid)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select premium or (beta_premium_until is not null and beta_premium_until > now())
     from profiles where id = p_user_id),
    false
  );
$$;

-- ---------- Реальний ліміт 3 завдання/день для безкоштовного плану ----------
-- ВАЖЛИВО: завдання пишуться напряму з клієнта в Supabase (RLS), а не через
-- Express-бекенд — тобто "middleware" з ТЗ фізично нема куди вставити.
-- Єдина точка, де ліміт не можна обійти консоллю браузера, — тригер БД.
create or replace function public.enforce_free_task_limit()
returns trigger
language plpgsql
as $$
declare
  v_count integer;
  v_exists boolean;
begin
  if public.is_effectively_premium(new.user_id) then
    return new;
  end if;

  -- upsert() з фронтенду шле INSERT ... ON CONFLICT навіть для РЕДАГУВАННЯ
  -- вже існуючого завдання (позначити done, змінити назву тощо) — це не
  -- має рахуватись як "нове завдання" і впиратись у ліміт.
  select exists(select 1 from tasks where id = new.id) into v_exists;
  if v_exists then
    return new;
  end if;

  select count(*) into v_count from tasks where user_id = new.user_id and day = new.day;
  if v_count >= 3 then
    raise exception 'Ліміт безкоштовного плану — 3 завдання на день'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_free_task_limit on tasks;
create trigger trg_enforce_free_task_limit
  before insert on tasks
  for each row execute procedure public.enforce_free_task_limit();

-- ---------- Приклад: надати бету конкретному тестеру на 3 місяці ----------
-- update profiles set beta_premium_until = now() + interval '3 months'
--   where email = 'тестер@приклад.com';

-- ---------- Приклад: масово всім email з певного списку ----------
-- update profiles set beta_premium_until = now() + interval '1 month'
--   where email = any(array['a@example.com', 'b@example.com']);
