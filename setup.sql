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

-- Coluna anulável para preservar participantes cadastrados antes desta migração.
alter table public.participantes add column if not exists vicariato text
  check (vicariato is null or char_length(trim(vicariato)) between 2 and 100);

create index if not exists participantes_telefone_idx  on public.participantes (telefone);
create index if not exists participantes_email_idx     on public.participantes (lower(email));
create index if not exists participantes_criado_em_idx on public.participantes (criado_em);

-- 2) Perfil de quem está logado -------------------------------------
create or replace function public.papel()
returns text
language sql stable
set search_path = ''
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
grant update (nome, telefone, email, paroquia, vicariato) on public.participantes to authenticated;

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
set search_path = ''
as $$
begin
  new.nome     := trim(regexp_replace(new.nome, '\s+', ' ', 'g'));
  if char_length(new.nome) < 5 or position(' ' in new.nome) = 0 then
    raise exception 'Informe nome e sobrenome' using errcode = '23514';
  end if;
  new.telefone := regexp_replace(new.telefone, '\D', '', 'g');
  if new.telefone ~ '^([0-9])\1+$' or (length(new.telefone) = 11 and substring(new.telefone, 3, 1) <> '9') then
    raise exception 'Telefone inválido' using errcode = '23514';
  end if;
  new.email    := lower(trim(new.email));
  new.paroquia := trim(new.paroquia);
  new.vicariato := nullif(trim(regexp_replace(new.vicariato, '\s+', ' ', 'g')), '');
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
-- Remove a assinatura anterior para evitar ambiguidade no PostgREST.
drop function if exists public.cadastrar(text, text, text, text, text, text, uuid, boolean);
create or replace function public.cadastrar(
  p_nome          text,
  p_telefone      text,
  p_email         text,
  p_paroquia      text,
  p_recepcionista text,
  p_dispositivo   text,
  p_client_id     uuid,
  p_forcar        boolean default false,
  p_vicariato     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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

  if p_vicariato is null or char_length(trim(p_vicariato)) not between 2 and 100 then
    raise exception 'Informe o vicariato' using errcode = '23514';
  end if;

  if p_client_id is null then
    raise exception 'Identificador de envio obrigatório' using errcode = '23514';
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
             'paroquia', paroquia, 'vicariato', vicariato, 'criado_em', criado_em,
             'recepcionista', recepcionista) order by criado_em)
      into v_dups
      from public.participantes
     where telefone = v_tel or lower(email) = v_email;

    if v_dups is not null then
      return jsonb_build_object('status', 'duplicado', 'duplicados', v_dups);
    end if;
  end if;

  insert into public.participantes
         (nome, telefone, email, paroquia, recepcionista, dispositivo, client_id, vicariato)
  values (p_nome, v_tel, v_email, p_paroquia,
          left(p_recepcionista, 60), left(p_dispositivo, 80), p_client_id, p_vicariato)
  returning * into v_row;

  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;

revoke all on function public.cadastrar(text, text, text, text, text, text, uuid, boolean, text) from public, anon;
grant execute on function public.cadastrar(text, text, text, text, text, text, uuid, boolean, text) to authenticated;

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

-- =====================================================================
-- 7) Check-in de padres e bispos
--    Lista pré-carregada; a recepção marca "chegou" e "vestimenta".
--    Pode rodar de novo sem apagar dados.
-- =====================================================================
create table if not exists public.padres (
  id               bigint generated always as identity primary key,
  nome             text not null check (char_length(trim(nome)) between 3 and 150),
  funcao           text check (funcao is null or char_length(funcao) <= 80),
  vicariato        text not null check (char_length(trim(vicariato)) between 2 and 100),
  vicariato2       text check (vicariato2 is null or char_length(vicariato2) <= 100),
  paroquia         text check (paroquia is null or char_length(paroquia) <= 400),
  mitra            text check (mitra is null or char_length(mitra) <= 20),
  incluido_na_hora boolean not null default false,
  incluido_por     text,
  chegou_em        timestamptz,
  chegou_por       text,
  vestimenta_em    timestamptz,
  vestimenta_por   text,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now()
);
create index if not exists padres_vicariato_idx on public.padres (vicariato);

alter table public.padres enable row level security;
revoke all on public.padres from anon, public;
revoke all on public.padres from authenticated;
grant select, delete on public.padres to authenticated;
grant update (nome, funcao, vicariato, vicariato2, paroquia, mitra) on public.padres to authenticated;

drop policy if exists "padres: equipe e admin leem" on public.padres;
drop policy if exists "padres: admin edita"         on public.padres;
drop policy if exists "padres: admin exclui"        on public.padres;
create policy "padres: equipe e admin leem" on public.padres
  for select to authenticated using (public.papel() is not null);
create policy "padres: admin edita" on public.padres
  for update to authenticated
  using (public.papel() = 'admin') with check (public.papel() = 'admin');
create policy "padres: admin exclui" on public.padres
  for delete to authenticated using (public.papel() = 'admin');

create or replace function public.padres_normaliza()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.nome       := trim(regexp_replace(new.nome, '\s+', ' ', 'g'));
  new.vicariato  := trim(regexp_replace(new.vicariato, '\s+', ' ', 'g'));
  new.vicariato2 := nullif(trim(regexp_replace(coalesce(new.vicariato2, ''), '\s+', ' ', 'g')), '');
  new.paroquia   := nullif(trim(coalesce(new.paroquia, '')), '');
  new.funcao     := nullif(trim(coalesce(new.funcao, '')), '');
  new.mitra      := nullif(trim(coalesce(new.mitra, '')), '');
  if tg_op = 'UPDATE' then new.atualizado_em := now(); end if;
  return new;
