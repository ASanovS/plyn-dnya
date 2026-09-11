-- ==========================================================
-- Плин дня — Міграція 006: локальна дата (Europe/Kyiv) у pg_cron
-- Виконати ПІСЛЯ migration_005_llm_reports.sql
-- ==========================================================

-- Той самий клас бага, що й у Завданні 1 на фронтенді/бекенді:
-- current_date у Postgres на Supabase за замовчуванням рахується в UTC,
-- тому "сьогодні"/"вчора" для серії днів могли зсуватись на пару годин
-- відносно реального київського календаря, особливо вночі.
create or replace function public.rollover_daily_streaks()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Europe/Kyiv')::date;
  v_yesterday date := v_today - interval '1 day';
  r record;
begin
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
      insert into day_settings (user_id, day, day_start, current_streak, xp_multiplier)
      values (r.user_id, v_today, '09:00', r.prev_streak + 1, least(1.00 + (r.prev_streak + 1) * 0.05, 2.00))
      on conflict (user_id, day) do update
        set current_streak = excluded.current_streak,
            xp_multiplier = excluded.xp_multiplier;
    else
      insert into day_settings (user_id, day, day_start, current_streak, xp_multiplier)
      values (r.user_id, v_today, '09:00', 0, 1.00)
      on conflict (user_id, day) do update
        set current_streak = 0, xp_multiplier = 1.00;
    end if;
  end loop;
end;
$$;

-- Розклад лишається той самий (запуск щодня о 00:05 UTC — сама функція
-- тепер коригує дату під Europe/Kyiv незалежно від часу запуску cron).
