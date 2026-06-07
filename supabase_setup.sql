-- ============================================================================
--  Seed the Storm — global leaderboard backend (Supabase / Postgres)
-- ============================================================================
--  ONE-TIME SETUP
--  1. Create a free project at https://supabase.com (no card required).
--  2. Open the project → SQL Editor → paste this whole file → Run.
--  3. Project Settings → API: copy the "Project URL" and the "anon / public" key.
--  4. Paste both into index.html  →  window.SEEDSTORM_SUPABASE = { url, anonKey }.
--     (The anon key is meant to be public; safety comes from RLS + the trigger below.)
--
--  WHAT THIS DOES
--  - scores table: name, total_ace, best_storm_ace, avg_pct, created_at.
--  - Row-Level Security: anyone may READ and INSERT; nobody may UPDATE/DELETE
--    (you can still delete rows yourself from the dashboard to moderate).
--  - A BEFORE INSERT trigger validates length/characters AND rejects profanity
--    server-side (de-leetspeaks + collapses repeats, then substring-matches a
--    denylist) so it can't be bypassed by editing the page.
--  - total_ace (0–300) and best_storm_ace (0–100) are bounded to reject garbage.
--
--  To extend the word filter, edit the `bad` array in scores_validate() and the
--  matching BAD list in js/leaderboard.js, then re-run this file.
-- ============================================================================

create table if not exists public.scores (
  id             bigint generated always as identity primary key,
  name           text not null,
  total_ace      numeric(6,1) not null check (total_ace >= 0 and total_ace <= 300),
  best_storm_ace numeric(6,1) not null check (best_storm_ace >= 0 and best_storm_ace <= 100),
  avg_pct        int check (avg_pct between 0 and 100),
  created_at     timestamptz not null default now()
);

-- Two leaderboards from one table: highest total ACE (the whole 6-round game)
-- and highest single-storm ACE (the best individual storm in that game).
create index if not exists scores_total_idx on public.scores (total_ace desc, created_at asc);
create index if not exists scores_storm_idx on public.scores (best_storm_ace desc, created_at asc);

-- Normalize a name for matching: lowercase → de-leetspeak → letters only.
-- Mirrors norm() in js/leaderboard.js.
create or replace function public.norm_name(t text)
returns text language sql immutable as $$
  select regexp_replace(
           translate(lower(coalesce(t, '')), '0134578@$!|', 'oieastbasii'),
           '[^a-z]', '', 'g');
$$;

-- Validate + profanity-gate on insert. Raises on violation → PostgREST 400.
create or replace function public.scores_validate()
returns trigger language plpgsql as $$
declare
  n1  text;
  n2  text;
  w   text;
  bad text[] := array[
    'fuck','shit','bitch','cunt','asshole','dick','pussy','bastard','slut','whore',
    'cock','twat','wank','bollock','prick','douche','jizz','cum','penis','vagina',
    'boner','dildo','porn','rape','molest','nazi','hitler','nigger','nigga','faggot',
    'fag','retard','spic','chink','kike','wetback','coon','tranny','kkk','sex','anal','orgy'
  ];
begin
  new.name := btrim(new.name);
  if char_length(new.name) < 3 or char_length(new.name) > 12 then
    raise exception 'name length not allowed' using errcode = 'check_violation';
  end if;
  if new.name !~ '^[A-Za-z0-9 _''-]+$' then
    raise exception 'name characters not allowed' using errcode = 'check_violation';
  end if;
  n1 := public.norm_name(new.name);              -- leetspeak-folded, letters only
  n2 := regexp_replace(n1, '(.)\1+', '\1', 'g');  -- + collapsed repeats (catches "fuuuck")
  foreach w in array bad loop
    if position(w in n1) > 0 or position(w in n2) > 0 then
      raise exception 'name not allowed' using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_scores_validate on public.scores;
create trigger trg_scores_validate
  before insert on public.scores
  for each row execute function public.scores_validate();

-- Row-Level Security: public read + insert, no update/delete.
alter table public.scores enable row level security;

drop policy if exists scores_read on public.scores;
create policy scores_read   on public.scores for select using (true);

drop policy if exists scores_insert on public.scores;
create policy scores_insert on public.scores for insert with check (true);

-- Grant the anonymous (and logged-in) API roles access to the table.
grant usage on schema public to anon, authenticated;
grant select, insert on public.scores to anon, authenticated;

-- ----------------------------------------------------------------------------
--  OPTIONAL HARDENING (not required):
--  * Rate-limit by IP: add a Supabase Edge Function in front of inserts, or a
--    per-window counter table. The trigger above already blocks profanity and
--    garbage scores; an Edge Function is only needed to throttle spam volume.
--  * Moderation: delete bad rows in Table Editor, or
--      delete from public.scores where id = <id>;
-- ----------------------------------------------------------------------------
