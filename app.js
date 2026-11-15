
'use strict';
/* ===================== Paróquias (da base da Arquidiocese) ===================== */

/* ===================== Utilidades ===================== */
const $ = (s, el = document) => el.querySelector(s);
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const digitos = s => (s || '').replace(/\D/g, '');
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c === 'x' ? r : (r&3|8)).toString(16); }));
const ls = { get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
             set(k,v){ try { localStorage.setItem(k, v); } catch(e){} },
             del(k){ try { localStorage.removeItem(k); } catch(e){} } };

function fmtTel(d){
  d = digitos(d);
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return d;
}
function telCompleto(v){
  let d = digitos(v);
  if (d.startsWith('0')) d = d.replace(/^0+/, '');
  if (d.length === 12 || d.length === 13) { if (d.startsWith('55')) d = d.slice(2); }
  if (d.length === 8 || d.length === 9) d = CONFIG.DDD_PADRAO + d;
  return d;
}
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const limparNome = s => (s || '').replace(/\s+/g, ' ').trim();

function validar(v){
  const e = {};
  const nome = limparNome(v.nome);
  if (!nome) e.nome = 'Informe o nome completo.';
  else if (nome.split(' ').length < 2 || nome.length < 5 || nome.length > 150) e.nome = 'Informe nome e sobrenome.';
  const tel = telCompleto(v.telefone);
  if (!digitos(v.telefone)) e.telefone = 'Informe o telefone.';
  else if (!/^\d{10,11}$/.test(tel) || /^(\d)\1+$/.test(tel)) e.telefone = 'Telefone inválido. Use DDD + número.';
  else if (tel.length === 11 && tel[2] !== '9') e.telefone = 'Celular com 11 dígitos deve começar com 9 após o DDD.';
  const email = (v.email || '').trim().toLowerCase();
  if (!email) e.email = 'Informe o e-mail.';
  else if (!RE_EMAIL.test(email) || email.length > 200) e.email = 'E-mail inválido.';
  if (!(v.paroquia || '').trim()) e.paroquia = 'Informe a paróquia.';
  else if (v.paroquia.trim().length < 2 || v.paroquia.trim().length > 200) e.paroquia = 'Paróquia inválida.';
  const vicariato = limparNome(v.vicariato);
  if (vicariato.length < 2 || vicariato.length > 100) e.vicariato = 'Informe um vicariato de 2 a 100 caracteres.';
  return { erros: e, dados: { nome, telefone: tel, email, vicariato, paroquia: (v.paroquia || '').trim().replace(/\s+/g, ' ') } };
}

const fmtHora = iso => { const d = new Date(iso); return d.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit', second:'2-digit'}); };
const fmtData = iso => new Date(iso).toLocaleDateString('pt-BR');
const hojeStr = () => new Date().toLocaleDateString('pt-BR');
const fmtQuando = iso => (fmtData(iso) === hojeStr() ? '' : fmtData(iso) + ' ') + fmtHora(iso);

function erroAmigavel(err){
  const msg = (err && (err.message || err.error_description || err.msg)) || String(err || '');
  const code = err && err.code;
  if (!navigator.onLine) return 'Sem conexão com a internet.';
  if (/timeout|tempo/i.test(msg)) return 'O servidor demorou a responder. Verifique a internet.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(msg)) return 'Falha de conexão com o servidor.';
  if (code === '42501' || /permission|negado|row-level/i.test(msg)) return 'Seu perfil não tem permissão para isso.';
  if (code === '23514' || /check constraint/i.test(msg)) return 'Algum dado está em formato inválido.';
  if (/Invalid login credentials/i.test(msg)) return 'Senha incorreta.';
  if (/rate limit|too many/i.test(msg)) return 'Muitas tentativas. Aguarde um minuto e tente de novo.';
  return msg || 'Erro inesperado.';
}
async function comTempo(p, ms = 15000){
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/* ===================== Acesso ao banco (Supabase) ===================== */


/* ===================== Estado ===================== */
const S = {
  api: null, perfil: null, recep: '', disp: '',
  linhas: new Map(), carregado: false, carregando: null, recarregarDepois: false, buffer: null,
  salvando: false, clientId: null, ordemDesc: true, conectou: false, cancelarOuvir: null, timerConferir: null, geracao: 0
};
const el = {
  total: $('#total'), status: $('#status'), quem: $('#quem'), itens: $('#itens'), info: $('#info-lista'),
  nome: $('#f-nome'), tel: $('#f-tel'), email: $('#f-email'), par: $('#f-par'), vic: $('#f-vic'), sug: $('#sug'),
  btnCad: $('#btn-cad'), cadErro: $('#cad-erro'), ultimo: $('#ultimo'), toast: $('#toast')
};
const CAMPOS = [el.nome, el.tel, el.email, el.par, el.vic];

function mostrarTela(id){
  for (const t of ['tela-config', 'tela-login', 'tela-app']) $('#' + t).hidden = (t !== id);
}
let toastTimer;
function toast(txt, erro = false){
  el.toast.textContent = txt; el.toast.classList.toggle('erro', erro);
  el.toast.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), erro ? 3500 : 1800);
}
function setStatus(tipo){
  const m = { ok: ['', 'Ao vivo'], reconectando: ['reconectando', 'Reconectando…'], offline: ['offline', 'Sem internet'] }[tipo];
  el.status.className = 'status ' + m[0]; el.status.textContent = m[1];
}

