# Revisão de integridade, arquitetura e segurança

Revisão local em 15/11/2026. Não foram acessadas contas nem alterados dados de produção.

## Correções entregues

| Achado | Alteração e evidência |
|---|---|
| Exportação CSV aceitava conteúdo interpretável como fórmula | Células sempre entre aspas, escape de aspas e prefixo textual para operadores/caracteres perigosos. Testes com `=`, `+`, `-`, `@` e tabulação, além de download real |
| Logout mantinha dados pessoais em campos e lista | Limpeza do estado, formulário, DOM e modal, inclusive após evento de logout do SDK |
| Resposta de consulta iniciada antes do logout podia repovoar o estado | Geração da sessão invalida respostas antigas; teste com promessa de consulta resolvida após sair |
| Erro de signOut era ignorado | Adaptador propaga o erro e a interface informa falha |
| Reconciliação comparava apenas contagem | Nova consulta periódica recupera também edições perdidas; falha inicial volta a ser tentada |
| Validadores aceitavam comprimentos inconsistentes | Limites de nome/paróquia no navegador e nome completo/telefone no trigger; RPC rejeita UUID nulo |
| Funções SQL usavam schema público no search_path | `search_path = ''`, com referências de aplicação qualificadas |
| Temporizadores de timeout permaneciam após sucesso | Limpeza em `finally` |
| HTML, CSS, dados e acesso ao banco misturados | Arquivos com responsabilidades separadas; mantida implantação estática |
| Dependência Supabase flutuante em `@2` | Versão fixada em `2.119.0`, conferida nas releases oficiais |
| Acessibilidade básica incompleta | Foco visível, rótulos de busca e edição, perfil com aria-pressed, campos inválidos, modal com título, contenção e restauração do foco, fundo inerte e movimento reduzido |

## Pontos preservados

RLS bloqueia edição/exclusão para recepção; inserção direta não é concedida; a RPC revalida o papel antes de operar com privilégios elevados; client_id e bloqueio transacional evitam reenvios e corrida na duplicidade. Valores de participantes são escapados antes da montagem de HTML. A publicação contém chave publishable, sem chave de serviço identificada nos arquivos revisados.

## Limites e pendências operacionais

- Testes do navegador usam adaptador simulado: validam os fluxos da aplicação, não senhas reais, entrega realtime ou configuração do projeto remoto.
- Testes SQL usam PostgreSQL 18 descartável com identidade simulada. O script foi aplicado duas vezes e as asserções de acesso passaram. Validar também em homologação Supabase antes de aplicar em produção.
- Contas compartilhadas permitem apenas atribuição declarada pelo operador. `recepcionista` não comprova identidade individual. Para auditoria individual, migrar para contas por pessoa e papéis administrados no servidor. Desabilitar cadastro aberto e restringir alteração de e-mail no projeto Auth.
- Não há validação independente do estado atual de Auth, configurações de e-mail, expiração de sessão, backups, limites de login ou políticas efetivamente implantadas no serviço remoto.
- Toda a equipe pode ler dados pessoais pela API, mesmo sem botão de exportação. Se houver necessidade de restringir campos, criar views/RPCs específicas e rever os grants.
- SDK Supabase e SheetJS continuam servidos por CDN sem SRI. A versão fixa melhora reprodutibilidade, mas não elimina risco da cadeia de distribuição. Uma evolução é hospedar artefatos verificados localmente e configurar CSP compatível com Auth/Realtime.
- A lista completa em memória e a reconciliação a cada 20 segundos são adequadas a eventos pequenos; o tráfego cresce com participantes e dispositivos. Para maior escala, implementar paginação e sincronização incremental com tratamento de exclusões.
- Um timeout não cancela uma operação já recebida no servidor. No cadastro, manter o mesmo formulário conserva o UUID para repetição segura.

## Referências

- [Supabase: RLS e funções com privilégios elevados](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection)
- [Supabase JS: releases oficiais](https://github.com/supabase/supabase-js/releases/tag/v2.119.0)