end;
$$;
drop trigger if exists padres_normaliza on public.padres;
create trigger padres_normaliza
  before insert or update on public.padres
  for each row execute function public.padres_normaliza();

-- Marca/desmarca chegada ou vestimenta. Equipe e admin.
--  * marcar o que já está marcado devolve status 'ja' (outro celular foi mais rápido);
--  * entregar vestimenta também marca a chegada;
--  * desmarcar a chegada também desmarca a vestimenta.
create or replace function public.marcar_padre(
  p_id            bigint,
  p_campo         text,
  p_valor         boolean,
  p_recepcionista text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.padres;
  v_quem text := left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60);
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if p_campo not in ('chegou', 'vestimenta') or p_valor is null then
    raise exception 'Operação inválida' using errcode = '22023';
  end if;

  select * into v_row from public.padres where id = p_id for update;
  if not found then
    raise exception 'Padre não encontrado' using errcode = 'P0002';
  end if;

  if p_campo = 'chegou' then
    if p_valor then
      if v_row.chegou_em is not null then
        return jsonb_build_object('status', 'ja', 'registro', to_jsonb(v_row));
      end if;
      update public.padres set chegou_em = now(), chegou_por = v_quem
       where id = p_id returning * into v_row;
    else
      update public.padres set chegou_em = null, chegou_por = null,
                               vestimenta_em = null, vestimenta_por = null
       where id = p_id returning * into v_row;
    end if;
  else
    if p_valor then
      if v_row.vestimenta_em is not null then
        return jsonb_build_object('status', 'ja', 'registro', to_jsonb(v_row));
      end if;
      update public.padres set vestimenta_em = now(), vestimenta_por = v_quem,
                               chegou_em  = coalesce(chegou_em, now()),
                               chegou_por = case when chegou_em is null then v_quem else chegou_por end
       where id = p_id returning * into v_row;
    else
      update public.padres set vestimenta_em = null, vestimenta_por = null
       where id = p_id returning * into v_row;
    end if;
  end if;

  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.marcar_padre(bigint, text, boolean, text) from public, anon;
grant execute on function public.marcar_padre(bigint, text, boolean, text) to authenticated;

-- Inclui na hora quem não estava na lista (já entra como "chegou").
create or replace function public.incluir_padre(
  p_nome          text,
  p_vicariato     text,
  p_paroquia      text,
  p_recepcionista text,
  p_forcar        boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.padres;
  v_nome text := trim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_quem text := left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60);
  v_dups jsonb;
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if char_length(v_nome) < 3 or char_length(trim(coalesce(p_vicariato, ''))) < 2 then
    raise exception 'Informe nome e vicariato' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(7311002);
  if not coalesce(p_forcar, false) then
    select jsonb_agg(to_jsonb(p) order by p.nome) into v_dups
      from public.padres p
     where lower(p.nome) = lower(v_nome);
    if v_dups is not null then
      return jsonb_build_object('status', 'duplicado', 'duplicados', v_dups);
    end if;
  end if;

  insert into public.padres (nome, vicariato, paroquia, incluido_na_hora, incluido_por, chegou_em, chegou_por)
  values (v_nome, p_vicariato, p_paroquia, true, v_quem, now(), v_quem)
  returning * into v_row;
  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.incluir_padre(text, text, text, text, boolean) from public, anon;
grant execute on function public.incluir_padre(text, text, text, text, boolean) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime'
                        and schemaname = 'public' and tablename = 'padres') then
    execute 'alter publication supabase_realtime add table public.padres';
  end if;
end $$;

-- 8) Tipo: padre, diácono ou bispo (abas separadas no check-in) ---------
alter table public.padres add column if not exists tipo text not null default 'padre';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'padres_tipo_check') then
    alter table public.padres add constraint padres_tipo_check check (tipo in ('padre', 'diacono', 'bispo'));
  end if;
end $$;
create index if not exists padres_tipo_idx on public.padres (tipo);
grant update (tipo) on public.padres to authenticated;

drop function if exists public.incluir_padre(text, text, text, text, boolean);
create or replace function public.incluir_padre(
  p_nome          text,
  p_vicariato     text,
  p_paroquia      text,
  p_recepcionista text,
  p_forcar        boolean default false,
  p_tipo          text default 'padre'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row  public.padres;
  v_tipo text := coalesce(nullif(p_tipo, ''), 'padre');
  v_vic  text := nullif(trim(coalesce(p_vicariato, '')), '');
  v_nome text := trim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'));
  v_quem text := left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60);
  v_dups jsonb;
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if v_tipo not in ('padre', 'diacono', 'bispo') then
    raise exception 'Tipo inválido' using errcode = '22023';
  end if;
  if v_tipo = 'bispo' and v_vic is null then v_vic := 'Bispos'; end if;
  if char_length(v_nome) < 3 or char_length(coalesce(v_vic, '')) < 2 then
    raise exception 'Informe nome e vicariato' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(7311002);
  if not coalesce(p_forcar, false) then
    select jsonb_agg(to_jsonb(p) order by p.nome) into v_dups
      from public.padres p
     where lower(p.nome) = lower(v_nome);
    if v_dups is not null then
      return jsonb_build_object('status', 'duplicado', 'duplicados', v_dups);
    end if;
  end if;

  insert into public.padres (nome, tipo, vicariato, paroquia, incluido_na_hora, incluido_por, chegou_em, chegou_por)
  values (v_nome, v_tipo, v_vic, p_paroquia, true, v_quem, now(), v_quem)
  returning * into v_row;
  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.incluir_padre(text, text, text, text, boolean, text) from public, anon;
grant execute on function public.incluir_padre(text, text, text, text, boolean, text) to authenticated;