/* ===================== Dados em tempo real ===================== */
function aplicar(ev){
  if (ev.tipo === 'DELETE') { if (ev.antigo && ev.antigo.id != null) S.linhas.delete(ev.antigo.id); }
  else if (ev.novo && ev.novo.id != null) S.linhas.set(ev.novo.id, ev.novo);
}
function aoMudar(ev){
  if (S.buffer) S.buffer.push(ev);
  aplicar(ev);
  agendarRender();
}
async function carregarTudo(){
  if (S.carregando) { S.recarregarDepois = true; return S.carregando; }
  const geracao = S.geracao;
  S.buffer = [];
  S.carregando = (async () => {
    try {
      const rows = await comTempo(S.api.todos(), 30000);
      if (geracao !== S.geracao) return;
      const m = new Map(rows.map(r => [r.id, r]));
      const buf = S.buffer; S.linhas = m; for (const ev of buf) aplicar(ev);
      S.carregado = true;
      agendarRender();
    } catch (e) {
      if (geracao === S.geracao) { setStatus('reconectando'); toast('Não foi possível atualizar a lista. Tentaremos novamente.', true); }
    } finally {
      if (geracao !== S.geracao) return;
      S.buffer = null; S.carregando = null;
      if (S.recarregarDepois) { S.recarregarDepois = false; carregarTudo(); }
    }
  })();
  return S.carregando;
}
async function conferir(){
  if (document.hidden || !S.perfil) return;
  await carregarTudo();
}
function aoStatus(st){
  if (st === 'SUBSCRIBED') {
    setStatus(navigator.onLine ? 'ok' : 'offline');
    if (S.conectou) carregarTudo();   // voltou a conexão: busca o que possa ter perdido
    S.conectou = true;
  } else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') {
    setStatus(navigator.onLine ? 'reconectando' : 'offline');
  }
}
function iniciarTempoReal(){
  pararTempoReal();
  S.conectou = false;
  S.cancelarOuvir = S.api.ouvir(aoMudar, aoStatus);
  carregarTudo();
  S.timerConferir = setInterval(conferir, 20000);
}
function pararTempoReal(){
  S.geracao++; S.carregando = null; S.buffer = null; S.recarregarDepois = false;
  if (S.cancelarOuvir) { try { S.cancelarOuvir(); } catch (e) {} S.cancelarOuvir = null; }
  clearInterval(S.timerConferir);
  S.linhas = new Map(); S.carregado = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.perfil) carregarTudo(); });
window.addEventListener('online', () => { if (S.perfil) { setStatus('reconectando'); carregarTudo(); } });
window.addEventListener('offline', () => { if (S.perfil) setStatus('offline'); });

