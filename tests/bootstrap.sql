-- SOMENTE em PostgreSQL local descartável. Simula as funções de identidade do Supabase.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
 select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;
create function auth.uid() returns uuid language sql stable as $$
 select nullif(auth.jwt()->>'sub','')::uuid;
$$;
grant usage on schema auth to authenticated, anon;
