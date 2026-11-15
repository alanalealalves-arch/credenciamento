-- Casula congresso. Executar após setup.sql (com tests/bootstrap.sql). Tudo em rollback.
\set ON_ERROR_STOP on
begin;
insert into public.padres (nome, vicariato) values ('Pe. Um', 'Vic A'), ('Pe. Dois', 'Vic A'), ('Pe. Tres', 'Vic A');
set local role authenticated;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$
declare r jsonb; a bigint; b bigint; c bigint;
begin
  select id into a from public.padres where nome = 'Pe. Um';
  select id into b from public.padres where nome = 'Pe. Dois';
  select id into c from public.padres where nome = 'Pe. Tres';
  r := public.entregar_vestimenta_v2(a, true, 'padre', null, null, 'Ana', true);
  assert (r->'registro'->>'casula_congresso')::boolean and r->'registro'->>'vestimenta_em' is not null, 'entrega já como congresso';
  r := public.entregar_vestimenta_v2(a, true, 'padre', null, null, 'Bia', false);
  assert r->>'status' = 'ja' and (r->'registro'->>'casula_congresso')::boolean, 'segunda entrega não altera';
  r := public.entregar_vestimenta_v2(b, true, 'terceiro', 'Maria', null, 'Ana', false);
  assert not (r->'registro'->>'casula_congresso')::boolean, 'entrega comum';
  assert public.casulas_entregues('Vic A') = 1, 'congresso não desconta do estoque comum';
  r := public.marcar_casula_congresso(b, true, 'Ana');
  assert (r->'registro'->>'casula_congresso')::boolean and public.casulas_entregues('Vic A') = 0, 'corrige para congresso';
  begin perform public.marcar_casula_congresso(c, true, 'Ana'); raise exception 'marcou sem entrega';
  exception when invalid_parameter_value then null; end;
  r := public.entregar_vestimenta(b, false, null, null, null, 'Ana');
  assert not (select casula_congresso from public.padres where id = b), 'desfazer pela função antiga limpa congresso';
  r := public.entregar_vestimenta_v2(a, false, null, null, null, 'Ana', null);
  assert r->'registro'->>'vestimenta_em' is null and not (r->'registro'->>'casula_congresso')::boolean, 'desfazer pela v2 limpa';
end $$;
select set_config('request.jwt.claims','{"email":"intruso@example.org"}',true);
do $$ begin
  begin perform public.marcar_casula_congresso(1, true, 'x'); raise exception 'intruso marcou';
  exception when insufficient_privilege then null; end;
  begin perform public.entregar_vestimenta_v2(1, true, 'padre', null, null, 'x', true); raise exception 'intruso entregou';
  exception when insufficient_privilege then null; end;
end $$;
rollback;
\echo CONGRESSO_SQL_OK
