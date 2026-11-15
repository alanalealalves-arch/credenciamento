"""Check-in de padres: testes de navegador com vários "celulares" (páginas) compartilhando um servidor simulado.
Nenhuma requisição ao Supabase real. O estado do servidor fica em localStorage (comum às páginas) e as
mudanças chegam aos outros aparelhos por BroadcastChannel, como o tempo real do Supabase."""
import os, json, shutil, functools, http.server, threading, unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PADRES = [
 {"nome":"Pe. Lucas Fernando Marques da Silva, Obra de Maria","funcao":"Pároco","vicariato":"Vicariato São Lourenço","vicariato2":"Vicariato Soledade","paroquia":"Paróquia São João Paulo II","mitra":None},
 {"nome":"Pe. João Henrique Luiz Gonçalves","funcao":"Pároco","vicariato":"Vicariato Beberibe","vicariato2":None,"paroquia":"Paróquia Jesus Cristo Bom Pastor","mitra":None},
 {"nome":"Pe. Hélio do Nascimento","funcao":"Pároco","vicariato":"Vicariato Beberibe","vicariato2":None,"paroquia":"Paróquia Nossa Senhora da Conceição, Beberibe","mitra":None},
 {"nome":"Frei Antônio Souza","funcao":"Vigário","vicariato":"Vicariato Soledade","vicariato2":None,"paroquia":"Paróquia X","mitra":None},
 {"nome":"Dom Fernando Saburido","funcao":"Bispo","vicariato":"Bispos","vicariato2":None,"paroquia":None,"mitra":"58"},
]
extra = os.environ.get('PADRES_JSON')
if extra and Path(extra).exists(): PADRES = json.load(open(extra))
for _p in PADRES: _p.setdefault('tipo', 'bispo' if _p['vicariato'] == 'Bispos' else 'padre')
N_PADRES = sum(1 for p in PADRES if p['tipo'] == 'padre'); N_BISPOS = sum(1 for p in PADRES if p['tipo'] == 'bispo')