/* ===================== Renderização ===================== */
let renderTimer = null, ultimoTotal = null;
function agendarRender(){ if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 60); }
function render(){
  const total = S.linhas.size;
  el.total.textContent = S.carregado ? total.toLocaleString('pt-BR') : '…';
  if (S.carregado && ultimoTotal !== null && total > ultimoTotal) {
    el.total.classList.add('pulso'); setTimeout(() => el.total.classList.remove('pulso'), 220);
  }
  if (S.carregado) ultimoTotal = total;
  if (!$('#aba-lista').hidden) renderLista();
}
function renderLista(){
  const qn = norm($('#busca-nome').value), qp = norm($('#busca-par').value);
  let arr = Array.from(S.linhas.values());
  if (qn) { const t = qn.split(/\s+/); arr = arr.filter(r => { const n = norm(r.nome); return t.every(x => n.includes(x)); }); }
  if (qp) { const t = qp.split(/\s+/); arr = arr.filter(r => { const n = norm(r.paroquia); return t.every(x => n.includes(x)); }); }
  const d = S.ordemDesc ? -1 : 1;
  arr.sort((a, b) => (a.criado_em < b.criado_em ? -d : a.criado_em > b.criado_em ? d : (a.id - b.id) * d));
  const admin = S.perfil === 'admin';
  $('#lista').classList.toggle('admin', admin);
  el.info.textContent = !S.carregado ? 'Carregando…' :
    (qn || qp) ? `${arr.length.toLocaleString('pt-BR')} encontrado(s) de ${S.linhas.size.toLocaleString('pt-BR')}` :
    `${S.linhas.size.toLocaleString('pt-BR')} participante(s)`;
  const LIM = 300, vis = arr.slice(0, LIM);
  let h = '';
  for (const r of vis) {
    h += `<div class="item">
      <div class="n">${esc(r.nome)}</div>
      <div class="c m-desk" style="white-space:nowrap">${esc(fmtTel(r.telefone))}</div>
      <div class="c m-desk">${esc(r.email)}</div>
      <div class="p">${esc(r.paroquia)}<small class="vicariato-lista">${esc(r.vicariato || 'Vicariato não informado')}</small></div>
      <div class="c m-cel">${esc(fmtTel(r.telefone))} · ${esc(r.email)}</div>
      <div class="m"><span title="${esc(fmtData(r.criado_em))}">${esc(fmtQuando(r.criado_em))}</span>${r.recepcionista ? `<span class="m-cel"> · por ${esc(r.recepcionista)}</span>` : ''}</div>
      ${admin ? `<div class="acoes"><button type="button" data-editar="${r.id}">Editar</button><button type="button" class="del" data-excluir="${r.id}">Excluir</button></div>` : ''}
    </div>`;
  }
  if (!S.carregado) h = '<div class="vazio-lista">Carregando…</div>';
  else if (!arr.length) h = `<div class="vazio-lista">${S.linhas.size ? 'Nenhum participante encontrado.' : 'Nenhum participante cadastrado ainda.'}</div>`;
  else if (arr.length > LIM) h += `<div class="mais">Mostrando ${LIM} de ${arr.length.toLocaleString('pt-BR')}. Use a pesquisa para encontrar alguém.</div>`;
  el.itens.innerHTML = h;
}
$('#busca-nome').addEventListener('input', renderLista);
$('#busca-par').addEventListener('input', renderLista);
$('#btn-ordem').addEventListener('click', () => {
  S.ordemDesc = !S.ordemDesc;
  $('#btn-ordem').textContent = S.ordemDesc ? '↓ Mais recentes primeiro' : '↑ Ordem de chegada';
  renderLista();
});

