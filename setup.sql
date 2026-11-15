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

-- =====================================================================
-- 9) Estoque de casulas por vicariato
--    Saldo de um local = soma das movimentações. "Disponíveis" no app =
--    saldo - vestimentas entregues a padres daquele vicariato.
-- =====================================================================
create table if not exists public.estoque_mov (
  id          bigint generated always as identity primary key,
  local       text not null check (char_length(trim(local)) between 2 and 100),
  quantidade  integer not null check (quantidade <> 0 and abs(quantidade) <= 10000),
  tipo        text not null check (tipo in ('definicao', 'transferencia')),
  contraparte text,
  por         text,
  criado_em   timestamptz not null default now()
);
create index if not exists estoque_mov_local_idx on public.estoque_mov (local);
alter table public.estoque_mov enable row level security;
revoke all on public.estoque_mov from anon, public;
revoke all on public.estoque_mov from authenticated;
grant select on public.estoque_mov to authenticated;
drop policy if exists "estoque: equipe e admin leem" on public.estoque_mov;
create policy "estoque: equipe e admin leem" on public.estoque_mov
  for select to authenticated using (public.papel() is not null);

-- Casulas já entregues (vestimenta marcada) a padres do vicariato principal
create or replace function public.casulas_entregues(p_local text)
returns integer
language sql stable
set search_path = ''
as $$
  select count(*)::integer from public.padres
   where tipo = 'padre' and vestimenta_em is not null and vicariato = p_local;
$$;

-- Admin define quantas casulas um local tem (registra a diferença).
create or replace function public.definir_estoque(p_local text, p_quantidade integer, p_recepcionista text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_atual integer;
  v_local text := trim(coalesce(p_local, ''));
begin
  if public.papel() is distinct from 'admin' then
    raise exception 'Somente o administrador define o estoque' using errcode = '42501';
  end if;
  if char_length(v_local) < 2 or p_quantidade is null or p_quantidade < 0 or p_quantidade > 10000 then
    raise exception 'Quantidade inválida' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(7311003);
  select coalesce(sum(quantidade), 0) into v_atual from public.estoque_mov where local = v_local;
  if p_quantidade <> v_atual then
    insert into public.estoque_mov (local, quantidade, tipo, por)
    values (v_local, p_quantidade - v_atual, 'definicao', left(p_recepcionista, 60));
  end if;
  return jsonb_build_object('status', 'ok', 'local', v_local, 'saldo', p_quantidade);
end;
$$;
revoke all on function public.definir_estoque(text, integer, text) from public, anon;
grant execute on function public.definir_estoque(text, integer, text) to authenticated;

-- Equipe e admin transferem casulas disponíveis de um local para outro.
create or replace function public.transferir_estoque(p_origem text, p_destino text, p_quantidade integer, p_recepcionista text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_disp integer;
  v_origem text := trim(coalesce(p_origem, ''));
  v_destino text := trim(coalesce(p_destino, ''));
  v_quem text := left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60);
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if char_length(v_origem) < 2 or char_length(v_destino) < 2 or v_origem = v_destino
     or p_quantidade is null or p_quantidade < 1 or p_quantidade > 10000 then
    raise exception 'Transferência inválida' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(7311003);
  select coalesce(sum(quantidade), 0) - public.casulas_entregues(v_origem) into v_disp
    from public.estoque_mov where local = v_origem;
  if v_disp < p_quantidade then
    return jsonb_build_object('status', 'insuficiente', 'disponiveis', v_disp);
  end if;
  insert into public.estoque_mov (local, quantidade, tipo, contraparte, por) values
    (v_origem, -p_quantidade, 'transferencia', v_destino, v_quem),
    (v_destino, p_quantidade, 'transferencia', v_origem, v_quem);
  return jsonb_build_object('status', 'ok', 'disponiveis_origem', v_disp - p_quantidade);
end;
$$;
revoke all on function public.transferir_estoque(text, text, integer, text) from public, anon;
grant execute on function public.transferir_estoque(text, text, integer, text) to authenticated;

-- =====================================================================
-- 10) Pertences entregues por padres/bispos (com foto opcional)
-- =====================================================================
create table if not exists public.pertences (
  id            bigint generated always as identity primary key,
  padre_id      bigint not null references public.padres(id) on delete cascade,
  etiqueta      text check (etiqueta is null or char_length(etiqueta) <= 30),
  descricao     text not null check (char_length(trim(descricao)) between 2 and 300),
  foto          text check (foto is null or foto ~ '^padre_[0-9]+/[A-Za-z0-9_-]+\.jpg$'),
  recebido_em   timestamptz not null default now(),
  recebido_por  text,
  devolvido_em  timestamptz,
  devolvido_por text,
  atualizado_em timestamptz not null default now()
);
create index if not exists pertences_padre_idx on public.pertences (padre_id);
alter table public.pertences enable row level security;
revoke all on public.pertences from anon, public;
revoke all on public.pertences from authenticated;
grant select, delete on public.pertences to authenticated;
drop policy if exists "pertences: equipe e admin leem" on public.pertences;
drop policy if exists "pertences: admin exclui"        on public.pertences;
create policy "pertences: equipe e admin leem" on public.pertences
  for select to authenticated using (public.papel() is not null);
create policy "pertences: admin exclui" on public.pertences
  for delete to authenticated using (public.papel() = 'admin');

