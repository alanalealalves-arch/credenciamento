-- =====================================================================
--  CREDENCIAMENTO DE PARTICIPANTES — script do banco (Supabase)
--  Cole tudo no SQL Editor do Supabase e clique em RUN. Pode rodar
--  de novo sem problema (não apaga dados).
--
--  Perfis de acesso (contas criadas em Authentication > Users):
--    equipe@credenciamento.app  -> recepção: cadastra e vê a lista
--    admin@credenciamento.app   -> administrador: também edita,
--                                  exclui e exporta
-- =====================================================================

-- 1) Tabela -----------------------------------------------------------
create table if not exists public.participantes (
  id             bigint generated always as identity primary key,
  nome           text not null check (char_length(trim(nome)) between 3 and 150),
  telefone       text not null check (telefone ~ '^[0-9]{10,11}$'),
  email          text not null check (char_length(email) <= 200
                                      and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  paroquia       text not null check (char_length(trim(paroquia)) between 2 and 200),
  recepcionista  text,
  dispositivo    text,
  client_id      uuid unique,          -- evita cadastro em dobro em caso de reenvio
  criado_por     uuid default auth.uid(),
  criado_em      timestamptz not null default now(),
  atualizado_em  timestamptz
);

create index if not exists participantes_telefone_idx  on public.participantes (telefone);
create index if not exists participantes_email_idx     on public.participantes (lower(email));
create index if not exists participantes_criado_em_idx on public.participantes (criado_em);

-- 2) Perfil de quem está logado -------------------------------------
create or replace function public.papel()
returns text
language sql stable
set search_path = public
as $$
  select case lower(coalesce(auth.jwt() ->> 'email', ''))
           when 'admin@credenciamento.app'  then 'admin'
           when 'equipe@credenciamento.app' then 'equipe'
           else null
         end;
$$;

-- 3) Segurança (Row Level Security) ----------------------------------
alter table public.participantes enable row level security;

revoke all on public.participantes from anon, public;
revoke all on public.participantes from authenticated;
grant select, delete on public.participantes to authenticated;
grant update (nome, telefone, email, paroquia) on public.participantes to authenticated;

drop policy if exists "equipe e admin leem"  on public.participantes;
drop policy if exists "admin edita"          on public.participantes;
drop policy if exists "admin exclui"         on public.participantes;

create policy "equipe e admin leem" on public.participantes
  for select to authenticated using (public.papel() is not null);

create policy "admin edita" on public.participantes
  for update to authenticated
  using (public.papel() = 'admin') with check (public.papel() = 'admin');

create policy "admin exclui" on public.participantes
  for delete to authenticated using (public.papel() = 'admin');

-- Inserção só pela função abaixo (não há policy de insert direto).

-- 4) Normaliza dados na edição ---------------------------------------
create or replace function public.participantes_normaliza()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.nome     := trim(regexp_replace(new.nome, '\s+', ' ', 'g'));
  new.telefone := regexp_replace(new.telefone, '\D', '', 'g');
  new.email    := lower(trim(new.email));
  new.paroquia := trim(new.paroquia);
  if tg_op = 'UPDATE' then
    new.atualizado_em := now();
  end if;
  return new;
end;
$$;

drop trigger if exists participantes_normaliza on public.participantes;
create trigger participantes_normaliza
  before insert or update on public.participantes
  for each row execute function public.participantes_normaliza();

-- 5) Cadastro (checa duplicado e grava numa única chamada) ----------
create or replace function public.cadastrar(
  p_nome          text,
  p_telefone      text,
  p_email         text,
  p_paroquia      text,
  p_recepcionista text,
  p_dispositivo   text,
  p_client_id     uuid,
  p_forcar        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tel   text := regexp_replace(coalesce(p_telefone, ''), '\D', '', 'g');
  v_email text := lower(trim(coalesce(p_email, '')));
  v_row   public.participantes;
  v_dups  jsonb;
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;

  -- Fila única: dois celulares nunca gravam o mesmo participante ao mesmo tempo
  perform pg_advisory_xact_lock(7311001);

  -- Reenvio do mesmo formulário (ex.: internet caiu na resposta)
  select * into v_row from public.participantes where client_id = p_client_id;
  if found then
    return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
  end if;

  if not coalesce(p_forcar, false) then
    select jsonb_agg(jsonb_build_object(
             'id', id, 'nome', nome, 'telefone', telefone, 'email', email,
             'paroquia', paroquia, 'criado_em', criado_em,
             'recepcionista', recepcionista) order by criado_em)
      into v_dups
      from public.participantes
     where telefone = v_tel or lower(email) = v_email;

    if v_dups is not null then
      return jsonb_build_object('status', 'duplicado', 'duplicados', v_dups);
    end if;
  end if;

  insert into public.participantes
         (nome, telefone, email, paroquia, recepcionista, dispositivo, client_id)
  values (p_nome, v_tel, v_email, p_paroquia,
          left(p_recepcionista, 60), left(p_dispositivo, 80), p_client_id)
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;

revoke all on function public.cadastrar(text, text, text, text, text, text, uuid, boolean) from public, anon;
grant execute on function public.cadastrar(text, text, text, text, text, text, uuid, boolean) to authenticated;

-- 6) Tempo real -------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'participantes') then
    execute 'alter publication supabase_realtime add table public.participantes';
  end if;
end $$;

-- Pronto! Em "Table Editor" deve aparecer a tabela "participantes".