/* ===================== Abas ===================== */
document.querySelectorAll('.abas button').forEach(b => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
function trocarAba(aba){
  document.querySelectorAll('.abas button').forEach(b => b.classList.toggle('ativo', b.dataset.aba === aba));
  $('#aba-cadastro').hidden = aba !== 'cadastro';
  $('#aba-lista').hidden = aba !== 'lista';
  if (aba === 'lista') renderLista(); else el.nome.focus();
}

/* ===================== Autocompletar paróquia ===================== */
const PAR_IDX = PAROQUIAS.map(([nome, vic]) => ({ nome, vic, n: norm(nome) }));
let sugLista = [], sugSel = -1;
function buscarParoquias(q){
  const t = norm(q).split(/[\s,\-]+/).filter(Boolean);
  if (!t.length) return [];
  const res = [];
  for (const p of PAR_IDX) {
    if (!t.every(x => p.n.includes(x))) continue;
    let score = 0; for (const x of t) if (new RegExp('(^|[^a-z0-9])' + x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(p.n)) score++;
    res.push([score, p]);
  }
  res.sort((a, b) => b[0] - a[0]);
  return res.slice(0, 8).map(x => x[1]);
}
function abrirSug(){
  const q = el.par.value;
  sugLista = buscarParoquias(q);
  const exato = sugLista.length === 1 && sugLista[0].nome === q.trim();
  if (!q.trim() || exato) return fecharSug();
  sugSel = sugLista.length ? 0 : -1;
  el.sug.innerHTML = sugLista.length
    ? sugLista.map((p, i) => `<div data-i="${i}" class="${i === sugSel ? 'sel' : ''}">${esc(p.nome)}<small>${esc(p.vic)}</small></div>`).join('')
    : '<div class="vazio">Não está na lista — pode cadastrar assim mesmo.</div>';
  el.sug.hidden = false; el.par.setAttribute('aria-expanded', 'true');
}
function fecharSug(){ el.sug.hidden = true; sugLista = []; sugSel = -1; el.par.setAttribute('aria-expanded', 'false'); }
function marcarSug(){ el.sug.querySelectorAll('[data-i]').forEach(d => d.classList.toggle('sel', +d.dataset.i === sugSel)); const s = el.sug.querySelector('.sel'); if (s) s.scrollIntoView({ block: 'nearest' }); }
function escolherSug(i){ const p = sugLista[i]; if (!p) return false; el.par.value = p.nome; el.vic.value = p.vic; S.clientId = null; fecharSug(); limparErroCampo(el.par); limparErroCampo(el.vic); return true; }
el.par.addEventListener('input', abrirSug);
el.par.addEventListener('focus', () => { if (el.par.value.trim()) abrirSug(); });
el.par.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== el.par) fecharSug(); }, 150));
el.sug.addEventListener('pointerdown', e => { e.preventDefault(); const d = e.target.closest('[data-i]'); if (d) escolherSug(+d.dataset.i); });
el.par.addEventListener('keydown', e => {
  if (el.sug.hidden || !sugLista.length) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); sugSel = Math.min(sugLista.length - 1, sugSel + 1); marcarSug(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); sugSel = Math.max(0, sugSel - 1); marcarSug(); }
  else if (e.key === 'Escape') { fecharSug(); }
});
$('#dl-vicariatos').innerHTML = [...new Set(PAROQUIAS.map(p => p[1]))].sort((a,b) => a.localeCompare(b, 'pt-BR')).map(v => `<option value="${esc(v)}">`).join('');
$('#dl-paroquias').innerHTML = PAROQUIAS.map(p => `<option value="${esc(p[0])}">`).join('');

/* ===================== Formulário de cadastro ===================== */
function campoDe(input){ return input.closest('.campo'); }
function erroCampo(input, msg){ input.setAttribute('aria-invalid', 'true'); const c = campoDe(input); c.classList.add('erro'); c.querySelector('.msg').textContent = msg; }
function limparErroCampo(input){ input.removeAttribute('aria-invalid'); campoDe(input).classList.remove('erro'); }
function mostrarErroCad(msg){ el.cadErro.innerHTML = msg; el.cadErro.hidden = !msg; }

// Formata ao sair do campo (formatar durante a digitação causa falhas em alguns teclados Android)
const formatarTelAoSair = inp => inp.addEventListener('blur', () => {
  const d = telCompleto(inp.value);
  if (/^\d{10,11}$/.test(d)) inp.value = fmtTel(d);
});
formatarTelAoSair(el.tel);
CAMPOS.forEach(inp => inp.addEventListener('input', () => {
  limparErroCampo(inp);
  S.clientId = null;            // dados mudaram: é um novo envio
  if (!el.cadErro.hidden) mostrarErroCad('');
}));

// ENTER: escolhe a paróquia sugerida; se faltar campo, vai para ele; senão, cadastra
$('#form-cad').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (e.target === el.par && !el.sug.hidden && sugLista.length && sugSel >= 0) { escolherSug(sugSel); return; }
  const vazio = CAMPOS.find(c => !c.value.trim());
  if (vazio) { vazio.focus(); return; }
  enviar(false);
});
$('#form-cad').addEventListener('submit', e => { e.preventDefault(); enviar(false); });
// Manter o teclado aberto ao tocar no botão (o foco continua no campo)
el.btnCad.addEventListener('pointerdown', e => { if (CAMPOS.includes(document.activeElement)) e.preventDefault(); });

