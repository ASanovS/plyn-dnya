-- ==========================================================
-- Плин дня — Міграція 009: Multi-Stat (JSONB) + Anti-Cheat (Focus Mode)
-- Виконати ПІСЛЯ migration_008_special_mapping.sql
-- ==========================================================


-- ==========================================================
-- ЧАСТИНА A. Схема
-- ==========================================================

-- Ваги характеристик для одного завдання. Порожній об'єкт '{}' = стара
-- поведінка (target_stat або мапінг категорії, фіксований +1 без хвилин).
alter table tasks add column if not exists stat_weights jsonb not null default '{}'::jsonb;

-- Валідація: ключі лише з 7 дозволених статів, значення 0..1.
-- (НЕ через CHECK з підзапитом — Postgres це забороняє для CHECK,
-- тому окрема функція + тригер.)
create or replace function public.validate_stat_weights()
returns trigger as $$
declare
  k text;
  v numeric;
begin
  for k, v in select * from jsonb_each_text(new.stat_weights)
  loop
    if k not in ('strength','perception','endurance','charisma','intelligence','agility','luck') then
      raise exception 'Невідома характеристика у stat_weights: %', k using errcode = '22023';
    end if;
    if v::numeric < 0 or v::numeric > 1 then
      raise exception 'Вага характеристики % поза межами 0..1: %', k, v using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_stat_weights on tasks;
create trigger trg_validate_stat_weights
  before insert or update of stat_weights on tasks
  for each row execute procedure public.validate_stat_weights();

-- Фактичний момент завершення (wall-clock) — потрібен для перевірки
-- перетину інтервалів. started_at лишається bigint (epoch ms) — не чіпаємо,
-- на ньому зав'язаний фронтенд-таймер; тут лише конвертуємо на льоту.
alter table tasks add column if not exists completed_at timestamptz;

-- Накопичувач "залишку хвилин" на кожну характеристику між рівнями —
-- без цього поля перенесення залишку (п.3 ТЗ) неможливо зберегти.
alter table profiles add column if not exists stat_progress jsonb not null default '{}'::jsonb;


-- ==========================================================
-- ЧАСТИНА B. Anti-Cheat
-- ==========================================================

-- ---------- Правило 1: лише одне активне завдання на користувача ----------
-- Авто-пауза попереднього активного завдання замість жорсткого блокування —
-- м'якше для UX і для сценаріїв офлайн-синку (кілька відкладених 'start'
-- підряд не повинні валити всю чергу помилкою).
create or replace function public.enforce_single_active_task()
returns trigger as $$
begin
  if new.status = 'active' then
    update tasks
      set status = 'paused',
          accumulated_min = accumulated_min +
            coalesce(greatest(0, extract(epoch from (now() - to_timestamp(started_at/1000.0))) / 60), 0),
          started_at = null
      where user_id = new.user_id
        and id <> new.id
        and status = 'active';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_single_active_task on tasks;
create trigger trg_enforce_single_active_task
  after insert or update of status on tasks
  for each row
  when (new.status = 'active')
  execute procedure public.enforce_single_active_task();

-- ---------- Правило 2: заборона перетину завершених інтервалів ----------
-- Порівнюємо [started_at, completed_at] нового завершеного завдання з усіма
-- ІНШИМИ вже завершеними завданнями того ж користувача. Захищає саме від
-- сценарію з ТЗ: офлайн-черга "доганяє" кілька completion-подій заднім
-- числом так, що вони фізично не могли статись одночасно в реальному часі.
create or replace function public.check_completed_time_overlap()
returns trigger as $$
declare
  v_conflict_id text;
  v_new_start timestamptz;
begin
  if new.status <> 'done' or new.started_at is null or new.completed_at is null then
    return new;
  end if;

  v_new_start := to_timestamp(new.started_at / 1000.0);

  select id into v_conflict_id
  from tasks
  where user_id = new.user_id
    and id <> new.id
    and status = 'done'
    and started_at is not null
    and completed_at is not null
    and v_new_start < completed_at
    and new.completed_at > to_timestamp(started_at / 1000.0)
  limit 1;

  if v_conflict_id is not null then
    raise exception 'CONCURRENT_TASKS_NOT_ALLOWED: інтервал виконання перетинається із завданням %', v_conflict_id
      using errcode = 'P0002';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_check_completed_overlap on tasks;
create trigger trg_check_completed_overlap
  before update of status, completed_at on tasks
  for each row
  when (new.status = 'done')
  execute procedure public.check_completed_time_overlap();


