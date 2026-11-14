# Credenciamento — Arquidiocese 350 anos

App web para a recepção cadastrar participantes do evento, com contador e lista geral em tempo real em vários celulares ao mesmo tempo.

- **App no ar:** https://alanalealalves-arch.github.io/credenciamento/
- **Banco:** Supabase, projeto `credenciamento` (região São Paulo) — `https://uolnqiikoybyhwjzgwgs.supabase.co`

## Arquivos

| Arquivo | O que é |
|---|---|
| `index.html` | O app inteiro (HTML, CSS e JavaScript num arquivo só). A configuração (URL, chave publishable, nome do evento, DDD padrão) fica no bloco `window.CONFIG`, no topo. |
| `setup.sql` | Script do banco: tabela `participantes`, regras de acesso (RLS), função `cadastrar` e tempo real. Pode rodar de novo sem apagar dados. |

## Como funciona

- **Login:** não há cadastro aberto. Existem só duas contas no Supabase (Authentication → Users):
  - `equipe@credenciamento.app` — recepção: cadastra e vê a lista;
  - `admin@credenciamento.app` — administrador: também edita, exclui e exporta (.xlsx/.csv).
  
  Na tela de entrada a pessoa digita o próprio nome (gravado em cada cadastro como `recepcionista`), escolhe o perfil e digita a senha da conta. O perfil é decidido pelo e-mail da conta, na função `public.papel()` do banco.
- **Cadastro:** feito só pela função `cadastrar` (RPC), que valida, avisa sobre duplicado (mesmo telefone ou e-mail) e evita gravar duas vezes o mesmo envio (`client_id`).
- **Tempo real:** o app escuta mudanças na tabela `participantes` e, a cada 20 s, confere o total com o banco.
- **Paróquias:** a lista do autocompletar está no próprio `index.html` (constante `PAROQUIAS`).

A chave que está no `index.html` é a *publishable*, feita para ficar pública. Nunca coloque a chave *secret* nem senhas no repositório.

## Como trabalhar

Toda alteração que entra na branch `main` é publicada automaticamente no link do app em 1–2 minutos.

1. Crie uma branch para cada melhoria (`git checkout -b minha-melhoria`).
2. Para testar no computador: `python3 -m http.server 8000` na pasta e abra `http://localhost:8000`. O app local usa o mesmo banco do app no ar — apague os cadastros de teste depois.
3. Abra um Pull Request para `main`. Faça o merge só depois de revisar.

**Mudanças no banco:** altere o `setup.sql` no mesmo Pull Request e rode o trecho novo no Supabase (SQL Editor). Mantenha o script rodável mais de uma vez (`if not exists`, `create or replace`, `drop ... if exists`).
