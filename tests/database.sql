-- Executar após setup.sql em banco descartável; rollback não altera dados existentes.
\set ON_ERROR_STOP on
begin;
set local role authenticated;
select set_config('request.jwt.claims','{"email":"equipe@credenciamento.app"}',true);
do $$
declare a jsonb; b jsonb; n bigint;
begin
 a := public.cadastrar('Pessoa Teste','81999998888','teste@example.org','São José','Teste','Local','11111111-1111-4111-8111-111111111111',false,'Vicariato Soledade');
 assert a->>'status' = 'ok', 'cadastro deve funcionar';
 b := public.cadastrar('Pessoa Teste','81999998888','teste@example.org','São José','Teste','Local','11111111-1111-4111-8111-111111111111',false,'Vicariato Soledade');
 assert a->'registro'->>'id' = b->'registro'->>'id', 'reenvio deve ser idempotente';
 b := public.cadastrar('Pessoa Teste','81999998888','teste@example.org','São José','Teste','Local','22222222-2222-4222-8222-222222222222',false,'Vicariato Soledade');
 assert b->>'status' = 'duplicado', 'deve detectar duplicidade';
 update public.participantes set nome='Alteração Indevida' where id=(a->'registro'->>'id')::bigint;
 get diagnostics n = row_count;
 assert n = 0, 'equipe não pode editar';
 delete from public.participantes where id=(a->'registro'->>'id')::bigint;
 get diagnostics n = row_count;
 assert n = 0, 'equipe não pode excluir';
 begin
  perform public.cadastrar('Nome','81988887777','outro@example.org','São José','Teste','Local',gen_random_uuid(),false,'Vicariato Soledade');
  raise exception 'Nome incompleto foi aceito';
 exception when check_violation then null;
 end;
 begin
  perform public.cadastrar('Pessoa Teste','81988887777','outro@example.org','São José','Teste','Local',null,false,'Vicariato Soledade');
  raise exception 'Identificador nulo foi aceito';
 exception when check_violation then null;
 end;
end $$;
select set_config('request.jwt.claims','{"email":"intruso@example.org"}',true);
do $$
begin
 assert (select count(*) from public.participantes) = 0, 'conta desconhecida não pode ler';
 begin
  perform public.cadastrar('Pessoa Teste','81988887777','outro@example.org','São José','Teste','Local',gen_random_uuid(),false,'Vicariato Soledade');
  raise exception 'Conta desconhecida conseguiu cadastrar';
 exception when insufficient_privilege then null;
 end;
end $$;
select set_config('request.jwt.claims','{"email":"admin@credenciamento.app"}',true);
do $$
declare n bigint;
begin
 update public.participantes set nome='Pessoa Atualizada' where client_id='11111111-1111-4111-8111-111111111111';
 get diagnostics n = row_count; assert n = 1, 'admin pode editar';
 delete from public.participantes where client_id='11111111-1111-4111-8111-111111111111';
 get diagnostics n = row_count; assert n = 1, 'admin pode excluir';
end $$;
set local role anon;
do $$
begin
 begin
  perform count(*) from public.participantes;
  raise exception 'Anônimo conseguiu ler';
 exception when insufficient_privilege then null;
 end;
end $$;
rollback;