-- ==========================================================
-- ЧАСТИНА C. Оновлена RPC: multi-stat нарахування
-- ==========================================================
-- Сигнатура НЕ змінена (p_task_id, p_actual_min) — фронтенду нічого
-- переробляти не треба, вся нова логіка всередині.
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
  v_profile profiles%rowtype;
  v_safe_actual_min integer;
  v_stat_key text;
  v_weight numeric;
  v_added_min numeric;
  v_progress numeric;
  v_levels_gained integer;
  v_stats_touched jsonb := '{}'::jsonb;
  -- глобальний рівень/XP (без змін відносно попередньої версії)
  v_stat_column text;
  v_base_xp integer;
  v_multiplier numeric;
  v_xp_gain integer;
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

  -- Захист від "нескінченного таймера": реальний внесок обмежено розумною
  -- стелею (8 годин), а не тим, що прийшло від клієнта як є.
  v_safe_actual_min := least(greatest(p_actual_min, 1), 480);

  update tasks
    set status = 'done',
        actual_min = v_safe_actual_min,
        completed_at = now(),
        xp_awarded = true
    where id = p_task_id;
  -- ^ саме цей UPDATE проганяє tasks через trg_check_completed_overlap вище —
  -- якщо інтервал перетинається з іншим завершеним завданням, транзакція
  -- впаде тут з CONCURRENT_TASKS_NOT_ALLOWED, і RPC поверне помилку клієнту.

  select * into v_profile from profiles where id = auth.uid();

  if v_task.stat_weights is not null and v_task.stat_weights <> '{}'::jsonb then
    -- ---------- Новий шлях: multi-stat, час-залежний ----------
    for v_stat_key, v_weight in select key, value::numeric from jsonb_each_text(v_task.stat_weights)
    loop
      v_added_min := v_safe_actual_min * v_weight;
      v_progress := coalesce((v_profile.stat_progress ->> v_stat_key)::numeric, 0) + v_added_min;

      v_levels_gained := floor(v_progress / 60)::integer;
      v_progress := v_progress - (v_levels_gained * 60);

      if v_levels_gained > 0 then
        execute format('update profiles set %I = %I + $1 where id = $2', v_stat_key, v_stat_key)
          using v_levels_gained, auth.uid();
      end if;

      update profiles
        set stat_progress = jsonb_set(stat_progress, array[v_stat_key], to_jsonb(v_progress))
        where id = auth.uid();

      v_stats_touched := v_stats_touched || jsonb_build_object(v_stat_key, v_levels_gained);
    end loop;

    -- Глобальний XP/рівень і в новому шляху рахується так само, як і завжди —
    -- тільки характеристики тепер прокачуються за вагами, а не одна фіксована.
    v_base_xp := greatest(5, v_task.planned_min / 3);
  else
    -- ---------- Старий шлях: як і раніше, без змін поведінки ----------
    if v_task.target_stat is not null then
      v_stat_column := v_task.target_stat;
    else
      select stat_column into v_stat_column
        from category_stat_map where category = v_task.category;
      if v_stat_column is null then v_stat_column := 'perception'; end if;
    end if;

    v_base_xp := greatest(5, v_task.planned_min / 3);

    execute format('update profiles set %I = %I + 1 where id = $1', v_stat_column, v_stat_column)
      using auth.uid();

    v_stats_touched := jsonb_build_object(v_stat_column, 1);
  end if;

  -- ---------- Глобальний рівень/XP (незмінна логіка) ----------
  select coalesce(xp_multiplier, 1.00) into v_multiplier
    from day_settings where user_id = auth.uid() and day = v_task.day;
  if v_multiplier is null then v_multiplier := 1.00; end if;

  v_xp_gain := round(v_base_xp * v_multiplier);

  select * into v_profile from profiles where id = auth.uid(); -- перечитати після оновлень вище
  v_new_xp := v_profile.xp + v_xp_gain;
  v_new_level := v_profile.level;

  while v_new_level < 100 and v_new_xp >= v_new_level * 100 loop
    v_new_xp := v_new_xp - v_new_level * 100;
    v_new_level := v_new_level + 1;
  end loop;

  update profiles set xp = v_new_xp, level = v_new_level, updated_at = now() where id = auth.uid();

  v_xp_to_next := v_new_level * 100 - v_new_xp;

  return json_build_object(
    'xp_gain', v_xp_gain,
    'stats_touched', v_stats_touched,
    'new_xp', v_new_xp,
    'new_level', v_new_level,
    'leveled_up', v_new_level > v_profile.level,
    'xp_to_next_level', v_xp_to_next
  );
end;
$$;

revoke all on function public.complete_task_and_award_xp(text, integer) from public;
grant execute on function public.complete_task_and_award_xp(text, integer) to authenticated;
