"""Testes de navegador isolados: nenhuma requisição ao Supabase real."""
import os
import shutil
import functools
import http.server
import threading
import unittest
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
MOCK = r'''window.__calls = []; window.__rows = []; window.__duplicate = false;
window.__API_FACTORY__ = () => ({
 sessao: async () => null,
 entrar: async (email, senha) => { if (senha !== 'correta') throw Error('Invalid login credentials'); return {email}; },
 sair: async () => {}, todos: async () => window.__rows,
 contar: async () => window.__rows.length,
 ouvir: (change, status) => { window.__change = change; status('SUBSCRIBED'); return () => {}; },
 cadastrar: async p => { window.__calls.push(p); if(window.__duplicate && !p.forcar) return {status:'duplicado', duplicados:window.__rows};
 const registro = {...p, id:window.__rows.length+1, criado_em:new Date().toISOString()}; window.__rows.push(registro); return {status:'ok',registro}; },
 atualizar: async (id, p) => { const r=window.__rows.find(r=>r.id===id); Object.assign(r,p); return r; },
 excluir: async id => { window.__rows = window.__rows.filter(r=>r.id!==id); }
});'''

class AppTests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
  cls.server = http.server.ThreadingHTTPServer(('127.0.0.1',0), handler)
  threading.Thread(target=cls.server.serve_forever,daemon=True).start()
  cls.pw = sync_playwright().start()
  cls.browser = cls.pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('google-chrome'), headless=True, args=['--no-sandbox'])
 @classmethod
 def tearDownClass(cls):
  cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close()
 def setUp(self):
  self.context = self.browser.new_context(viewport={'width':1440,'height':1000})
  self.page = self.context.new_page(); self.errors=[]
  self.page.on('pageerror',lambda e:self.errors.append(str(e)))
  self.page.route('https://**/*',lambda route:route.abort())
  self.page.add_init_script(MOCK)
  self.page.goto(f'http://127.0.0.1:{self.server.server_port}')
  self.page.locator('#tela-login').wait_for(state='visible')
 def tearDown(self):
  self.assertEqual(self.errors,[])
  self.context.close()
 def login(self,admin=False):
  self.page.fill('#login-nome','Maria Silva')
  if admin:self.page.click('[data-perfil="admin"]')
  self.page.fill('#login-senha','correta'); self.page.click('#btn-entrar')
  self.page.locator('#tela-app').wait_for(state='visible')
  self.page.click('[data-aba="cadastro"]')
 def fill(self):
  for sel,val in [('#f-nome','Ana Maria'),('#f-tel','999998888'),('#f-email','ANA@example.org'),('#f-par','Paróquia São José'),('#f-vic','Vicariato Soledade')]:self.page.fill(sel,val)
 def save(self):
  self.fill();self.page.click('#btn-cad');self.page.wait_for_function('window.__calls.length > 0')
 def test_login_validation_and_wrong_password(self):
  self.page.click('#btn-entrar');self.assertIn('Informe seu nome',self.page.inner_text('#login-erro'))
  self.page.fill('#login-nome','Maria Silva');self.page.fill('#login-senha','errada');self.page.click('#btn-entrar')
  self.page.wait_for_function("document.querySelector('#login-erro').textContent === 'Senha incorreta.'")
 def test_registration_normalization_and_list_search(self):
  self.login();self.save();self.page.wait_for_function("document.querySelector('#f-nome').value === ''")
  data=self.page.evaluate('window.__calls[0]');self.assertEqual(data['telefone'],'81999998888');self.assertEqual(data['email'],'ana@example.org');self.assertEqual(data['vicariato'],'Vicariato Soledade')
  self.page.click('[data-aba="lista"]');self.assertIn('Ana Maria',self.page.inner_text('#itens'))
  self.page.fill('#busca-nome','inexistente');self.assertIn('Nenhum participante',self.page.inner_text('#itens'))
  self.assertTrue(self.page.locator('#area-exportar').is_hidden());self.assertEqual(self.page.locator('[data-editar]').count(),0)
 def test_invalid_registration_and_offline_preserves_data(self):
  self.login();self.page.click('#btn-cad');self.assertEqual(self.page.locator('.campo.erro').count(),5)
  self.fill();self.context.set_offline(True);self.page.click('#btn-cad');self.assertIn('Sem internet',self.page.inner_text('#cad-erro'))
  self.assertEqual(self.page.input_value('#f-nome'),'Ana Maria');self.assertEqual(self.page.evaluate('window.__calls.length'),0)
 def test_duplicate_confirmation(self):
  self.login();self.page.evaluate('window.__duplicate = true');self.save()
  self.page.locator('#dup-forcar').wait_for();self.page.click('#dup-forcar')
  self.page.wait_for_function('window.__calls.length === 2');self.assertTrue(self.page.evaluate('window.__calls[1].forcar'))
  self.assertEqual(self.page.evaluate('window.__calls[0].client_id'),self.page.evaluate('window.__calls[1].client_id'))
 def test_admin_edit_delete(self):
  self.login(True);self.save();self.page.click('[data-aba="lista"]');self.page.click('[data-editar]')
  self.page.fill('#form-edit input[name="vicariato"]','Vicariato Várzea');self.page.fill('#form-edit input[name="nome"]','Ana Atualizada');self.page.click('#ed-salvar')
  self.page.wait_for_function("document.querySelector('#itens').textContent.includes('Ana Atualizada')")
  self.page.click('[data-excluir]');self.page.click('#ex-sim')
  self.page.wait_for_function("document.querySelector('#itens').textContent.includes('Nenhum participante cadastrado')")
 def test_xss_and_csv_formula_protection(self):
  self.login(True);self.page.evaluate('''S.linhas.set(1,{id:1,nome:'<img src=x onerror=alert(1)>',telefone:'81999998888',email:'a@b.org',paroquia:'São José',criado_em:new Date().toISOString()}); S.carregado=true;''')
  self.page.click('[data-aba="lista"]');self.assertEqual(self.page.locator('#itens img').count(),0)
  for value in ['=1+1','+SUM(A1)','@SUM(A1)','-1','\t=1']:
   self.assertTrue(self.page.evaluate('v => celulaCsv(v)',value).startswith('"\''))
 def test_logout_clears_personal_data(self):
  self.login();self.save();self.fill();self.page.on('dialog',lambda d:d.accept());self.page.click('#btn-sair')
  self.page.locator('#tela-login').wait_for(state='visible');self.assertEqual(self.page.input_value('#f-email'),'')
  self.assertEqual(self.page.evaluate('S.linhas.size'),0);self.assertEqual(self.page.inner_text('#itens'),'')
 def test_mobile_layout_and_autocomplete(self):
  self.page.set_viewport_size({'width':390,'height':844})
  self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  self.page.screenshot(path='/tmp/cred-login-mobile.png',full_page=True)
  self.login();self.page.fill('#f-par','São José');self.page.locator('#sug [data-i]').first.wait_for()
  self.page.press('#f-par','Enter');self.assertTrue(self.page.locator('#sug').is_hidden());self.assertTrue(self.page.input_value('#f-vic').startswith('Vicariato'))
  self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
  self.page.screenshot(path='/tmp/cred-cadastro-mobile.png',full_page=True)
 def test_late_load_cannot_restore_data_after_logout(self):
  self.login();self.page.wait_for_function('S.carregado')
  self.page.evaluate("S.api.todos = () => new Promise(resolve => window.__resolve = resolve); void carregarTudo()")
  self.page.on('dialog',lambda d:d.accept());self.page.click('#btn-sair')
  self.page.locator('#tela-login').wait_for(state='visible')
  self.page.evaluate("window.__resolve([{id:55,nome:'Não restaurar'}])")
  self.assertEqual(self.page.evaluate('S.linhas.size'),0)
 def test_admin_csv_download(self):
  self.login(True);self.save();self.page.click('[data-aba="lista"]')
  with self.page.expect_download() as info:self.page.click('#btn-csv')
  content=Path(info.value.path()).read_text(encoding='utf-8-sig')
  self.assertIn('"Ana Maria"',content);self.assertIn('"Paróquia São José"',content);self.assertIn('"Vicariato Soledade"',content)
 def test_desktop_layout(self):
  self.page.screenshot(path='/tmp/cred-login-desktop.png',full_page=True)
  self.login();self.page.screenshot(path='/tmp/cred-cadastro-desktop.png',full_page=True)
  self.assertTrue(self.page.evaluate('document.documentElement.scrollWidth <= innerWidth'))

if __name__ == '__main__':unittest.main(verbosity=2)
