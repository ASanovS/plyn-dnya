-- ==========================================================
-- Плин дня — Міграція 004: Clash Detection + RPG-прогресія
-- Виконати ПІСЛЯ schema.sql (v3), у Supabase SQL Editor.
-- ==========================================================


-- ==========================================================
-- ЧАСТИНА A. Clash Detection (захист від накладання завдань)
-- ==========================================================

-- Опціональні явні часові межі. NULL означає "гнучке" завдання
-- за старою моделлю (авто-каскад від day_settings.day_start) —
-- перевірка на конфлікт для таких рядків не застосовується.
alter table tasks add column if not exists start_time timestamptz;
alter table tasks add column if not exists end_time timestamptz;

alter table tasks drop constraint if exists tasks_time_order_chk;
alter table tasks add constraint tasks_time_order_chk
  check (start_time is null or end_time is null or end_time > start_time);

-- Функція-тригер: блокує INSERT/UPDATE, якщо новий часовий проміжок
-- перетинається з іншим завданням ТОГО Ж користувача в той самий день.
create or replace function public.check_task_time_overlap()
returns trigger as $$
declare
  v_conflict_id text;
begin
  -- Перевіряємо лише коли обидва часи задані явно.
  if new.start_time is null or new.end_time is null then
    return new;
  end if;

  select id into v_conflict_id
  from tasks
  where user_id = new.user_id
    and day = new.day
    and id <> new.id                -- не порівнювати рядок сам із собою при UPDATE
    and start_time is not null
    and end_time is not null
    and status <> 'done'            -- виконані завдання більше не займають слот
    and new.start_time < end_time
    and new.end_time > start_time   -- стандартна умова перетину інтервалів
  limit 1;

  if v_conflict_id is not null then
    raise exception 'Конфлікт часу: перетинається із завданням %', v_conflict_id
      using errcode = '23P01'; -- exclusion_violation, зручно ловити на клієнті
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_check_task_overlap on tasks;
create trigger trg_check_task_overlap
  before insert or update of start_time, end_time, day, status on tasks
  for each row execute procedure public.check_task_time_overlap();

-- Індекс під саме такий патерн вибірки (user_id + day + часові межі).
create index if not exists idx_tasks_overlap_lookup
  on tasks (user_id, day, start_time, end_time)
  where start_time is not null and end_time is not null;


-- ==========================================================
-- ЧАСТИНА B. RPG-прогресія (S.P.E.C.I.A.L.)
-- ==========================================================

alter table profiles add column if not exists level integer not null default 1
  check (level between 1 and 100);
alter table profiles add column if not exists xp integer not null default 0
  check (xp >= 0);

alter table profiles add column if not exists strength integer not null default 1 check (strength >= 0);
alter table profiles add column if not exists perception integer not null default 1 check (perception >= 0);
alter table profiles add column if not exists endurance integer not null default 1 check (endurance >= 0);
alter table profiles add column if not exists charisma integer not null default 1 check (charisma >= 0);
alter table profiles add column if not exists intelligence integer not null default 1 check (intelligence >= 0);
alter table profiles add column if not exists agility integer not null default 1 check (agility >= 0);
alter table profiles add column if not exists luck integer not null default 1 check (luck >= 0);

-- Захист від повторного нарахування XP за одне й те саме завдання
-- (наприклад, якщо хтось спробує вручну повернути status на 'pending'
-- через консоль і завершити ще раз).
alter table tasks add column if not exists xp_awarded boolean not null default false;

-- Множник досвіду за серію (комбо) повністю виконаних днів.
alter table day_settings add column if not exists current_streak integer not null default 0;
alter table day_settings add column if not exists xp_multiplier numeric(3,2) not null default 1.00;

-- ---------- Мапа категорія -> характеристика ----------
-- Винесено в окрему таблицю, а не захардкожено в функції, щоб можна було
-- розширювати без зміни коду RPC.
create table if not exists category_stat_map (
  category text primary key,
  stat_column text not null
);

insert into category_stat_map (category, stat_column) values
  ('work', 'intelligence'),
  ('personal', 'charisma'),
  ('health', 'endurance'),
  ('other', 'perception')
on conflict (category) do update set stat_column = excluded.stat_column;

-- Дозволяємо читання мапи авторизованим клієнтам (не секрет, просто конфіг).
alter table category_stat_map enable row level security;
drop policy if exists "category_stat_map_read_all" on category_stat_map;
create policy "category_stat_map_read_all" on category_stat_map
  for select using (true);

