-- ==========================================================
-- Плин дня — Міграція 008: явний вибір характеристики S.P.E.C.I.A.L.
-- Виконати ПІСЛЯ migration_007_beta_access.sql
-- ==========================================================
-- Бета-преміум (п.4 вихідного ТЗ) уже реалізовано в migration_007_beta_access.sql
-- (з реальним DB-тригером на ліміт, не лише колонкою) — тут НЕ дублюється.

-- ---------- tasks.target_stat ----------
-- Явний оверрайд характеристики для конкретного завдання. NULL означає
-- "використати дефолтний мапінг за категорією" (як і раніше).
alter table tasks add column if not exists target_stat text;

alter table tasks drop constraint if exists tasks_target_stat_chk;
alter table tasks add constraint tasks_target_stat_chk
  check (target_stat is null or target_stat in
    ('strength','perception','endurance','charisma','intelligence','agility','luck'));

-- ---------- Розширений мапінг категорія -> характеристика ----------
-- health лишається на endurance (як і було) — для випадків типу "бокс",
-- де потрібна саме Сила, використовується target_stat, а не окрема
-- категорія "sport" з неоднозначним дефолтом.
insert into category_stat_map (category, stat_column) values
  ('work', 'intelligence'),
  ('personal', 'charisma'),
  ('health', 'endurance'),
  ('other', 'perception'),
  ('agility', 'agility'),
  ('habit', 'luck')
on conflict (category) do update set stat_column = excluded.stat_column;

-- ---------- Оновлена RPC: target_stat має пріоритет над мапінгом категорії ----------
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

  -- Пріоритет 1: явно вказаний стат на самому завданні (бокс -> strength,
  -- а не типовий endurance від категорії "health").
  if v_task.target_stat is not null then
    v_stat_column := v_task.target_stat;
  else
    -- Пріоритет 2: дефолтний мапінг за категорією (як і раніше).
    select stat_column into v_stat_column
      from category_stat_map where category = v_task.category;
    if v_stat_column is null then v_stat_column := 'perception'; end if;
  end if;

  -- Базова формула: 1 XP за кожні 3 заплановані хвилини, мінімум 5.
  v_base_xp := greatest(5, v_task.planned_min / 3);

  select coalesce(xp_multiplier, 1.00) into v_multiplier
    from day_settings where user_id = auth.uid() and day = v_task.day;
  if v_multiplier is null then v_multiplier := 1.00; end if;

  v_xp_gain := round(v_base_xp * v_multiplier);

  select * into v_profile from profiles where id = auth.uid();
  v_new_xp := v_profile.xp + v_xp_gain;
  v_new_level := v_profile.level;

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

revoke all on function public.complete_task_and_award_xp(text, integer) from public;
grant execute on function public.complete_task_and_award_xp(text, integer) to authenticated;