async function enviar(forcar){
  if (S.salvando) return;                       // evita envio duplo
  fecharSug();
  const { erros, dados } = validar({ nome: el.nome.value, telefone: el.tel.value, email: el.email.value, paroquia: el.par.value, vicariato: el.vic.value });
  CAMPOS.forEach(limparErroCampo);
  const ordem = [['nome', el.nome], ['telefone', el.tel], ['email', el.email], ['paroquia', el.par], ['vicariato', el.vic]];
  const primeiro = ordem.find(([k]) => erros[k]);
  if (primeiro) { ordem.forEach(([k, inp]) => erros[k] && erroCampo(inp, erros[k])); primeiro[1].focus(); return; }
  if (!navigator.onLine) { mostrarErroCad('<b>Sem internet.</b> Os dados foram mantidos — conecte-se e toque em CADASTRAR novamente.'); return; }

  if (!S.perfil) return;
  const geracao = S.geracao;
  if (!S.clientId) S.clientId = uuid();
  S.salvando = true; el.btnCad.disabled = true; el.btnCad.textContent = 'SALVANDO…';
  try {
    const res = await comTempo(S.api.cadastrar({ ...dados, recepcionista: S.recep, dispositivo: S.disp, client_id: S.clientId, forcar }));
    if (geracao !== S.geracao) return;
    if (res && res.status === 'duplicado') { avisoDuplicado(res.duplicados, dados); return; }
    if (!res || res.status !== 'ok') throw new Error('Resposta inesperada do servidor');
    const r = res.registro;
    if (r && r.id != null) { S.linhas.set(r.id, r); agendarRender(); }
    S.clientId = null;
    CAMPOS.forEach(c => { c.value = ''; limparErroCampo(c); });
    mostrarErroCad('');
    el.ultimo.textContent = `Último cadastro neste aparelho: ${dados.nome} · ${fmtHora(r && r.criado_em || new Date().toISOString())}`;
    toast('✓ Participante cadastrado com sucesso!');
    el.nome.focus();
  } catch (e) {
    if (geracao !== S.geracao) return;
    console.warn(e);
    mostrarErroCad(`<b>Não foi possível salvar.</b> ${esc(erroAmigavel(e))} Os dados foram mantidos — toque em CADASTRAR para tentar de novo.`);
  } finally {
    S.salvando = false; el.btnCad.disabled = false; el.btnCad.textContent = 'CADASTRAR';
  }
}

/* ===================== Modais ===================== */
let focoAnterior;
function abrirModal(html){
  focoAnterior = document.activeElement;
  const raiz = $('#modal-raiz');
  raiz.innerHTML = `<div class="fundo-modal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-titulo">${html}</div></div>`;
  const fundo = raiz.firstElementChild;
  const titulo = fundo.querySelector('h2'); if (titulo) titulo.id = 'modal-titulo';
  $('#tela-app').inert = true;
  fundo.querySelectorAll('.campo').forEach((c, i) => { const input = c.querySelector('input'), label = c.querySelector('label'); if (input && label) { input.id = 'modal-campo-' + i; label.htmlFor = input.id; } });
  fundo.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const itens = [...fundo.querySelectorAll('button:not(:disabled), input:not(:disabled)')];
    const primeiro = itens[0], ultimo = itens[itens.length - 1];
    if (e.shiftKey && document.activeElement === primeiro) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primeiro.focus(); }
  });
  fundo.addEventListener('click', e => { if (e.target === fundo) fecharModal(); });
  return fundo;
}
function fecharModal(){ $('#modal-raiz').innerHTML = ''; $('#tela-app').inert = false; if (focoAnterior && focoAnterior.isConnected) focoAnterior.focus(); }
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#modal-raiz').firstChild) fecharModal(); });

function avisoDuplicado(dups, dados){
  const lista = (dups || []).map(d => `<div class="dup"><b>${esc(d.nome)}</b>${esc(fmtTel(d.telefone))} · ${esc(d.email)}<br>${esc(d.paroquia)}<br><small>Cadastrado às ${esc(fmtQuando(d.criado_em))}${d.recepcionista ? ' por ' + esc(d.recepcionista) : ''}</small></div>`).join('');
  const m = abrirModal(`<h2>Possível cadastro duplicado</h2>
    <p>Já existe participante com o mesmo telefone ou e-mail:</p>${lista}
    <div class="botoes">
      <button class="btn secundario" id="dup-voltar" type="button">Voltar e conferir</button>
      <button class="btn" id="dup-forcar" type="button">Cadastrar mesmo assim</button>
    </div>`);
  $('#dup-voltar', m).onclick = () => { fecharModal(); el.nome.focus(); };
  $('#dup-forcar', m).onclick = () => { fecharModal(); el.nome.focus(); enviar(true); };
  $('#dup-voltar', m).focus();
}