MOCK = r'''
(() => {
const KEY = 'mock_padres';
const ler = () => JSON.parse(localStorage.getItem(KEY) || '[]');
const gravar = a => localStorage.setItem(KEY, JSON.stringify(a));
if (!localStorage.getItem(KEY)) gravar((window.__SEED__ || []).map((p, i) => ({ id: i + 1, incluido_na_hora: false, chegou_em: null, chegou_por: null, vestimenta_em: null, vestimenta_por: null, ...p })));
const bc = new BroadcastChannel('mock-rt'); let ouvinte = null; window.__surdo = false; window.__calls = [];
bc.onmessage = e => { if (window.__surdo) return; if (e.data && e.data.__tab) { const f = window.__ouvTab && window.__ouvTab[e.data.__tab]; if (f) f(e.data); return; } if (ouvinte) ouvinte(e.data); };
const emitir = ev => { bc.postMessage(ev); if (!window.__surdo && ouvinte) ouvinte(ev); };
const agora = () => new Date().toISOString();
window.__API_FACTORY__ = () => ({
  sessao: async () => null,
  entrar: async (email, senha) => { if (senha !== 'correta') throw Error('Invalid login credentials'); window.__perfil = email.startsWith('admin') ? 'admin' : 'equipe'; return { email }; },
  sair: async () => {}, todos: async () => [], contar: async () => 0,
  ouvir: (c, s) => { s('SUBSCRIBED'); return () => {}; },
  cadastrar: async () => ({ status: 'ok', registro: { id: 1 } }), atualizar: async () => ({}), excluir: async () => {},
  padres: async () => ler(),
  ouvirPadres: (cb, s) => { ouvinte = cb; s && s('SUBSCRIBED'); return () => { ouvinte = null; }; },
  marcarPadre: async (id, campo, valor, quem) => {
    window.__calls.push({ id, campo, valor, quem });
    const a = ler(); const r = a.find(x => x.id === id); if (!r) throw Error('Padre não encontrado');
    if (campo === 'chegou') {
      if (valor) { if (r.chegou_em) return { status: 'ja', registro: r }; r.chegou_em = agora(); r.chegou_por = quem; }
      else { r.chegou_em = r.chegou_por = r.vestimenta_em = r.vestimenta_por = null; }
    } else {
      if (valor) { if (r.vestimenta_em) return { status: 'ja', registro: r }; r.vestimenta_em = agora(); r.vestimenta_por = quem; if (!r.chegou_em) { r.chegou_em = agora(); r.chegou_por = quem; } }
      else { r.vestimenta_em = r.vestimenta_por = null; }
    }
    gravar(a); emitir({ tipo: 'UPDATE', novo: { ...r } }); return { status: 'ok', registro: { ...r } };
  },
  tabela: async nome => JSON.parse(localStorage.getItem('mock_' + nome) || '[]'),
  ouvirTabela: (nome, cb) => { (window.__ouvTab = window.__ouvTab || {})[nome] = cb; return () => { delete window.__ouvTab[nome]; }; },
  enviarFoto: async (blob, id) => { const url = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
    const nome = `padre_${id}/f${Date.now()}.jpg`; const fotos = JSON.parse(localStorage.getItem('mock_fotos') || '{}'); fotos[nome] = url; localStorage.setItem('mock_fotos', JSON.stringify(fotos));
    window.__fotoBytes = blob.size; window.__fotoTipo = blob.type; return nome; },
  urlFoto: async c => JSON.parse(localStorage.getItem('mock_fotos') || '{}')[c],
  rpc: async (fn, a) => {
    const L = n => JSON.parse(localStorage.getItem('mock_' + n) || '[]'), G = (n, v) => localStorage.setItem('mock_' + n, JSON.stringify(v));
    const emitT = (tab, row) => { bc.postMessage({ __tab: tab, tipo: 'INSERT', novo: row }); if (!window.__surdo && window.__ouvTab && window.__ouvTab[tab]) window.__ouvTab[tab]({ tipo: 'INSERT', novo: row }); };
    const saldo = l => L('estoque_mov').filter(m => m.local === l).reduce((s, m) => s + m.quantidade, 0);
    const entregues = l => ler().filter(p => (p.tipo || 'padre') === 'padre' && p.vestimenta_em && p.vicariato === l).length;
    const novoId = arr => Math.max(0, ...arr.map(x => x.id)) + 1;
    if (fn === 'definir_estoque') { if (window.__perfil !== 'admin') throw Error('Somente o administrador define o estoque');
      const d = a.p_quantidade - saldo(a.p_local); if (d) { const m = L('estoque_mov'); const r = { id: novoId(m), local: a.p_local, quantidade: d, tipo: 'definicao', por: a.p_recepcionista, criado_em: agora() }; m.push(r); G('estoque_mov', m); emitT('estoque_mov', r); }
      return { status: 'ok' }; }
    if (fn === 'transferir_estoque') { const disp = saldo(a.p_origem) - entregues(a.p_origem); if (disp < a.p_quantidade) return { status: 'insuficiente', disponiveis: disp };
      const m = L('estoque_mov'); const r1 = { id: novoId(m), local: a.p_origem, quantidade: -a.p_quantidade, tipo: 'transferencia', contraparte: a.p_destino, por: a.p_recepcionista, criado_em: agora() }; m.push(r1);
      const r2 = { id: novoId(m), local: a.p_destino, quantidade: a.p_quantidade, tipo: 'transferencia', contraparte: a.p_origem, por: a.p_recepcionista, criado_em: agora() }; m.push(r2); G('estoque_mov', m); emitT('estoque_mov', r1); emitT('estoque_mov', r2);
      return { status: 'ok', disponiveis_origem: disp - a.p_quantidade }; }
    if (fn === 'guardar_pertence') { const m = L('pertences'); const r = { id: novoId(m), padre_id: a.p_padre_id, descricao: a.p_descricao, etiqueta: a.p_etiqueta || null, foto: a.p_foto, recebido_em: agora(), recebido_por: a.p_recepcionista, devolvido_em: null, devolvido_por: null }; m.push(r); G('pertences', m); emitT('pertences', r); return { status: 'ok', registro: r }; }
    if (fn === 'devolver_pertence') { const m = L('pertences'); const r = m.find(x => x.id === a.p_id); if (a.p_valor && r.devolvido_em) return { status: 'ja', registro: r };
      r.devolvido_em = a.p_valor ? agora() : null; r.devolvido_por = a.p_valor ? a.p_recepcionista : null; G('pertences', m); bc.postMessage({ __tab: 'pertences', tipo: 'UPDATE', novo: r }); return { status: 'ok', registro: r }; }
    throw Error('rpc desconhecida ' + fn);
  },
  incluirPadre: async p => {
    const a = ler();
    if (!p.forcar) { const d = a.filter(x => x.nome.toLowerCase() === p.nome.toLowerCase()); if (d.length) return { status: 'duplicado', duplicados: d }; }
    const r = { id: Math.max(0, ...a.map(x => x.id)) + 1, nome: p.nome, tipo: p.tipo || 'padre', vicariato: p.vicariato, vicariato2: null, paroquia: p.paroquia || null, funcao: null, mitra: null,
                incluido_na_hora: true, incluido_por: p.recepcionista, chegou_em: agora(), chegou_por: p.recepcionista, vestimenta_em: null, vestimenta_por: null };
    a.push(r); gravar(a); emitir({ tipo: 'INSERT', novo: r }); return { status: 'ok', registro: r };
  }
});
})();
'''