-- ---------- RPC: безпечне завершення завдання + нарахування XP ----------
-- SECURITY DEFINER навмисно: після видалення profiles_update_own (Крок безпеки v3.1)
-- звичайний клієнт більше не може оновлювати profiles взагалі. Ця функція —
-- єдиний контрольований виняток: вона зачіпає ЛИШЕ xp/level/одну характеристику,
-- і лише для завдання, що належить самому auth.uid(). Premium-поля вона не бачить.
create or replace function public.complete_task_and_award_xp(
  p_task_id text,
  p_actual_min integer
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task tasks%rowtype;
  v_stat_column text;
  v_base_xp integer;
  v_multiplier numeric;
  v_xp_gain integer;
  v_profile profiles%rowtype;
  v_new_xp integer;
  v_new_level integer;
  v_xp_to_next integer;
begin
  select * into v_task from tasks where id = p_task_id and user_id = auth.uid();
  if not found then
    raise exception 'Завдання не знайдено або немає доступу';
  end if;

  if v_task.xp_awarded then
    raise exception 'XP за це завдання вже нараховано';
  end if;

  update tasks
    set status = 'done', actual_min = p_actual_min, xp_awarded = true
    where id = p_task_id;

  select stat_column into v_stat_column
    from category_stat_map where category = v_task.category;
  if v_stat_column is null then v_stat_column := 'perception'; end if;

  -- Базова формула: 1 XP за кожні 3 заплановані хвилини, мінімум 5.
  v_base_xp := greatest(5, v_task.planned_min / 3);

  select coalesce(xp_multiplier, 1.00) into v_multiplier
    from day_settings where user_id = auth.uid() and day = v_task.day;
  if v_multiplier is null then v_multiplier := 1.00; end if;

  v_xp_gain := round(v_base_xp * v_multiplier);

  select * into v_profile from profiles where id = auth.uid();
  v_new_xp := v_profile.xp + v_xp_gain;
  v_new_level := v_profile.level;

  -- Проста крива рівня: рівень N вимагає N*100 сукупного XP на цьому рівні.
  while v_new_level < 100 and v_new_xp >= v_new_level * 100 loop
    v_new_xp := v_new_xp - v_new_level * 100;
    v_new_level := v_new_level + 1;
  end loop;

  execute format(
    'update profiles set xp = $1, level = $2, %I = %I + 1, updated_at = now() where id = $3',
    v_stat_column, v_stat_column
  ) using v_new_xp, v_new_level, auth.uid();

  v_xp_to_next := v_new_level * 100 - v_new_xp;

  return json_build_object(
    'xp_gain', v_xp_gain,
    'stat_increased', v_stat_column,
    'new_xp', v_new_xp,
    'new_level', v_new_level,
    'leveled_up', v_new_level > v_profile.level,
    'xp_to_next_level', v_xp_to_next
  );
end;
$$;

-- Явно забороняємо виклик анонімним (неавторизованим) клієнтам.
revoke all on function public.complete_task_and_award_xp(text, integer) from public;
grant execute on function public.complete_task_and_award_xp(text, integer) to authenticated;

-- ---------- Щоденний rollover серії (комбо) ----------
-- За тим самим патерном, що й archive_old_tasks: викликається pg_cron раз на добу.
-- Для кожного користувача перевіряє, чи ВСІ завдання за вчора мали status='done'.
create or replace function public.rollover_daily_streaks()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_yesterday date := current_date - interval '1 day';
  r record;
begin
  -- Обхід по користувачах, у яких вчора взагалі були завдання.
  for r in
    select t.user_id,
           count(*) as total,
           count(*) filter (where t.status = 'done') as done,
           coalesce(ds_y.current_streak, 0) as prev_streak
    from tasks t
    left join day_settings ds_y on ds_y.user_id = t.user_id and ds_y.day = v_yesterday
    where t.day = v_yesterday
    group by t.user_id, ds_y.current_streak
  loop
    if r.total > 0 and r.total = r.done then
      -- Ідеальний день -> серія +1, множник росте (капується x2.00).
      insert into day_settings (user_id, day, day_start, current_streak, xp_multiplier)
      values (r.user_id, current_date, '09:00', r.prev_streak + 1, least(1.00 + (r.prev_streak + 1) * 0.05, 2.00))
      on conflict (user_id, day) do update
        set current_streak = excluded.current_streak,
            xp_multiplier = excluded.xp_multiplier;
    else
      -- Були незавершені завдання -> серія скидається.
      insert into day_settings (user_id, day, day_start, current_streak, xp_multiplier)
      values (r.user_id, current_date, '09:00', 0, 1.00)
      on conflict (user_id, day) do update
        set current_streak = 0, xp_multiplier = 1.00;
    end if;
  end loop;
end;
$$;

-- Розклад: щодня о 00:05, одразу після зміни дати.
select cron.schedule(
  'rollover-daily-streaks',
  '5 0 * * *',
  $$select public.rollover_daily_streaks();$$
);