el.itens.addEventListener('click', e => {
  const be = e.target.closest('[data-editar]'), bx = e.target.closest('[data-excluir]');
  if (be) editar(+be.dataset.editar);
  if (bx) confirmarExclusao(+bx.dataset.excluir);
});

function editar(id){
  if (S.perfil !== 'admin') return;
  const r = S.linhas.get(id); if (!r) return;
  const m = abrirModal(`<h2>Editar cadastro</h2>
    <form id="form-edit" novalidate>
      <div id="ed-erro" class="alerta erro" hidden></div>
      <div class="campo"><label>Nome completo</label><input name="nome" value="${esc(r.nome)}"><div class="msg"></div></div>
      <div class="campo"><label>Telefone</label><input name="telefone" type="tel" inputmode="tel" value="${esc(fmtTel(r.telefone))}"><div class="msg"></div></div>
      <div class="campo"><label>E-mail</label><input name="email" type="email" autocapitalize="off" value="${esc(r.email)}"><div class="msg"></div></div>
      <div class="campo"><label>Paróquia</label><input name="paroquia" list="dl-paroquias" value="${esc(r.paroquia)}"><div class="msg"></div></div>
      <div class="campo"><label>Vicariato</label><input name="vicariato" list="dl-vicariatos" maxlength="100" value="${esc(r.vicariato || '')}"><div class="msg"></div></div>
      <div class="botoes"><button class="btn" type="submit" id="ed-salvar">SALVAR</button><button class="btn secundario" type="button" id="ed-cancelar">Cancelar</button></div>
    </form>`);
  const f = $('#form-edit', m);
  formatarTelAoSair(f.telefone);
  $('#ed-cancelar', m).onclick = fecharModal;
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const { erros, dados } = validar({ nome: f.nome.value, telefone: f.telefone.value, email: f.email.value, paroquia: f.paroquia.value, vicariato: f.vicariato.value });
    f.querySelectorAll('.campo').forEach(c => c.classList.remove('erro'));
    let primeiro = null;
    for (const k of ['nome', 'telefone', 'email', 'paroquia', 'vicariato']) if (erros[k]) { const c = f[k].closest('.campo'); c.classList.add('erro'); c.querySelector('.msg').textContent = erros[k]; primeiro = primeiro || f[k]; }
    if (primeiro) { primeiro.focus(); return; }
    const b = $('#ed-salvar', m); b.disabled = true; b.textContent = 'SALVANDO…';
    try {
      const novo = await comTempo(S.api.atualizar(id, dados));
      S.linhas.set(novo.id, novo); agendarRender(); fecharModal(); toast('✓ Cadastro atualizado');
    } catch (err) {
      const a = $('#ed-erro', m); a.textContent = 'Não foi possível salvar: ' + erroAmigavel(err); a.hidden = false;
      b.disabled = false; b.textContent = 'SALVAR';
    }
  });
  f.nome.focus();
}

function confirmarExclusao(id){
  if (S.perfil !== 'admin') return;
  const r = S.linhas.get(id); if (!r) return;
  const m = abrirModal(`<h2>Excluir cadastro?</h2>
    <p><b style="color:var(--texto)">${esc(r.nome)}</b><br>${esc(r.paroquia)} · ${esc(fmtQuando(r.criado_em))}</p>
    <p>Esta ação não pode ser desfeita.</p>
    <div id="ex-erro" class="alerta erro" hidden></div>
    <div class="botoes"><button class="btn perigo" id="ex-sim" type="button">EXCLUIR</button><button class="btn secundario" id="ex-nao" type="button">Cancelar</button></div>`);
  $('#ex-nao', m).onclick = fecharModal;
  $('#ex-nao', m).focus();
  $('#ex-sim', m).onclick = async () => {
    const b = $('#ex-sim', m); b.disabled = true; b.textContent = 'EXCLUINDO…';
    try { await comTempo(S.api.excluir(id)); S.linhas.delete(id); agendarRender(); fecharModal(); toast('Cadastro excluído'); }
    catch (err) { const a = $('#ex-erro', m); a.textContent = 'Não foi possível excluir: ' + erroAmigavel(err); a.hidden = false; b.disabled = false; b.textContent = 'EXCLUIR'; }
  };
}

