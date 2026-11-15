-- Estoque de casulas e pertences. Executar após setup.sql (com tests/bootstrap.sql). Tudo em rollback.
\set ON_ERROR_STOP on
begin;
insert into public.padres (nome, vicariato) values ('Pe. Um', 'Vic A'), ('Pe. Dois', 'Vic A'), ('Pe. Tres', 'Vic B');
set local role authenticated;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$ begin
  begin perform public.definir_estoque('Vic A', 2, 'Ana'); raise exception 'equipe definiu estoque';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"email":"admin@credenciamento.app"}',true);
do $$
declare r jsonb; s int; v_id bigint;
begin
  r := public.definir_estoque('Vic A', 2, 'Alana');
  r := public.definir_estoque('Reserva central', 5, 'Alana');
  r := public.definir_estoque('Reserva central', 5, 'Alana'); -- igual: não registra
  select count(*) into s from public.estoque_mov where local = 'Reserva central'; assert s = 1, 'redefinir igual não duplica';
  r := public.definir_estoque('Reserva central', 4, 'Alana');
  select sum(quantidade) into s from public.estoque_mov where local = 'Reserva central'; assert s = 4, 'redefinir registra diferença';
end $$;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$
declare r jsonb; s int; v_id bigint;
begin
  select id into v_id from public.padres where nome = 'Pe. Um';
  perform public.marcar_padre(v_id, 'vestimenta', true, 'Ana');
  assert public.casulas_entregues('Vic A') = 1, 'entrega desconta do vicariato';
  r := public.transferir_estoque('Vic A', 'Vic B', 2, 'Ana');
  assert r->>'status' = 'insuficiente' and (r->>'disponiveis')::int = 1, 'não transfere mais que o disponível';
  r := public.transferir_estoque('Reserva central', 'Vic B', 3, 'Ana');
  assert r->>'status' = 'ok' and (r->>'disponiveis_origem')::int = 1, 'transferência ok';
  select sum(quantidade) into s from public.estoque_mov where local = 'Vic B'; assert s = 3, 'destino recebeu';
  begin perform public.transferir_estoque('Vic B', 'Vic B', 1, 'Ana'); raise exception 'transferiu para si mesmo';
  exception when invalid_parameter_value then null; end;
  begin insert into public.estoque_mov (local, quantidade, tipo) values ('X', 1, 'definicao'); raise exception 'inseriu direto';
  exception when insufficient_privilege then null; end;
  -- pertences
  r := public.guardar_pertence(v_id, '  Mochila   preta ', '12', 'padre_1/abc.jpg', 'Ana');
  assert r->'registro'->>'descricao' = 'Mochila preta' and r->'registro'->>'recebido_por' = 'Ana', 'guarda pertence';
  r := public.devolver_pertence((r->'registro'->>'id')::bigint, true, 'Bia');
  assert r->'registro'->>'devolvido_por' = 'Bia', 'devolve';
  r := public.devolver_pertence((r->'registro'->>'id')::bigint, true, 'Caio');
  assert r->>'status' = 'ja' and r->'registro'->>'devolvido_por' = 'Bia', 'devolver de novo devolve ja';
  r := public.devolver_pertence((r->'registro'->>'id')::bigint, false, 'Bia');
  assert r->'registro'->>'devolvido_em' is null, 'desfaz devolução';
  begin perform public.guardar_pertence(v_id, 'x', null, '../../etc/passwd', 'Ana'); raise exception 'caminho de foto inválido aceito';
  exception when check_violation then null; end;
  delete from public.pertences; get diagnostics s = row_count; assert s = 0, 'equipe não apaga pertence';
  insert into storage.objects (bucket_id, name) values ('pertences', 'padre_1/abc.jpg');
  select count(*) into s from storage.objects where bucket_id = 'pertences'; assert s = 1, 'equipe envia e vê foto';
  delete from storage.objects; get diagnostics s = row_count; assert s = 0, 'equipe não apaga foto';
end $$;
select set_config('request.jwt.claims','{"email":"intruso@example.org"}',true);
do $$
declare s int;
begin
  select count(*) into s from public.estoque_mov; assert s = 0, 'intruso não lê estoque';
  select count(*) into s from public.pertences; assert s = 0, 'intruso não lê pertences';
  select count(*) into s from storage.objects; assert s = 0, 'intruso não vê fotos';
  begin insert into storage.objects (bucket_id, name) values ('pertences', 'padre_1/x.jpg'); raise exception 'intruso enviou foto';
  exception when insufficient_privilege then null; end;
  begin perform public.transferir_estoque('Vic A', 'Vic B', 1, 'x'); raise exception 'intruso transferiu';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"email":"admin@credenciamento.app"}',true);
do $$ declare s int; begin
  delete from public.pertences; get diagnostics s = row_count; assert s = 1, 'admin apaga pertence';
  delete from storage.objects where bucket_id = 'pertences'; get diagnostics s = row_count; assert s = 1, 'admin apaga foto';
end $$;
rollback;
\echo ESTOQUE_SQL_OK