class CheckinTests(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a: None
    cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=cls.server.serve_forever, daemon=True).start()
    cls.pw = sync_playwright().start()
    cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
    cls.url = f'http://127.0.0.1:{cls.server.server_port}'
  @classmethod
  def tearDownClass(cls):
    cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
  def setUp(self):
    self.ctx = self.browser.new_context(viewport={'width': 1280, 'height': 900})
    self.ctx.add_init_script('window.__SEED__ = ' + json.dumps(PADRES) + ';' + MOCK)
    self.errors = []
  def tearDown(self):
    self.assertEqual(self.errors, []); self.ctx.close()
  def celular(self, nome='Ana', admin=False, mobile=False):
    p = self.ctx.new_page()
    if mobile: p.set_viewport_size({'width': 390, 'height': 844})
    p.on('pageerror', lambda e: self.errors.append(str(e)))
    p.route('https://**/*', lambda r: r.abort())
    p.goto(self.url); p.locator('#tela-login').wait_for(state='visible')
    p.fill('#login-nome', nome)
    p.click('[data-perfil="admin"]' if admin else '[data-perfil="equipe"]')
    p.fill('#login-senha', 'correta'); p.click('#btn-entrar')
    p.locator('#aba-checkin').wait_for(state='visible')
    p.wait_for_function("document.querySelector('#ck-esperados').textContent !== '…'")
    return p
  def numeros(self, p):
    return [p.inner_text(s) for s in ('#ck-esperados', '#ck-chegaram', '#ck-faltam', '#ck-vestimentas')]
  def item(self, p, texto):
    return p.locator('.ck-item', has_text=texto)

  def test_fluxo_vicariato_nome_chegada_vestimenta(self):
    a = self.celular('Ana'); n = N_PADRES
    self.assertEqual(self.numeros(a), [str(n), '0', str(n), '0'], 'aba Padres conta só padres')
    self.assertTrue(a.locator('.ck-resumo-linha').count() >= 3, 'painel por vicariato aparece sem filtro')
    a.select_option('#ck-vic', 'Vicariato Soledade')
    self.assertIn('Lucas Fernando', a.inner_text('#ck-itens'), 'quem tem dois vicariatos aparece nos dois')
    a.fill('#ck-nome', 'lucas')
    self.assertEqual(a.locator('.ck-item').count(), 1)
    self.item(a, 'Lucas').locator('[data-ck="chegou"]').click()
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1'")
    self.assertIn('Chegou', self.item(a, 'Lucas').locator('[data-ck="chegou"]').inner_text())
    self.assertIn('Ana', self.item(a, 'Lucas').inner_text())
    self.assertEqual(a.evaluate('window.__calls[0]'), {'id': a.evaluate("JSON.parse(localStorage.mock_padres).find(p=>p.nome.startsWith('Pe. Lucas Fernando')).id"), 'campo': 'chegou', 'valor': True, 'quem': 'Ana'})
    self.item(a, 'Lucas').locator('[data-ck="vestimenta"]').click()
    a.wait_for_function("document.querySelector('#ck-vestimentas').textContent === '1'")
    # vestimenta de quem ainda não chegou marca as duas coisas
    a.fill('#ck-nome', ''); a.select_option('#ck-vic', 'Vicariato Beberibe')
    self.item(a, 'Hélio').locator('[data-ck="vestimenta"]').click()
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '2'")
    self.assertEqual(self.numeros(a)[3], '2')

  def test_varios_celulares_ao_vivo_e_concorrencia(self):
    a = self.celular('Ana'); b = self.celular('Bia', mobile=True)
    for p in (a, b): p.select_option('#ck-vic', 'Vicariato Beberibe')
    self.item(a, 'João Henrique').locator('[data-ck="chegou"]').click()
    b.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1'")
    self.assertIn('Ana', self.item(b, 'João Henrique').inner_text(), 'o outro celular vê na hora quem marcou')
    # B não recebe o aviso a tempo e tenta marcar o mesmo padre
    b.evaluate('window.__surdo = true')
    self.item(a, 'Hélio').locator('[data-ck="chegou"]').click()
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '2'")
    self.item(b, 'Hélio').locator('[data-ck="chegou"]').click()
    b.wait_for_function("document.querySelector('#toast').textContent.includes('Já estava marcado')")
    self.assertIn('por Ana', b.inner_text('#toast'))
    b.wait_for_function("document.querySelector('#ck-chegaram').textContent === '2'")
    self.assertEqual(a.evaluate("JSON.parse(localStorage.mock_padres).filter(p=>p.chegou_em).length"), 2)

  def test_desfazer_filtros_e_inclusao(self):
    a = self.celular('Ana')
    a.select_option('#ck-vic', 'Vicariato Beberibe')
    self.item(a, 'Hélio').locator('[data-ck="vestimenta"]').click()
    a.wait_for_function("document.querySelector('#ck-vestimentas').textContent === '1'")
    self.item(a, 'Hélio').locator('[data-ck="chegou"]').click()
    a.locator('#ck-desfazer').wait_for()
    self.assertIn('vestimenta também', a.inner_text('.modal'))
    a.click('#ck-manter'); self.assertEqual(self.numeros(a)[1], '1', 'cancelar não desmarca')
    self.item(a, 'Hélio').locator('[data-ck="chegou"]').click(); a.click('#ck-desfazer')
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '0' && document.querySelector('#ck-vestimentas').textContent === '0'")
    self.item(a, 'João Henrique').locator('[data-ck="chegou"]').click()
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1'")
    a.click('.ck-filtros [data-ckfiltro="faltam"]')
    self.assertNotIn('João Henrique', a.inner_text('#ck-itens')); self.assertIn('Hélio', a.inner_text('#ck-itens'))
    a.click('.ck-filtros [data-ckfiltro="vestimenta"]')
    self.assertIn('João Henrique', a.inner_text('#ck-itens'))
    a.click('#contador-padres [data-ckfiltro="faltam"]')
    self.assertEqual(a.get_attribute('.ck-filtros [data-ckfiltro="faltam"]', 'aria-pressed'), 'true')
    # incluir quem não está na lista: nome repetido é avisado
    a.click('#ck-incluir'); a.fill('#ck-form-incluir input[name="nome"]', 'Pe. Hélio do Nascimento'); a.select_option('#ck-inc-vic', 'Vicariato Beberibe')
    a.click('#ck-inc-salvar'); a.locator('#ck-dup-voltar').wait_for(); a.click('#ck-dup-voltar')
    a.click('#ck-incluir'); a.fill('#ck-form-incluir input[name="nome"]', 'Pe. Visitante de Fora'); a.select_option('#ck-inc-vic', 'Vicariato Beberibe')
    a.click('#ck-inc-salvar')
    a.wait_for_function("document.querySelector('#ck-esperados').textContent === '%d'" % (N_PADRES + 1))
    self.assertIn('Incluído na hora por Ana', a.inner_text('#ck-itens'))

  def test_exportacao_so_para_admin_e_celular_sem_rolagem_lateral(self):
    r = self.celular('Ana', mobile=True)
    self.assertTrue(r.locator('#ck-exportar').is_hidden())
    self.assertEqual(r.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), True)
    r.screenshot(path='/tmp/ck-celular-painel.png', full_page=False)
    r.select_option('#ck-vic', 'Vicariato Beberibe')
    self.item(r, 'Hélio').locator('[data-ck="chegou"]').click()
    r.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1'")
    self.assertEqual(r.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), True)
    r.screenshot(path='/tmp/ck-celular-lista.png', full_page=False)
    adm = self.celular('Alana', admin=True)
    self.assertTrue(adm.locator('#ck-exportar').is_visible())
    adm.screenshot(path='/tmp/ck-desktop.png', full_page=False)

  def test_tres_abas_bispos_e_diaconos(self):
    a = self.celular('Ana'); b = self.celular('Bia', mobile=True)
    self.assertNotIn('Dom Fernando Saburido', a.inner_text('#ck-itens'))
    a.click('[data-aba="bispos"]')
    a.wait_for_function("document.querySelector('#ck-esperados').textContent === '%d'" % N_BISPOS)
    self.assertTrue(a.locator('#ck-campo-vic').is_hidden(), 'bispos não têm etapa de vicariato')
    self.assertIn('Mitra 58', self.item(a, 'Saburido').inner_text())
    a.fill('#ck-nome', 'saburido'); self.item(a, 'Saburido').locator('[data-ck="vestimenta"]').click()
    a.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1' && document.querySelector('#ck-vestimentas').textContent === '1'")
    b.wait_for_timeout(300)
    self.assertEqual(self.numeros(b)[1], '0', 'a aba Padres do outro celular não conta o bispo')
    b.click('[data-aba="bispos"]'); b.wait_for_function("document.querySelector('#ck-chegaram').textContent === '1'")
    a.click('[data-aba="diaconos"]')
    a.wait_for_function("document.querySelector('#ck-esperados').textContent === '0'")
    self.assertIn('Ainda não há diáconos', a.inner_text('#ck-itens'))
    a.click('#ck-incluir'); self.assertIn('Incluir diácono', a.inner_text('.modal'))
    a.fill('#ck-form-incluir input[name="nome"]', 'Diác. José Teste'); a.select_option('#ck-inc-vic', 'Vicariato Olinda'); a.click('#ck-inc-salvar')
    a.wait_for_function("document.querySelector('#ck-esperados').textContent === '1' && document.querySelector('#ck-chegaram').textContent === '1'")
    self.assertEqual(a.evaluate("JSON.parse(localStorage.mock_padres).find(p=>p.nome==='Diác. José Teste').tipo"), 'diacono')
    a.click('[data-aba="padres"]')
    a.wait_for_function("document.querySelector('#ck-esperados').textContent === '%d'" % N_PADRES)
    self.assertEqual(a.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), True)
    b.screenshot(path='/tmp/ck-celular-bispos.png')

  def test_estoque_de_casulas(self):
    adm = self.celular('Alana', admin=True); eq = self.celular('Bia', mobile=True)
    adm.click('[data-aba="estoque"]'); adm.locator('#es-tabela').wait_for()
    self.assertIn('Reserva central', adm.inner_text('#es-tabela'))
    adm.click('[data-definir="Vicariato Beberibe"]'); adm.fill('#es-form-def input[name="qtd"]', '2'); adm.click('#es-def-ok')
    adm.click('[data-definir="Reserva central"]'); adm.fill('#es-form-def input[name="qtd"]', '5'); adm.click('#es-def-ok')
    adm.wait_for_function("document.querySelector('#es-numeros').innerText.includes('7')")
    # equipe não vê o botão de definir estoque
    eq.click('[data-aba="estoque"]'); self.assertEqual(eq.locator('[data-definir]').count(), 0)
    # entrega 3 vestimentas em Beberibe (estoque 2): aviso de falta
    eq.click('[data-aba="padres"]'); eq.select_option('#ck-vic', 'Vicariato Beberibe')
    for nome in ('Hélio', 'João Henrique'):
      self.item(eq, nome).locator('[data-ck="vestimenta"]').click(); eq.wait_for_timeout(150)
    eq.wait_for_function("document.querySelector('#ck-vestimentas').textContent === '2'")
    linha = adm.locator('.es-linha', has_text='Vicariato Beberibe')
    adm.wait_for_function("[...document.querySelectorAll('.es-linha')].find(l=>l.innerText.includes('Vicariato Beberibe')).querySelector('.es-disp').textContent === '0'")
    faltam = sum(1 for p in PADRES if p['tipo'] == 'padre' and p['vicariato'] == 'Vicariato Beberibe') - 2
    self.assertIn(f'Pode faltar {faltam}' if faltam else 'Na conta certa', linha.inner_text(), 'situação = disponíveis − padres que faltam chegar')
    # transferência insuficiente e depois válida, feita pela equipe; admin vê ao vivo
    eq.click('[data-aba="estoque"]'); eq.click('#es-transferir')
    eq.select_option('#es-tr-de', 'Vicariato Beberibe'); eq.select_option('#es-tr-para', 'Reserva central'); eq.fill('#es-form-tr input[name="qtd"]', '1'); eq.click('#es-tr-ok')
    eq.wait_for_function("!document.querySelector('#es-tr-erro').hidden")
    self.assertIn('só tem 0', eq.inner_text('#es-tr-erro'))
    eq.select_option('#es-tr-de', 'Reserva central'); eq.select_option('#es-tr-para', 'Vicariato Beberibe'); eq.fill('#es-form-tr input[name="qtd"]', '3'); eq.click('#es-tr-ok')
    adm.wait_for_function("[...document.querySelectorAll('.es-linha')].find(l=>l.innerText.includes('Vicariato Beberibe')).querySelector('.es-disp').textContent === '3'")
    self.assertIn('Reserva central → Vicariato Beberibe', adm.text_content('#es-hist'))
    self.assertEqual(eq.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), True)
    eq.screenshot(path='/tmp/es-celular.png', full_page=True)
    adm.screenshot(path='/tmp/es-desktop.png', full_page=True)

  def test_pertences_com_foto_e_devolucao(self):
    import base64
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    a = self.celular('Ana', mobile=True); b = self.celular('Bia')
    a.select_option('#ck-vic', 'Vicariato Beberibe')
    self.item(a, 'Hélio').locator('[data-pertences]').click()
    a.fill('#pt-form input[name="desc"]', 'Mochila preta com notebook'); a.fill('#pt-form input[name="etq"]', '17')
    a.set_input_files('#pt-form input[type="file"]', files=[{'name': 'foto.png', 'mimeType': 'image/png', 'buffer': png}])
    a.wait_for_function("document.querySelector('#pt-foto-txt').textContent.includes('Trocar foto')")
    a.click('#pt-salvar')
    a.wait_for_function("document.querySelector('#toast').textContent.includes('Pertence guardado')")
    self.assertEqual(a.evaluate('window.__fotoTipo'), 'image/jpeg', 'foto é enviada como JPEG comprimido')
    self.assertIn('Nº 17', a.inner_text('#pt-lista-modal'))
    a.wait_for_function("document.querySelector('#pt-lista-modal img').src.startsWith('data:image/jpeg')")
    a.click('#pt-fechar')
    self.assertIn('1 guardado', self.item(a, 'Hélio').inner_text())
    # outro aparelho vê na aba PERTENCES e devolve
    b.click('[data-aba="pertences"]')
    b.wait_for_function("document.querySelector('#pt-itens').innerText.includes('Mochila preta')")
    b.fill('#pt-busca', '17'); self.assertIn('Pe. Hélio do Nascimento', b.inner_text('#pt-itens'))
    b.click('#pt-itens [data-devolver]'); b.click('#pt-dev-ok')
    b.wait_for_function("document.querySelector('#pt-resumo').textContent.includes('Devolvidos: 1')")
    b.click('[data-ptfiltro="devolvidos"]'); self.assertIn('Devolvido', b.inner_text('#pt-itens'))
    self.assertIn('por Bia', b.inner_text('#pt-itens'))
    a.click('[data-aba="pertences"]'); a.click('[data-ptfiltro="todos"]')
    self.assertEqual(a.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), True)
    a.screenshot(path='/tmp/pt-celular.png', full_page=True)

if __name__ == '__main__':
  unittest.main()
