# Credenciamento — Arquidiocese 350 anos

Aplicação estática de recepção: login da equipe, cadastro com paróquia, vicariato e confirmação de duplicidade, lista compartilhada em tempo real e administração dos participantes. Interface responsiva em vinho, marfim e dourado, com navegação por teclado e mensagens de validação.

- Aplicação publicada: https://alanalealalves-arch.github.io/credenciamento/
- Supabase: projeto `credenciamento`, região São Paulo.

## Estrutura

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Estrutura e campos acessíveis |
| `styles.css` | Identidade visual e adaptação para celulares |
| `config.js` | URL, chave publishable, evento, contas e DDD |
| `paroquias.js` | Catálogo de paróquias e vicariatos |
| `api.js` | Adaptador Supabase: autenticação, consultas, RPC e tempo real |
| `app.js` | Estado, validação, formulários, busca e exportação |
| `setup.sql` | Tabela, RLS, normalização, função de cadastro e publicação realtime |
| `tests/` | Testes isolados de navegador e banco |
| `AUDITORIA.md` | Achados, correções, evidências e limites da revisão |

Sem etapa de build ou framework. Os scripts clássicos são carregados em ordem explícita no HTML. A chave publishable é pública por definição; nunca adicionar chaves secret/service_role ou senhas ao projeto.

## Executar localmente

```sh
python3 -m http.server 8000
```

Abra http://localhost:8000. **A execução normal usa o banco real configurado em `config.js`.** Para desenvolvimento manual, configure um projeto Supabase de homologação. A suíte automatizada injeta um adaptador falso e bloqueia conexões externas.

## Perfis e banco

Não há cadastro aberto. As contas `equipe@credenciamento.app` e `admin@credenciamento.app` devem existir no Supabase Authentication. O operador informa seu nome e a senha da conta selecionada. O banco decide o perfil pelo e-mail do JWT na função `public.papel()`.

- Recepção: consulta e cadastro por RPC.
- Administrador: também edição e exclusão; a interface disponibiliza CSV e Excel.
- Anônimo ou conta desconhecida: sem acesso aos participantes.

A exportação é uma conveniência da interface: como a equipe pode consultar participantes, também consegue copiar seus dados pela API. Ela não constitui uma barreira independente de acesso.

Execute `setup.sql` no SQL Editor do projeto de homologação e depois em produção, após revisão. O script pode ser reaplicado sem apagar dados. As novas validações serão aplicadas a novos cadastros e edições. O script exige nome e sobrenome, telefone válido e identificador de envio na RPC. Mudanças locais no SQL **não atualizam automaticamente o Supabase**.

O vicariato é obrigatório nos novos cadastros, com sugestões do catálogo. Ao selecionar uma paróquia sugerida, ele é preenchido automaticamente e pode ser ajustado. Participantes antigos preservam o campo vazio até edição. Vicariato também aparece na lista e nas exportações. Aplique o `setup.sql` atualizado antes de publicar o novo frontend, pois a RPC e as consultas agora usam esse campo.

O cadastro usa UUID por envio para reenvios idempotentes. Alterar o formulário cria um novo envio. A função serializa o cadastro para verificar duplicidade por telefone/e-mail, permitindo confirmação explícita quando necessário. A lista recebe eventos e faz reconciliação completa a cada 20 segundos para recuperar alterações perdidas, inclusive edições que não mudam o total.

## Check-in de padres e bispos

Primeira aba do app. A lista é pré-carregada na tabela `padres` (nome, função, vicariato, paróquia, mitra) e a recepção:

1. escolhe o **vicariato** (o padre informa);
2. digita parte do **nome**;
3. toca em **Marcar chegada** e/ou **Entregar vestimenta**. Tocar de novo pede confirmação para desfazer.

No topo: Esperados, Chegaram, Faltam e Vestimentas (tocar filtra a lista). Sem vicariato e sem nome, a tela mostra o painel por vicariato. Quem não está na lista entra por **+ Não está na lista** (já marcado como chegou, com aviso de nome repetido). O administrador exporta o **Excel do check-in** (lista + resumo por vicariato).

Regras no banco (`setup.sql`, seção 7): só as funções `marcar_padre` e `incluir_padre` alteram a situação, para equipe e admin; marcar o que já está marcado devolve `ja` e preserva quem marcou primeiro; entregar vestimenta também marca chegada; desmarcar chegada desmarca a vestimenta. Editar e excluir nomes da lista: só admin.

A carga inicial da lista não fica no repositório (dados pessoais em repositório público): é feita uma vez pelo SQL Editor.

Testes: `tests/checkin.sql` (banco) e `tests/test_checkin.py` (navegador, vários aparelhos simulados; `PADRES_JSON=arquivo.json` usa uma lista real local).

**Ordem de publicação:** rode o `setup.sql` no Supabase **antes** de fazer merge na `main` — o GitHub publica o site sozinho, mas não altera o banco.

**Versão dos arquivos:** a cada publicação, troque o número `?v=` dos arquivos `.js`/`.css` no `index.html` (ex.: data e hora). Sem isso, celulares que já abriram o app podem misturar arquivos novos e antigos por até 10 minutos.

## Estoque de casulas e pertences

- **ESTOQUE**: casulas por local (vicariatos + "Reserva central"). Disponíveis = casulas do local − vestimentas entregues a padres daquele vicariato (vicariato principal). Situação = disponíveis − padres que faltam chegar ("Pode faltar"/"Sobra"). Admin define o total de cada local (✎); equipe e admin transferem (não deixa a origem ficar negativa). Tudo fica em `estoque_mov` (histórico em "Movimentações").
- **PERTENCES**: botão "Pertences" no cartão de cada padre/bispo/diácono — descrição, nº de etiqueta e foto opcional (comprimida no celular para ~150 KB, JPEG). Fotos no bucket privado `pertences` do Supabase Storage (só usuários logados veem, por link temporário). Devolução com confirmação; aba PERTENCES lista e busca.
- Banco: `setup.sql` seções 9–10. Testes: `tests/estoque.sql` e `tests/test_checkin.py`.

## Testes

Python 3.10+ e Chromium/Playwright:

```sh
python3 -m venv .venv
. .venv/bin/activate
pip install -r tests/requirements.txt
python -m playwright install chromium
python -m unittest discover -s tests -v
```

Use `CHROMIUM_PATH` para apontar um navegador já instalado. A suíte verifica login válido/inválido, cadastro, validação, normalização, duplicidade, busca, permissões da interface, edição, exclusão, exportação CSV, escape de HTML, fórmulas de planilha, logout, respostas atrasadas, autocompletar e ausência de rolagem horizontal em celular/desktop. Capturas de tela ficam em `/tmp/cred-*.png`.

Para testar o banco, crie **um PostgreSQL local descartável**, usando uma conta com permissão de criar roles:

```sh
psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/bootstrap.sql -f setup.sql -f setup.sql -f tests/database.sql
```

`bootstrap.sql` simula apenas `auth.jwt()` e `auth.uid()`; **não execute esse arquivo no Supabase**. O teste de banco usa transação com rollback e verifica cadastro, reenvio, duplicidade, validações, leitura e alterações por perfil. Não substitui uma validação de Auth e Realtime em homologação.

## Publicação

O README original informa publicação automática ao atualizar `main`. Trabalhe em branch e revise o diff antes do merge. Publique todos os arquivos JS/CSS junto com o HTML. O SDK Supabase está fixado em `2.119.0`; o gerador Excel usa SheetJS `0.20.3`, carregado apenas na exportação. Atualizações dessas dependências devem ser revisadas e testadas.