create or replace function public.guardar_pertence(p_padre_id bigint, p_descricao text, p_etiqueta text, p_foto text, p_recepcionista text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.pertences;
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if not exists (select 1 from public.padres where id = p_padre_id) then
    raise exception 'Padre não encontrado' using errcode = 'P0002';
  end if;
  insert into public.pertences (padre_id, descricao, etiqueta, foto, recebido_por)
  values (p_padre_id, trim(regexp_replace(coalesce(p_descricao, ''), '\s+', ' ', 'g')),
          nullif(trim(coalesce(p_etiqueta, '')), ''), nullif(p_foto, ''),
          left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60))
  returning * into v_row;
  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.guardar_pertence(bigint, text, text, text, text) from public, anon;
grant execute on function public.guardar_pertence(bigint, text, text, text, text) to authenticated;

create or replace function public.devolver_pertence(p_id bigint, p_valor boolean, p_recepcionista text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_row public.pertences;
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  select * into v_row from public.pertences where id = p_id for update;
  if not found then
    raise exception 'Pertence não encontrado' using errcode = 'P0002';
  end if;
  if p_valor and v_row.devolvido_em is not null then
    return jsonb_build_object('status', 'ja', 'registro', to_jsonb(v_row));
  end if;
  update public.pertences
     set devolvido_em  = case when p_valor then now() else null end,
         devolvido_por = case when p_valor then left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60) else null end,
         atualizado_em = now()
   where id = p_id returning * into v_row;
  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.devolver_pertence(bigint, boolean, text) from public, anon;
grant execute on function public.devolver_pertence(bigint, boolean, text) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'estoque_mov') then
      execute 'alter publication supabase_realtime add table public.estoque_mov';
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pertences') then
      execute 'alter publication supabase_realtime add table public.pertences';
    end if;
  end if;
end $$;

-- Fotos: bucket privado; equipe e admin enviam e veem; só admin apaga.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pertences', 'pertences', false, 3145728, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];
drop policy if exists "pertences fotos: equipe e admin leem"   on storage.objects;
drop policy if exists "pertences fotos: equipe e admin enviam" on storage.objects;
drop policy if exists "pertences fotos: admin apaga"           on storage.objects;
create policy "pertences fotos: equipe e admin leem" on storage.objects
  for select to authenticated using (bucket_id = 'pertences' and public.papel() is not null);
create policy "pertences fotos: equipe e admin enviam" on storage.objects
  for insert to authenticated with check (bucket_id = 'pertences' and public.papel() is not null);
create policy "pertences fotos: admin apaga" on storage.objects
  for delete to authenticated using (bucket_id = 'pertences' and public.papel() = 'admin');

-- =====================================================================
-- 11) Vestimenta entregue ao padre ou a terceiro (nome + observação)
--     Substitui a marcação de presença no app. Aditivo: marcar_padre
--     continua funcionando para quem estiver com a versão anterior.
-- =====================================================================
alter table public.padres add column if not exists vestimenta_para text;
alter table public.padres add column if not exists vestimenta_terceiro text;
alter table public.padres add column if not exists vestimenta_obs text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'padres_vestimenta_para_check') then
    alter table public.padres add constraint padres_vestimenta_para_check
      check (vestimenta_para is null or vestimenta_para in ('padre', 'terceiro'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'padres_vestimenta_terceiro_check') then
    alter table public.padres add constraint padres_vestimenta_terceiro_check
      check ((vestimenta_terceiro is null or char_length(vestimenta_terceiro) <= 150)
         and (vestimenta_obs is null or char_length(vestimenta_obs) <= 300));
  end if;
end $$;

create or replace function public.entregar_vestimenta(
  p_id            bigint,
  p_valor         boolean,
  p_para          text,
  p_terceiro      text,
  p_obs           text,
  p_recepcionista text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      public.padres;
  v_quem     text := left(nullif(trim(coalesce(p_recepcionista, '')), ''), 60);
  v_para     text := coalesce(nullif(p_para, ''), 'padre');
  v_terceiro text := nullif(trim(regexp_replace(coalesce(p_terceiro, ''), '\s+', ' ', 'g')), '');
  v_obs      text := nullif(trim(coalesce(p_obs, '')), '');
begin
  if public.papel() is null then
    raise exception 'Acesso negado' using errcode = '42501';
  end if;
  if p_valor is null or v_para not in ('padre', 'terceiro') then
    raise exception 'Operação inválida' using errcode = '22023';
  end if;
  select * into v_row from public.padres where id = p_id for update;
  if not found then
    raise exception 'Padre não encontrado' using errcode = 'P0002';
  end if;

  if p_valor then
    if v_row.vestimenta_em is not null then
      return jsonb_build_object('status', 'ja', 'registro', to_jsonb(v_row));
    end if;
    if v_para = 'terceiro' and char_length(coalesce(v_terceiro, '')) < 2 then
      raise exception 'Informe o nome de quem retirou' using errcode = '23514';
    end if;
    update public.padres
       set vestimenta_em = now(), vestimenta_por = v_quem, vestimenta_para = v_para,
           vestimenta_terceiro = case when v_para = 'terceiro' then left(v_terceiro, 150) end,
           vestimenta_obs = left(v_obs, 300),
           chegou_em  = coalesce(chegou_em, now()),
           chegou_por = case when chegou_em is null then v_quem else chegou_por end
     where id = p_id returning * into v_row;
  else
    update public.padres
       set vestimenta_em = null, vestimenta_por = null, vestimenta_para = null,
           vestimenta_terceiro = null, vestimenta_obs = null,
           chegou_em = null, chegou_por = null
     where id = p_id returning * into v_row;
  end if;
  return jsonb_build_object('status', 'ok', 'registro', to_jsonb(v_row));
end;
$$;
revoke all on function public.entregar_vestimenta(bigint, boolean, text, text, text, text) from public, anon;
grant execute on function public.entregar_vestimenta(bigint, boolean, text, text, text, text) to authenticated;