/* ===================== Exportação ===================== */
function carimbo(){ const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}h${p(d.getMinutes())}`; }
async function dadosExportacao(){
  const rows = await comTempo(S.api.todos(), 60000);     // sempre direto do banco central
  rows.sort((a, b) => (a.criado_em < b.criado_em ? -1 : a.criado_em > b.criado_em ? 1 : a.id - b.id));
  const cab = ['Nº', 'Nome', 'Telefone', 'E-mail', 'Paróquia', 'Vicariato', 'Data', 'Horário de chegada', 'Recepcionista'];
  const linhas = rows.map((r, i) => [i + 1, r.nome, fmtTel(r.telefone), r.email, r.paroquia, r.vicariato || '', fmtData(r.criado_em), fmtHora(r.criado_em), r.recepcionista || '']);
  return { rows, cab, linhas };
}
function baixar(blob, nome){
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nome;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
let xlsxCarregando = null;
function carregarXlsx(){
  if (window.XLSX) return Promise.resolve();
  if (!xlsxCarregando) xlsxCarregando = new Promise((ok, erro) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
    s.onload = ok; s.onerror = () => { xlsxCarregando = null; erro(new Error('Falha ao carregar o gerador de Excel')); };
    document.head.appendChild(s);
  });
  return xlsxCarregando;
}
function celulaCsv(v){
  let s = String(v ?? '');
  if (/^[\s]*[=+@\-]|^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
async function exportar(tipo, botao){
  if (S.perfil !== 'admin') return;
  const txt = botao.textContent; botao.disabled = true; botao.textContent = 'Gerando…';
  try {
    const [{ rows, cab, linhas }] = await Promise.all([dadosExportacao(), tipo === 'xlsx' ? carregarXlsx() : null]);
    const nome = `participantes_${carimbo()}`;
    if (tipo === 'csv') {
      const csv = '﻿' + [cab, ...linhas].map(l => l.map(celulaCsv).join(';')).join('\r\n');
      baixar(new Blob([csv], { type: 'text/csv;charset=utf-8' }), nome + '.csv');
    } else {
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas]);
      ws['!cols'] = [{ wch: 6 }, { wch: 36 }, { wch: 17 }, { wch: 32 }, { wch: 52 }, { wch: 26 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: linhas.length, c: cab.length - 1 } }) };
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      XLSX.utils.book_append_sheet(wb, ws, 'Participantes');
      const cont = new Map(); rows.forEach(r => cont.set(r.paroquia, (cont.get(r.paroquia) || 0) + 1));
      const res = [...cont.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
      const ws2 = XLSX.utils.aoa_to_sheet([['Paróquia', 'Participantes'], ...res, ['TOTAL', rows.length]]);
      ws2['!cols'] = [{ wch: 60 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Por paróquia');
      XLSX.writeFile(wb, nome + '.xlsx');
    }
    toast(`✓ Planilha gerada com ${rows.length.toLocaleString('pt-BR')} participante(s)`);
  } catch (e) {
    toast('Não foi possível exportar: ' + erroAmigavel(e), true);
  } finally { botao.disabled = false; botao.textContent = txt; }
}
$('#btn-xlsx').addEventListener('click', e => exportar('xlsx', e.currentTarget));
$('#btn-csv').addEventListener('click', e => exportar('csv', e.currentTarget));

/* ===================== Login ===================== */
let perfilEscolhido = ls.get('cred_perfil') || 'equipe';
function marcarPerfil(p){ perfilEscolhido = p === 'admin' ? 'admin' : 'equipe'; document.querySelectorAll('#login-perfil button').forEach(b => { const ativo = b.dataset.perfil === perfilEscolhido; b.classList.toggle('ativo', ativo); b.setAttribute('aria-pressed', String(ativo)); }); }
document.querySelectorAll('#login-perfil button').forEach(b => b.addEventListener('click', () => marcarPerfil(b.dataset.perfil)));
$('#login-nome').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#login-senha').focus(); } });

function perfilDoEmail(email){
  email = (email || '').toLowerCase();
  if (email === CONFIG.EMAIL_ADMIN.toLowerCase()) return 'admin';
  if (email === CONFIG.EMAIL_EQUIPE.toLowerCase()) return 'equipe';
  return null;
}
function idDispositivo(){
  let id = ls.get('cred_disp');
  if (!id) {
    const ua = navigator.userAgent;
    const plat = /iPhone|iPad/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : 'Outro';
    id = plat + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
    ls.set('cred_disp', id);
  }
  return id;
}

$('#form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const nome = limparNome($('#login-nome').value), senha = $('#login-senha').value;
  const erro = $('#login-erro'); erro.hidden = true;
  if (nome.length < 2 || nome.length > 60) { erro.textContent = 'Informe seu nome — ele fica registrado em cada cadastro que você fizer.'; erro.hidden = false; $('#login-nome').focus(); return; }
  if (!senha) { erro.textContent = 'Informe a senha.'; erro.hidden = false; $('#login-senha').focus(); return; }
  const b = $('#btn-entrar'); b.disabled = true; b.textContent = 'ENTRANDO…';
  try {
    const email = perfilEscolhido === 'admin' ? CONFIG.EMAIL_ADMIN : CONFIG.EMAIL_EQUIPE;
    const s = await comTempo(S.api.entrar(email, senha));
    ls.set('cred_nome', nome); ls.set('cred_perfil', perfilEscolhido);
    $('#login-senha').value = '';
    entrarNoApp(s.email, nome);
  } catch (err) {
    erro.textContent = erroAmigavel(err); erro.hidden = false;
  } finally { b.disabled = false; b.textContent = 'ENTRAR'; }
});

function entrarNoApp(email, nome){
  S.perfil = perfilDoEmail(email);
  if (!S.perfil) { S.api.sair(); mostrarTela('tela-login'); return; }
  S.recep = nome.slice(0, 60); S.disp = idDispositivo();
  el.quem.textContent = `${nome} · ${S.perfil === 'admin' ? 'Administrador' : 'Recepção'}`;
  $('#area-exportar').hidden = S.perfil !== 'admin';
  $('.cab-acoes').textContent = S.perfil === 'admin' ? 'AÇÕES' : '';
  mostrarTela('tela-app');
  trocarAba('cadastro');
  iniciarTempoReal();
}
function encerrarSessao(){
  pararTempoReal(); S.perfil = null; S.clientId = null; S.recep = '';
  CAMPOS.forEach(c => { c.value = ''; limparErroCampo(c); });
  el.itens.replaceChildren(); el.ultimo.textContent = ''; el.total.textContent = '…';
  mostrarErroCad(''); fecharModal(); mostrarTela('tela-login');
}
$('#btn-sair').addEventListener('click', async () => {
  if (!confirm('Sair do aplicativo neste aparelho?')) return;
  try { await S.api.sair(); } catch (e) { toast('Não foi possível encerrar a sessão. Tente novamente.', true); return; }
  encerrarSessao();
});

/* ===================== Início ===================== */
(async function iniciar(){
  document.querySelectorAll('.nome-evento').forEach(n => n.textContent = CONFIG.NOME_EVENTO);
  document.title = CONFIG.NOME_EVENTO;
  $('#login-nome').value = ls.get('cred_nome') || '';
  marcarPerfil(perfilEscolhido);
  if (window.__API_FACTORY__) {
    S.api = window.__API_FACTORY__();
  } else {
    if (/COLE_AQUI/.test(CONFIG.SUPABASE_URL + CONFIG.SUPABASE_KEY)) return mostrarTela('tela-config');
    if (!window.supabase) { mostrarTela('tela-login'); const a = $('#login-erro'); a.textContent = 'Não foi possível carregar o aplicativo. Verifique a internet e recarregue a página.'; a.hidden = false; return; }
    const sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
    });
    S.api = criarApiSupabase(sb, CONFIG);
    sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT' && S.perfil) encerrarSessao(); });
  }
  try {
    const s = await S.api.sessao();
    const nome = ls.get('cred_nome');
    if (s && nome && perfilDoEmail(s.email)) return entrarNoApp(s.email, nome);
  } catch (e) {}
  mostrarTela('tela-login');
  ($('#login-nome').value ? $('#login-senha') : $('#login-nome')).focus();
})();
