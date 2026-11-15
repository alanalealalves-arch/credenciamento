-- Vestimenta ao padre ou a terceiro. Executar após setup.sql (com tests/bootstrap.sql). Tudo em rollback.
\set ON_ERROR_STOP on
begin;
insert into public.padres (nome, vicariato) values ('Pe. Um', 'Vic A'), ('Pe. Dois', 'Vic A');
set local role authenticated;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$
declare r jsonb; a bigint; b bigint;
begin
  select id into a from public.padres where nome = 'Pe. Um';
  select id into b from public.padres where nome = 'Pe. Dois';
  r := public.entregar_vestimenta(a, true, 'padre', 'ignorar', ' ', 'Ana');
  assert r->'registro'->>'vestimenta_para' = 'padre' and r->'registro'->>'vestimenta_terceiro' is null and r->'registro'->>'vestimenta_obs' is null, 'ao padre';
  assert r->'registro'->>'chegou_em' is not null, 'mantém chegou sincronizado';
  r := public.entregar_vestimenta(a, true, 'terceiro', 'Maria', null, 'Bia');
  assert r->>'status' = 'ja' and r->'registro'->>'vestimenta_por' = 'Ana', 'segunda entrega devolve ja';
  begin perform public.entregar_vestimenta(b, true, 'terceiro', ' ', null, 'Ana'); raise exception 'terceiro sem nome aceito';
  exception when check_violation then null; end;
  r := public.entregar_vestimenta(b, true, 'terceiro', ' Maria  José ', 'Motorista do padre', 'Ana');
  assert r->'registro'->>'vestimenta_terceiro' = 'Maria José' and r->'registro'->>'vestimenta_obs' = 'Motorista do padre', 'a terceiro com nome e obs';
  r := public.entregar_vestimenta(b, false, null, null, null, 'Ana');
  assert r->'registro'->>'vestimenta_em' is null and r->'registro'->>'vestimenta_terceiro' is null and r->'registro'->>'chegou_em' is null, 'desfaz tudo';
  assert public.casulas_entregues('Vic A') = 1, 'estoque conta a entrega';
end $$;
select set_config('request.jwt.claims','{"email":"intruso@example.org"}',true);
do $$ begin
  begin perform public.entregar_vestimenta(1, true, 'padre', null, null, 'x'); raise exception 'intruso entregou';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
\echo VESTIMENTA_SQL_OK
