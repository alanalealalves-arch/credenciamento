-- Executar após setup.sql em banco descartável (tests/bootstrap.sql antes). Tudo em rollback.
\set ON_ERROR_STOP on
begin;
insert into public.padres (nome, vicariato, paroquia) values ('Pe. Teste Um', 'Vicariato Soledade', 'Paróquia X');
set local role authenticated;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$
declare v_id bigint; r jsonb; n bigint;
begin
 select id into v_id from public.padres where nome = 'Pe. Teste Um';
 r := public.marcar_padre(v_id, 'chegou', true, 'Ana');
 assert r->>'status' = 'ok' and r->'registro'->>'chegou_por' = 'Ana', 'equipe marca chegada';
 r := public.marcar_padre(v_id, 'chegou', true, 'Bia');
 assert r->>'status' = 'ja' and r->'registro'->>'chegou_por' = 'Ana', 'segunda marcação devolve ja e preserva quem marcou';
 r := public.marcar_padre(v_id, 'chegou', false, 'Ana');
 assert r->'registro'->>'chegou_em' is null, 'desmarca chegada';
 r := public.marcar_padre(v_id, 'vestimenta', true, 'Caio');
 assert r->'registro'->>'chegou_em' is not null and r->'registro'->>'chegou_por' = 'Caio', 'vestimenta marca chegada junto';
 r := public.marcar_padre(v_id, 'chegou', false, 'Caio');
 assert r->'registro'->>'vestimenta_em' is null, 'desmarcar chegada desmarca vestimenta';
 r := public.incluir_padre('Pe. Teste Um', 'Vicariato Soledade', null, 'Ana');
 assert r->>'status' = 'duplicado', 'inclusão detecta nome repetido';
 r := public.incluir_padre('Pe. Novo da Silva', 'Vicariato Várzea', null, 'Ana');
 assert r->>'status' = 'ok' and (r->'registro'->>'incluido_na_hora')::boolean and r->'registro'->>'chegou_em' is not null, 'inclusão na hora já chega';
 r := public.incluir_padre('Dom Visitante', null, null, 'Ana', false, 'bispo');
 assert r->'registro'->>'tipo' = 'bispo' and r->'registro'->>'vicariato' = 'Bispos', 'bispo incluído sem vicariato';
 r := public.incluir_padre('Diác. Fulano de Tal', 'Vicariato Olinda', null, 'Ana', false, 'diacono');
 assert r->'registro'->>'tipo' = 'diacono', 'diácono incluído';
 begin perform public.incluir_padre('Alguém', 'X', null, 'Ana', false, 'outro'); raise exception 'tipo inválido aceito';
 exception when invalid_parameter_value then null; end;
 update public.padres set nome = 'Alterado' where id = v_id;
 get diagnostics n = row_count; assert n = 0, 'equipe não edita lista';
 delete from public.padres where id = v_id;
 get diagnostics n = row_count; assert n = 0, 'equipe não exclui';
 begin perform public.marcar_padre(v_id, 'outra', true, 'x'); raise exception 'campo inválido aceito';
 exception when invalid_parameter_value then null; end;
end $$;
select set_config('request.jwt.claims','{"email":"intruso@example.org"}',true);
do $$
declare n bigint;
begin
 select count(*) into n from public.padres; assert n = 0, 'conta desconhecida não lê';
 begin perform public.marcar_padre(1, 'chegou', true, 'x'); raise exception 'intruso marcou';
 exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claims','{"email":"admin@credenciamento.app"}',true);
do $$
declare n bigint;
begin
 update public.padres set paroquia = 'Corrigida' where nome = 'Pe. Teste Um';
 get diagnostics n = row_count; assert n = 1, 'admin edita';
end $$;
reset role;
set local role anon;
do $$ begin
 begin perform 1 from public.padres; raise exception 'anon leu padres';
 exception when insufficient_privilege then null; end;
end $$;
rollback;
\echo CHECKIN_SQL_OK
