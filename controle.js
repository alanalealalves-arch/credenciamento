'use strict';
/* =====================================================================
   Estoque de casulas (por vicariato) e pertences (padres e bispos)
   Usa utilidades de app.js e a lista de check-in de checkin.js (CK).
   ===================================================================== */
const CT = (() => {
  const RESERVA = 'Reserva central';
  const st = { mov: new Map(), pert: new Map(), carregado: false, geracao: 0, cancelar: [], timer: null, carregando: null, urls: new Map(), filtroPert: 'guardados' };
  const fmt = n => Number(n).toLocaleString('pt-BR');
  const hora = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  const padres = () => (window.CK ? [...CK._estado.linhas.values()] : []);
  const visivel = id => !$('#' + id).hidden;

  /* ---------- Dados ---------- */
  function aplicar(mapa, ev){
    if (ev.tipo === 'DELETE') { if (ev.antigo && ev.antigo.id != null) mapa.delete(ev.antigo.id); }
    else if (ev.novo && ev.novo.id != null) mapa.set(ev.novo.id, ev.novo);
    agendar();
  }
  async function carregar(){
    if (!S.api || !S.perfil || !S.api.tabela) return;
    if (st.carregando) return st.carregando;
    const g = st.geracao;
    st.carregando = (async () => {
      try {
        const [mov, pert] = await Promise.all([comTempo(S.api.tabela('estoque_mov'), 30000), comTempo(S.api.tabela('pertences'), 30000)]);
        if (g !== st.geracao) return;
        st.mov = new Map(mov.map(r => [r.id, r])); st.pert = new Map(pert.map(r => [r.id, r]));
        st.carregado = true; agendar();
      } catch (e) { /* tenta de novo no próximo ciclo */ }
      finally { if (g === st.geracao) st.carregando = null; }
    })();
    return st.carregando;
  }
  function iniciar(){
    parar();
    if (!S.api || !S.api.tabela) return;
    st.cancelar = [S.api.ouvirTabela('estoque_mov', ev => aplicar(st.mov, ev)), S.api.ouvirTabela('pertences', ev => aplicar(st.pert, ev))];
    carregar();
    st.timer = setInterval(() => { if (!document.hidden) carregar(); }, 20000);
  }
  function parar(){
    st.geracao++; st.carregando = null;
    st.cancelar.forEach(c => { try { c(); } catch (e) {} }); st.cancelar = [];
    clearInterval(st.timer);
    st.mov = new Map(); st.pert = new Map(); st.carregado = false; st.urls.clear();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.perfil) carregar(); });

  /* ---------- Estoque ---------- */
  function saldos(){
    const m = new Map();
    for (const r of st.mov.values()) m.set(r.local, (m.get(r.local) || 0) + r.quantidade);
    return m;
  }
  function linhasEstoque(){
    const sal = saldos(), por = new Map();
    const pega = l => { if (!por.has(l)) por.set(l, { local: l, esperados: 0, faltam: 0, casulas: 0, entregues: 0, congresso: 0 }); return por.get(l); };
    for (const r of padres()) {
      if ((r.tipo || 'padre') !== 'padre') continue;
      const x = pega(r.vicariato); x.esperados++;
      if (r.vestimenta_em) { if (r.casula_congresso) { x.congresso++; } else x.entregues++; } else x.faltam++;
    }
    pega(RESERVA);
    for (const [l, q] of sal) pega(l).casulas = q;
    const peso = l => l === RESERVA ? 3 : /^vicariato/i.test(l) ? 0 : 1;
    return [...por.values()].map(x => ({ ...x, disp: x.casulas - x.entregues, temEstoque: sal.has(x.local) }))
      .sort((a, b) => peso(a.local) - peso(b.local) || a.local.localeCompare(b.local, 'pt-BR'));
  }
  function renderEstoque(){
    if (!visivel('aba-estoque')) return;
    const L = linhasEstoque();
    const tot = L.reduce((a, x) => ({ casulas: a.casulas + x.casulas, entregues: a.entregues + x.entregues, disp: a.disp + x.disp, faltam: a.faltam + x.faltam, congresso: a.congresso + x.congresso }), { casulas: 0, entregues: 0, disp: 0, faltam: 0, congresso: 0 });
    const admin = S.perfil === 'admin';
    $('#es-numeros').innerHTML = [['CASULAS COMUNS', tot.casulas], ['COMUNS ENTREGUES', tot.entregues], ['DISPONÍVEIS', tot.disp], ['FALTAM RECEBER', tot.faltam]]
      .map(([l, n]) => `<div class="es-num"><span>${l}</span><strong>${st.carregado ? fmt(n) : '…'}</strong></div>`).join('') +
      `<div class="es-num es-cong"><span>CASULAS CONGRESSO ENTREGUES</span><strong>${st.carregado ? fmt(tot.congresso) : '…'}</strong></div>`;
    const sit = x => {
      if (x.local === RESERVA) return `<span class="es-sit reserva">Reserva</span>`;
      if (!x.temEstoque && !x.entregues) return `<span class="es-sit neutro">Sem estoque definido</span>`;
      const d = x.disp - x.faltam;
      return d < 0 ? `<span class="es-sit falta">Pode faltar ${fmt(-d)}</span>` : `<span class="es-sit sobra">${d ? 'Sobra ' + fmt(d) : 'Na conta certa'}</span>`;
    };
    $('#es-tabela').innerHTML = `<div class="es-cab"><span>LOCAL</span><span>ESPERADOS</span><span>FALTAM RECEBER</span><span>CASULAS</span><span>ENTREGUES</span><span>DISPONÍVEIS</span><span>SITUAÇÃO</span></div>` +
      L.map(x => `<div class="es-linha${x.local === RESERVA ? ' es-reserva' : ''}">
        <span class="es-local">${esc(x.local)}${admin ? ` <button type="button" class="es-editar" data-definir="${esc(x.local)}" aria-label="Definir estoque de ${esc(x.local)}">✎</button>` : ''}</span>
        <span data-r="Esperados">${x.local === RESERVA ? '—' : fmt(x.esperados)}</span>
        <span data-r="Faltam receber">${x.local === RESERVA ? '—' : fmt(x.faltam)}</span>
        <span data-r="Casulas">${fmt(x.casulas)}</span>
        <span data-r="Entregues">${fmt(x.entregues)}</span>
        <span data-r="Disponíveis" class="es-disp${x.disp < 0 ? ' neg' : ''}">${fmt(x.disp)}</span>
        <span class="es-s">${sit(x)}</span>
      </div>`).join('');
    // Uma transferência gera duas linhas (saída e entrada): mostra só a entrada
    const hist = [...st.mov.values()].filter(m => m.tipo !== 'transferencia' || m.quantidade > 0).sort((a, b) => b.id - a.id).slice(0, 40);
    $('#es-hist').innerHTML = hist.length ? hist.map(m => `<div class="es-h"><b>${hora(m.criado_em)}</b> ${
      m.tipo === 'transferencia'
        ? `${fmt(m.quantidade)} casula${m.quantidade > 1 ? 's' : ''}: ${esc(m.contraparte || '')} → ${esc(m.local)}`
        : `Estoque de ${esc(m.local)} ${m.quantidade > 0 ? '+' : ''}${fmt(m.quantidade)}`
    } <small>${esc(m.por || '')}</small></div>`).join('') : '<div class="vazio-lista">Nenhuma movimentação ainda.</div>';
    $('#es-definir-novo').hidden = !admin;
  }
  function opcoesLocais(sel){
    return linhasEstoque().map(x => `<option value="${esc(x.local)}"${x.local === sel ? ' selected' : ''}>${esc(x.local)} — ${fmt(x.disp)} disponíveis</option>`).join('');
  }
  $('#es-transferir').addEventListener('click', () => {
    const m = abrirModal(`<h2>Transferir casulas</h2>
      <form id="es-form-tr" novalidate>
        <div id="es-tr-erro" class="alerta erro" hidden></div>
        <div class="campo"><label for="es-tr-de">De</label><select id="es-tr-de" name="de"><option value="">Escolha…</option>${opcoesLocais()}</select></div>
        <div class="campo"><label for="es-tr-para">Para</label><select id="es-tr-para" name="para"><option value="">Escolha…</option>${opcoesLocais()}</select></div>
        <div class="campo"><label for="es-tr-qtd">Quantidade</label><input id="es-tr-qtd" name="qtd" type="number" inputmode="numeric" min="1" max="999" value="1"></div>
        <div class="botoes"><button class="btn" type="submit" id="es-tr-ok">TRANSFERIR</button><button class="btn secundario" type="button" id="es-tr-cancelar">Cancelar</button></div>
      </form>`);
    $('#es-tr-cancelar', m).onclick = fecharModal;
    const f = $('#es-form-tr', m);
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const erro = $('#es-tr-erro', m), qtd = parseInt(f.qtd.value, 10), b = $('#es-tr-ok', m);
      const falhar = t => { erro.textContent = t; erro.hidden = false; };
      if (!f.de.value || !f.para.value) return falhar('Escolha de onde e para onde.');
      if (f.de.value === f.para.value) return falhar('Escolha locais diferentes.');
      if (!(qtd >= 1)) return falhar('Informe a quantidade.');
      b.disabled = true; b.textContent = 'TRANSFERINDO…';
      try {
        const r = await comTempo(S.api.rpc('transferir_estoque', { p_origem: f.de.value, p_destino: f.para.value, p_quantidade: qtd, p_recepcionista: S.recep }));
        if (r.status === 'insuficiente') { falhar(`${f.de.value} só tem ${fmt(r.disponiveis)} disponíveis.`); return; }
        fecharModal(); toast(`✓ ${fmt(qtd)} casula${qtd > 1 ? 's' : ''}: ${f.de.value} → ${f.para.value}`); carregar();
      } catch (e) { falhar('Não foi possível transferir: ' + erroAmigavel(e)); }
      finally { if (b.isConnected) { b.disabled = false; b.textContent = 'TRANSFERIR'; } }
    });
  });
  function definir(local){
    if (S.perfil !== 'admin') return;
    const x = linhasEstoque().find(l => l.local === local);
    const m = abrirModal(`<h2>Estoque ${local ? 'de ' + esc(local) : ''}</h2>
      <p>Quantas casulas este local recebeu no total (incluindo as já entregues)? ${x && x.entregues ? `Já foram entregues <b>${fmt(x.entregues)}</b>.` : ''}</p>
      <form id="es-form-def" novalidate>
        <div id="es-def-erro" class="alerta erro" hidden></div>
        ${local ? '' : `<div class="campo"><label for="es-def-local">Local</label><input id="es-def-local" name="local" maxlength="100" list="es-locais"><datalist id="es-locais">${linhasEstoque().map(l => `<option value="${esc(l.local)}">`).join('')}</datalist></div>`}
        <div class="campo"><label for="es-def-qtd">Total de casulas</label><input id="es-def-qtd" name="qtd" type="number" inputmode="numeric" min="0" max="9999" value="${x ? x.casulas : 0}"></div>
        <div class="botoes"><button class="btn" type="submit" id="es-def-ok">SALVAR</button><button class="btn secundario" type="button" id="es-def-cancelar">Cancelar</button></div>
      </form>`);
    $('#es-def-cancelar', m).onclick = fecharModal;
    const f = $('#es-form-def', m);
    (f.local || f.qtd).focus(); if (!f.local) f.qtd.select();
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const erro = $('#es-def-erro', m), q = parseInt(f.qtd.value, 10), loc = local || limparNome(f.local.value);
      if (!loc || loc.length < 2) { erro.textContent = 'Informe o local.'; erro.hidden = false; return; }
      if (!(q >= 0)) { erro.textContent = 'Informe a quantidade.'; erro.hidden = false; return; }
      try {
        await comTempo(S.api.rpc('definir_estoque', { p_local: loc, p_quantidade: q, p_recepcionista: S.recep }));
        fecharModal(); toast(`✓ Estoque de ${loc}: ${fmt(q)}`); carregar();
      } catch (e) { erro.textContent = 'Não foi possível salvar: ' + erroAmigavel(e); erro.hidden = false; }
    });
  }
  $('#es-tabela').addEventListener('click', e => { const b = e.target.closest('[data-definir]'); if (b) definir(b.dataset.definir); });
  $('#es-definir-novo').addEventListener('click', () => definir(''));

  // Chamado pelo check-in depois de entregar uma vestimenta
  function avisarEstoque(padre){
    if (!padre || (padre.tipo || 'padre') !== 'padre') return;
    const x = linhasEstoque().find(l => l.local === padre.vicariato);
    if (x && x.temEstoque && x.disp < 0) toast(`Atenção: ${x.local} está sem casulas no estoque (${fmt(x.disp)}). Transfira na aba ESTOQUE.`, true);
  }

  /* ---------- Pertences ---------- */
  const dePadre = id => [...st.pert.values()].filter(p => p.padre_id === id).sort((a, b) => a.id - b.id);
  const guardadosDe = id => dePadre(id).filter(p => !p.devolvido_em).length;
  async function url(caminho){
    const c = st.urls.get(caminho);
    if (c && c.ate > Date.now()) return c.url;
    const u = await S.api.urlFoto(caminho);
    st.urls.set(caminho, { url: u, ate: Date.now() + 50 * 60000 });
    return u;
  }
  function preencherFotos(raiz){
    raiz.querySelectorAll('img[data-foto]').forEach(async img => {
      try { img.src = await url(img.dataset.foto); } catch (e) { img.alt = 'Foto indisponível'; }
    });
  }
  function itemPertence(p, comNome){
    const r = window.CK && CK._estado.linhas.get(p.padre_id);
    return `<div class="pt-item${p.devolvido_em ? ' devolvido' : ''}">
      ${p.foto ? `<button type="button" class="pt-thumb" data-ver="${esc(p.foto)}"><img data-foto="${esc(p.foto)}" alt="Foto do pertence"></button>` : '<div class="pt-thumb vazio">sem foto</div>'}
      <div class="pt-dados">
        ${comNome && r ? `<b>${esc(r.nome)}</b><small>${esc(r.vicariato)}</small>` : ''}
        <span class="pt-desc">${p.etiqueta ? `<span class="pt-etq">Nº ${esc(p.etiqueta)}</span> ` : ''}${esc(p.descricao)}</span>
        <small>Recebido ${esc(hora(p.recebido_em))}${p.recebido_por ? ' por ' + esc(p.recebido_por) : ''}${p.devolvido_em ? ` · <b>Devolvido ${esc(hora(p.devolvido_em))}${p.devolvido_por ? ' por ' + esc(p.devolvido_por) : ''}</b>` : ''}</small>
      </div>
      <button type="button" class="ck-btn ${p.devolvido_em ? 'on' : ''} pt-dev" data-devolver="${p.id}">${p.devolvido_em ? '✓ Devolvido' : 'Devolver'}</button>
    </div>`;
  }
  async function devolver(id, voltar){
    const p = st.pert.get(id); if (!p) return;
    const r = window.CK && CK._estado.linhas.get(p.padre_id);
    const desfazer = !!p.devolvido_em;
    const m = abrirModal(`<h2>${desfazer ? 'Tem certeza que quer desfazer a devolução?' : 'Confirmar devolução?'}</h2>
      <p>${p.etiqueta ? `<b>Nº ${esc(p.etiqueta)}</b> · ` : ''}${esc(p.descricao)}${r ? `<br>de <b>${esc(r.nome)}</b>` : ''}</p>
      ${p.foto ? `<img class="pt-grande" data-foto="${esc(p.foto)}" alt="Foto do pertence">` : ''}
      <div class="botoes"><button class="btn${desfazer ? ' perigo' : ''}" id="pt-dev-ok" type="button" disabled>${desfazer ? 'SIM, DESFAZER DEVOLUÇÃO' : 'CONFIRMAR DEVOLUÇÃO'}</button><button class="btn secundario" id="pt-dev-cancelar" type="button">${desfazer ? 'Não, manter' : 'Cancelar'}</button></div>`);
    preencherFotos(m);
    setTimeout(() => { const b = $('#pt-dev-ok', m); if (b && b.isConnected) b.disabled = false; }, 1000); // evita toque duplo
    const sair = () => { fecharModal(); if (voltar) abrirPertences(voltar); };
    $('#pt-dev-cancelar', m).onclick = sair;
    $('#pt-dev-ok', m).onclick = async () => {
      const b = $('#pt-dev-ok', m); b.disabled = true;
      try {
        const res = await comTempo(S.api.rpc('devolver_pertence', { p_id: id, p_valor: !desfazer, p_recepcionista: S.recep }));
        if (res.registro) st.pert.set(res.registro.id, res.registro);
        sair();
        toast(res.status === 'ja' ? `Já tinha sido devolvido às ${hora(res.registro.devolvido_em)}${res.registro.devolvido_por ? ' por ' + res.registro.devolvido_por : ''}` : desfazer ? 'Devolução desfeita' : '✓ Pertence devolvido');
        agendar();
      } catch (e) { b.disabled = false; toast('Não foi possível salvar: ' + erroAmigavel(e), true); }
    };
  }
  async function comprimir(arquivo){
    const img = await new Promise((ok, erro) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => erro(new Error('Imagem inválida')); i.src = URL.createObjectURL(arquivo); });
    const max = 1280, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return await new Promise((ok, erro) => c.toBlob(b => b ? ok(b) : erro(new Error('Falha ao comprimir')), 'image/jpeg', 0.72));
  }
  function abrirPertences(padreId){
    const r = window.CK && CK._estado.linhas.get(padreId); if (!r) return;
    const m = abrirModal(`<h2>Pertences</h2><p><b>${esc(r.nome)}</b><br><small>${esc(r.vicariato)}</small></p>
      <div id="pt-lista-modal"></div>
      <form id="pt-form" novalidate>
        <h3 class="pt-sub">Receber pertence</h3>
        <div id="pt-erro" class="alerta erro" hidden></div>
        <div class="campo"><label for="pt-desc">O que é</label><input id="pt-desc" name="desc" maxlength="300" placeholder="Ex.: mochila preta, chave do carro"></div>
        <div class="campo"><label for="pt-etq">Nº da etiqueta (opcional)</label><input id="pt-etq" name="etq" maxlength="30" inputmode="numeric"></div>
        <div class="campo"><label>Foto (opcional)</label>
          <label class="pt-foto-btn"><input id="pt-foto" name="foto" type="file" accept="image/*" capture="environment" hidden><span id="pt-foto-txt">📷 Tirar foto</span></label>
          <img id="pt-prev" class="pt-grande" hidden alt="Prévia da foto">
        </div>
        <div class="botoes"><button class="btn" type="submit" id="pt-salvar">GUARDAR PERTENCE</button><button class="btn secundario" type="button" id="pt-fechar">Fechar</button></div>
      </form>`);
    const lista = $('#pt-lista-modal', m);
    const desenhar = () => { const it = dePadre(padreId); lista.innerHTML = it.length ? it.map(p => itemPertence(p, false)).join('') : '<p class="pt-nada">Nenhum pertence guardado.</p>'; preencherFotos(lista); };
    desenhar();
    lista.addEventListener('click', e => { const b = e.target.closest('[data-devolver]'); if (b) devolver(+b.dataset.devolver, padreId); const v = e.target.closest('[data-ver]'); if (v) verFoto(v.dataset.ver, padreId); });
    $('#pt-fechar', m).onclick = fecharModal;
    const f = $('#pt-form', m); let blob = null;
    f.foto.addEventListener('change', async () => {
      const a = f.foto.files && f.foto.files[0]; if (!a) return;
      $('#pt-foto-txt', m).textContent = 'Preparando foto…';
      try { blob = await comprimir(a); const p = $('#pt-prev', m); p.src = URL.createObjectURL(blob); p.hidden = false; $('#pt-foto-txt', m).textContent = `📷 Trocar foto (${Math.round(blob.size / 1024)} KB)`; }
      catch (e) { blob = null; $('#pt-foto-txt', m).textContent = '📷 Tirar foto'; toast('Não foi possível usar essa foto.', true); }
    });
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const erro = $('#pt-erro', m), b = $('#pt-salvar', m);
      const desc = limparNome(f.desc.value);
      if (desc.length < 2) { erro.textContent = 'Descreva o pertence.'; erro.hidden = false; f.desc.focus(); return; }
      erro.hidden = true; b.disabled = true; b.textContent = blob ? 'ENVIANDO FOTO…' : 'SALVANDO…';
      try {
        const caminho = blob ? await comTempo(S.api.enviarFoto(blob, padreId), 60000) : null;
        b.textContent = 'SALVANDO…';
        const res = await comTempo(S.api.rpc('guardar_pertence', { p_padre_id: padreId, p_descricao: desc, p_etiqueta: limparNome(f.etq.value), p_foto: caminho, p_recepcionista: S.recep }));
        if (res.registro) st.pert.set(res.registro.id, res.registro);
        toast('✓ Pertence guardado');
        f.reset(); blob = null; $('#pt-prev', m).hidden = true; $('#pt-foto-txt', m).textContent = '📷 Tirar foto';
        desenhar(); agendar();
      } catch (e) { erro.textContent = 'Não foi possível guardar: ' + erroAmigavel(e); erro.hidden = false; }
      finally { if (b.isConnected) { b.disabled = false; b.textContent = 'GUARDAR PERTENCE'; } }
    });
    st.modalPadre = { id: padreId, desenhar, m };
  }
  function verFoto(caminho, voltar){
    const m = abrirModal(`<img class="pt-grande" data-foto="${esc(caminho)}" alt="Foto do pertence"><div class="botoes"><button class="btn secundario" id="pt-ver-fechar" type="button">Voltar</button></div>`);
    preencherFotos(m); $('#pt-ver-fechar', m).onclick = () => { fecharModal(); if (voltar) abrirPertences(voltar); };
  }
  function renderPertences(){
    if (!visivel('aba-pertences')) return;
    const todos = [...st.pert.values()];
    const g = todos.filter(p => !p.devolvido_em).length;
    $('#pt-resumo').textContent = st.carregado ? `Guardados: ${fmt(g)} · Devolvidos: ${fmt(todos.length - g)}` : 'Carregando…';
    const q = norm($('#pt-busca').value).split(/\s+/).filter(Boolean);
    let arr = todos;
    if (st.filtroPert === 'guardados') arr = arr.filter(p => !p.devolvido_em);
    else if (st.filtroPert === 'devolvidos') arr = arr.filter(p => p.devolvido_em);
    if (q.length) arr = arr.filter(p => { const r = CK._estado.linhas.get(p.padre_id); const t = norm([r && r.nome, r && r.vicariato, p.etiqueta, p.descricao].join(' ')); return q.every(x => t.includes(x)); });
    arr.sort((a, b) => b.id - a.id);
    const box = $('#pt-itens');
    box.innerHTML = arr.length ? arr.slice(0, 300).map(p => itemPertence(p, true)).join('') : `<div class="vazio-lista">${todos.length ? 'Nada encontrado.' : 'Nenhum pertence recebido ainda. Use o botão “Pertences” no cartão do padre ou do bispo.'}</div>`;
    preencherFotos(box);
  }
  $('#pt-itens').addEventListener('click', e => { const b = e.target.closest('[data-devolver]'); if (b) devolver(+b.dataset.devolver); const v = e.target.closest('[data-ver]'); if (v) verFoto(v.dataset.ver); });
  $('#pt-busca').addEventListener('input', renderPertences);
  document.querySelectorAll('[data-ptfiltro]').forEach(b => b.addEventListener('click', () => {
    st.filtroPert = b.dataset.ptfiltro;
    document.querySelectorAll('[data-ptfiltro]').forEach(x => { x.classList.toggle('ativo', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    renderPertences();
  }));

  /* ---------- Renderização ---------- */
  let timerR = null;
  function agendar(){ if (!timerR) timerR = setTimeout(() => { timerR = null; render(); }, 80); }
  function render(){
    renderEstoque(); renderPertences();
    if (st.modalPadre && st.modalPadre.m.isConnected) st.modalPadre.desenhar();
    if (window.CK && !$('#aba-checkin').hidden) CK.renderSoLista();
  }
  function aoMostrar(){ render(); }

  return { iniciar, parar, aoMostrar, render: agendar, avisarEstoque, abrirPertences, guardadosDe, _estado: st };
})();
window.CT = CT;
if (S.perfil && !$('#tela-app').hidden) CT.iniciar();
