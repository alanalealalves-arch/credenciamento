'use strict';
/* =====================================================================
   Check-in de padres e bispos
   Fluxo: 1) vicariato  2) nome  3) vestimenta entregue ao padre ou a terceiro
   Usa utilidades e estado globais de app.js ($, esc, norm, S, toast,
   abrirModal, fecharModal, comTempo, erroAmigavel, carregarXlsx, carimbo).
   ===================================================================== */
const CK = (() => {
  const st = {
    linhas: new Map(), carregado: false, carregando: null, recarregar: false, buffer: null,
    geracao: 0, cancelar: null, timer: null, filtro: 'todos', salvando: new Set(), conectou: false,
    tipo: 'padre'
  };
  const TIPOS = {
    padres:   { tipo: 'padre',   um: 'padre',   varios: 'padres',   vic: true },
    diaconos: { tipo: 'diacono', um: 'diácono', varios: 'diáconos', vic: true },
    bispos:   { tipo: 'bispo',   um: 'bispo',   varios: 'bispos',   vic: false }
  };
  const tipoAtual = () => Object.values(TIPOS).find(x => x.tipo === st.tipo);
  const doTipo = r => (r.tipo || 'padre') === st.tipo;
  const linhasTipo = () => [...st.linhas.values()].filter(doTipo);
  const ui = {
    vic: $('#ck-vic'), nome: $('#ck-nome'), itens: $('#ck-itens'), info: $('#ck-info'), resumo: $('#ck-resumo'),
    esperados: $('#ck-esperados'), entregues: $('#ck-entregues'), faltam: $('#ck-faltam'), terceiros: $('#ck-terceiros')
  };
  const LIMITE = 250;
  const fmt = n => Number(n).toLocaleString('pt-BR');
  const hora = iso => iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '';
  const semTitulo = n => norm(n).replace(/^(pe|padre|frei|fr|mons|monsenhor|dom|con|conego|diac|diacono)\.?\s+/, '');
  const doVicariato = (r, v) => !v || r.vicariato === v || r.vicariato2 === v;

  /* ---------- Dados ---------- */
  function aplicar(ev){
    if (ev.tipo === 'DELETE') { if (ev.antigo && ev.antigo.id != null) st.linhas.delete(ev.antigo.id); }
    else if (ev.novo && ev.novo.id != null) st.linhas.set(ev.novo.id, ev.novo);
  }
  function aoMudar(ev){ if (st.buffer) st.buffer.push(ev); aplicar(ev); agendar(); }
  async function carregar(){
    if (!S.api || !S.perfil || !S.api.padres) return;
    if (st.carregando) { st.recarregar = true; return st.carregando; }
    const geracao = st.geracao;
    st.buffer = [];
    st.carregando = (async () => {
      try {
        const rows = await comTempo(S.api.padres(), 30000);
        if (geracao !== st.geracao) return;
        const m = new Map(rows.map(r => [r.id, r]));
        const buf = st.buffer; st.linhas = m; for (const ev of buf) aplicar(ev);
        st.carregado = true; agendar();
      } catch (e) {
        if (geracao === st.geracao && !st.carregado) ui.info.textContent = 'Não foi possível carregar a lista. Tentando de novo…';
      } finally {
        if (geracao !== st.geracao) return;
        st.buffer = null; st.carregando = null;
        if (st.recarregar) { st.recarregar = false; carregar(); }
      }
    })();
    return st.carregando;
  }
  function iniciar(){
    parar();
    if (!S.api || !S.api.padres) return;
    st.conectou = false;
    st.cancelar = S.api.ouvirPadres(aoMudar, s => {
      if (s === 'SUBSCRIBED') { if (st.conectou) carregar(); st.conectou = true; }
    });
    carregar();
    st.timer = setInterval(() => { if (!document.hidden) carregar(); }, 20000);
  }
  function parar(){
    st.geracao++; st.carregando = null; st.buffer = null; st.recarregar = false;
    if (st.cancelar) { try { st.cancelar(); } catch (e) {} st.cancelar = null; }
    clearInterval(st.timer);
    st.linhas = new Map(); st.carregado = false; st.salvando.clear();
    ui.itens.replaceChildren(); ui.resumo.replaceChildren(); ui.nome.value = ''; ui.vic.value = '';
    for (const k of ['esperados', 'entregues', 'faltam', 'terceiros']) ui[k].textContent = '…';
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.perfil) carregar(); });
  window.addEventListener('online', () => { if (S.perfil) carregar(); });

  /* ---------- Contagens ---------- */
  function contar(arr){
    let vest = 0, terc = 0;
    for (const r of arr) if (r.vestimenta_em) { vest++; if (r.vestimenta_para === 'terceiro') terc++; }
    return { esperados: arr.length, vest, faltam: arr.length - vest, terc };
  }
  function grupos(){
    const m = new Map();
    for (const r of linhasTipo()) for (const v of [r.vicariato, r.vicariato2]) {
      if (!v) continue;
      if (!m.has(v)) m.set(v, []);
      m.get(v).push(r);
    }
    const peso = v => /^vicariato/i.test(v) ? 0 : /^bispo/i.test(v) ? 2 : 1;
    return [...m.entries()].sort((a, b) => peso(a[0]) - peso(b[0]) || a[0].localeCompare(b[0], 'pt-BR'));
  }

  /* ---------- Renderização ---------- */
  let timerRender = null;
  function agendar(){ if (!timerRender) timerRender = setTimeout(() => { timerRender = null; render(); }, 60); }
  function render(){
    const c = contar(linhasTipo());
    ui.esperados.textContent = st.carregado ? fmt(c.esperados) : '…';
    ui.entregues.textContent = st.carregado ? fmt(c.vest) : '…';
    ui.faltam.textContent = st.carregado ? fmt(c.faltam) : '…';
    ui.terceiros.textContent = st.carregado ? fmt(c.terc) : '…';
    renderSelect();
    if (window.CT) CT.render();
    if ($('#aba-checkin').hidden) return;
    renderLista();
  }
  function renderSelect(){
    const atual = ui.vic.value;
    const g = grupos();
    const html = '<option value="">Todos os vicariatos</option>' + g.map(([v, arr]) => {
      const c = contar(arr);
      return `<option value="${esc(v)}">${esc(v)} — faltam ${fmt(c.faltam)} de ${fmt(c.esperados)}</option>`;
    }).join('');
    if (ui.vic.dataset.html !== html) {
      ui.vic.innerHTML = html; ui.vic.dataset.html = html;
      ui.vic.value = g.some(([v]) => v === atual) ? atual : '';
    }
  }
  function filtrar(){
    const v = ui.vic.value, q = norm(ui.nome.value).split(/\s+/).filter(Boolean);
    const v2 = tipoAtual().vic ? v : '';
    let arr = linhasTipo().filter(r => doVicariato(r, v2));
    const base = arr;
    if (q.length) arr = arr.filter(r => { const n = norm(r.nome + ' ' + (r.paroquia || '')); return q.every(x => n.includes(x)); });
    if (st.filtro === 'faltam') arr = arr.filter(r => !r.vestimenta_em);
    else if (st.filtro === 'entregues') arr = arr.filter(r => r.vestimenta_em);
    else if (st.filtro === 'terceiros') arr = arr.filter(r => r.vestimenta_em && r.vestimenta_para === 'terceiro');
    arr.sort((a, b) => semTitulo(a.nome).localeCompare(semTitulo(b.nome), 'pt-BR'));
    return { arr, base, v: v2, q };
  }
  function renderLista(){
    if (!st.carregado) { ui.info.textContent = 'Carregando a lista…'; ui.itens.innerHTML = '<div class="vazio-lista">Carregando…</div>'; ui.resumo.replaceChildren(); return; }
    const T = tipoAtual();
    if (!linhasTipo().length) { ui.info.textContent = ''; ui.resumo.replaceChildren(); ui.itens.innerHTML = `<div class="vazio-lista">Ainda não há ${T.varios} na lista.<br>Quem chegar pode ser incluído em <b>+ Não está na lista</b>.</div>`; return; }
    const { arr, base, v, q } = filtrar();
    const cv = contar(base);
    ui.info.textContent = v
      ? `${v}: entregues ${fmt(cv.vest)} de ${fmt(cv.esperados)} · faltam ${fmt(cv.faltam)}`
      : `Entregues ${fmt(cv.vest)} de ${fmt(cv.esperados)} · faltam ${fmt(cv.faltam)}`;

    // Sem vicariato, sem nome e sem filtro: mostra o painel por vicariato
    if (T.vic && !v && !q.length && st.filtro === 'todos') {
      ui.itens.innerHTML = '<div class="vazio-lista">Escolha o vicariato ou digite o nome para fazer o check-in.</div>';
      ui.resumo.innerHTML = `<div class="ck-resumo"><div class="ck-resumo-cab"><span>VICARIATO</span><span>ESPERADOS</span><span>ENTREGUES</span><span>FALTAM</span><span>A TERCEIROS</span></div>` +
        grupos().map(([g, a]) => { const c = contar(a); return `<button type="button" class="ck-resumo-linha${c.faltam ? '' : ' completo'}" data-vic="${esc(g)}"><span class="ck-rv">${esc(g)}</span><span data-r="Esperados">${fmt(c.esperados)}</span><span data-r="Entregues">${fmt(c.vest)}</span><span data-r="Faltam" class="ck-rf">${fmt(c.faltam)}</span><span data-r="A terceiros">${fmt(c.terc)}</span></button>`; }).join('') + '</div>';
      return;
    }
    ui.resumo.replaceChildren();
    if (!arr.length) {
      ui.itens.innerHTML = `<div class="vazio-lista">${q.length ? 'Ninguém encontrado com esse nome' + (v ? ' neste vicariato' : '') + '.' : 'Ninguém nesta situação.'}</div>`;
      return;
    }
    const vis = arr.slice(0, LIMITE);
    let h = '';
    for (const r of vis) {
      const sVes = st.salvando.has(r.id + ':vestimenta');
      const terc = r.vestimenta_para === 'terceiro';
      const det = [r.funcao, r.paroquia].filter(Boolean).join(' · ');
      const vics = [r.vicariato, r.vicariato2].filter(Boolean).join(' · ');
      h += `<div class="ck-item${r.vestimenta_em ? (terc ? ' vestido' : ' chegou') : ''}">
        <div class="ck-dados">
          <b>${esc(r.nome)}</b>
          ${det ? `<small>${esc(det)}</small>` : ''}
          ${!v && T.vic ? `<small class="ck-vic-item">${esc(vics)}</small>` : ''}
          ${r.mitra ? `<span class="ck-tag">Mitra ${esc(r.mitra)}</span>` : ''}
          ${r.incluido_na_hora ? `<span class="ck-tag aviso">Incluído na hora${r.incluido_por ? ' por ' + esc(r.incluido_por) : ''}</span>` : ''}
        </div>
        <div class="ck-botoes">
          ${sVes ? `<button type="button" class="ck-btn ck-largo" disabled>Salvando…</button>`
            : r.vestimenta_em
              ? `<button type="button" class="ck-btn ck-largo on ${terc ? 'terc' : 'padre'}" data-desfazer="${r.id}">
                   ✓ ${terc ? `Entregue a terceiro: <b>${esc(r.vestimenta_terceiro || '')}</b>` : 'Entregue ao padre'}
                   <small>${esc(hora(r.vestimenta_em))}${r.vestimenta_por ? ' · ' + esc(r.vestimenta_por) : ''}${r.vestimenta_obs ? ' · ' + esc(r.vestimenta_obs) : ''}</small>
                 </button>`
              : `<button type="button" class="ck-btn chegada" data-entregar="padre" data-id="${r.id}">Entregue ao padre</button>
                 <button type="button" class="ck-btn vest" data-entregar="terceiro" data-id="${r.id}">Entregue a terceiro</button>`}
          ${window.CT ? (() => { const n = CT.guardadosDe(r.id); return `<button type="button" class="ck-pert${n ? ' tem' : ''}" data-pertences="${r.id}">🎒 Pertences${n ? ` · ${n} guardado${n > 1 ? 's' : ''}` : ''}</button>`; })() : ''}
        </div>
      </div>`;
    }
    if (arr.length > LIMITE) h += `<div class="mais">Mostrando ${LIMITE} de ${fmt(arr.length)}. Escolha o vicariato ou digite o nome.</div>`;
    ui.itens.innerHTML = h;
  }

  /* ---------- Filtros ---------- */
  function definirFiltro(f){
    st.filtro = f;
    document.querySelectorAll('.ck-filtros [data-ckfiltro]').forEach(b => { const a = b.dataset.ckfiltro === f; b.classList.toggle('ativo', a); b.setAttribute('aria-pressed', String(a)); });
    renderLista();
  }
  document.querySelectorAll('[data-ckfiltro]').forEach(b => b.addEventListener('click', () => {
    if ($('#aba-checkin').hidden) return;
    definirFiltro(b.dataset.ckfiltro);
  }));
  ui.vic.addEventListener('change', () => { renderLista(); ui.nome.focus(); });
  ui.nome.addEventListener('input', renderLista);
  ui.resumo.addEventListener('click', e => {
    const b = e.target.closest('[data-vic]'); if (!b) return;
    ui.vic.value = b.dataset.vic; renderLista(); ui.nome.focus();
  });

  /* ---------- Entregar / desfazer vestimenta ---------- */
  async function entregar(id, valor, para, terceiro, obs){
    const chave = id + ':vestimenta';
    if (st.salvando.has(chave) || !S.perfil) return false;
    const geracao = st.geracao;
    st.salvando.add(chave); renderLista();
    try {
      const res = await comTempo(S.api.rpc('entregar_vestimenta', { p_id: id, p_valor: valor, p_para: para || null, p_terceiro: terceiro || null, p_obs: obs || null, p_recepcionista: S.recep }));
      if (geracao !== st.geracao) return false;
      const r = res && res.registro;
      if (r && r.id != null) st.linhas.set(r.id, r);
      if (res && res.status === 'ja') {
        toast(`Já tinha sido entregue às ${hora(r.vestimenta_em)}${r.vestimenta_por ? ' por ' + r.vestimenta_por : ''}${r.vestimenta_para === 'terceiro' ? ' (a ' + (r.vestimenta_terceiro || 'terceiro') + ')' : ''}`);
      } else if (valor) {
        toast(para === 'terceiro' ? `✓ Vestimenta de ${r.nome} entregue a ${r.vestimenta_terceiro}` : `✓ Vestimenta entregue: ${r.nome}`);
        if (window.CT) setTimeout(() => CT.avisarEstoque(r), 1800);
      } else toast('Entrega desfeita');
      return true;
    } catch (e) {
      if (geracao === st.geracao) toast('Não foi possível salvar: ' + erroAmigavel(e), true);
      return false;
    } finally {
      if (geracao === st.geracao) { st.salvando.delete(chave); render(); }
    }
  }
  function aTerceiro(r){
    const m = abrirModal(`<h2>Entregue a terceiro</h2><p>Vestimenta de <b>${esc(r.nome)}</b></p>
      <form id="ck-form-terc" novalidate>
        <div id="ck-terc-erro" class="alerta erro" hidden></div>
        <div class="campo"><label>Nome de quem retirou</label><input name="quem" maxlength="150" autocapitalize="words"></div>
        <div class="campo"><label>Observação (opcional)</label><input name="obs" maxlength="300" placeholder="Ex.: motorista do padre, telefone…"></div>
        <div class="botoes"><button class="btn" type="submit" id="ck-terc-ok">CONFIRMAR ENTREGA</button><button class="btn secundario" type="button" id="ck-terc-cancelar">Cancelar</button></div>
      </form>`);
    const f = $('#ck-form-terc', m);
    $('#ck-terc-cancelar', m).onclick = fecharModal;
    f.quem.focus();
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const quem = limparNome(f.quem.value), erro = $('#ck-terc-erro', m);
      if (quem.length < 2) { erro.textContent = 'Informe o nome de quem retirou.'; erro.hidden = false; f.quem.focus(); return; }
      fecharModal();
      await entregar(r.id, true, 'terceiro', quem, limparNome(f.obs.value));
    });
  }
  function confirmarDesfazer(r){
    const terc = r.vestimenta_para === 'terceiro';
    const m = abrirModal(`<h2>Desfazer entrega?</h2>
      <p>Vestimenta de <b>${esc(r.nome)}</b> entregue ${terc ? `a <b>${esc(r.vestimenta_terceiro || '')}</b>` : 'ao padre'} às ${esc(hora(r.vestimenta_em))}${r.vestimenta_por ? ' por ' + esc(r.vestimenta_por) : ''}.${r.vestimenta_obs ? `<br><small>Obs.: ${esc(r.vestimenta_obs)}</small>` : ''}</p>
      <div class="botoes"><button class="btn perigo" id="ck-desfazer" type="button">DESFAZER ENTREGA</button><button class="btn secundario" id="ck-manter" type="button">Manter como está</button></div>`);
    $('#ck-manter', m).onclick = fecharModal;
    $('#ck-manter', m).focus();
    $('#ck-desfazer', m).onclick = () => { fecharModal(); entregar(r.id, false); };
  }
  ui.itens.addEventListener('click', e => {
    const pb = e.target.closest('[data-pertences]'); if (pb) { if (window.CT) CT.abrirPertences(+pb.dataset.pertences); return; }
    const d = e.target.closest('[data-desfazer]');
    if (d) { const r = st.linhas.get(+d.dataset.desfazer); if (r) confirmarDesfazer(r); return; }
    const b = e.target.closest('[data-entregar]'); if (!b || b.disabled) return;
    const r = st.linhas.get(+b.dataset.id); if (!r) return;
    if (r.vestimenta_em) { confirmarDesfazer(r); return; }
    if (b.dataset.entregar === 'terceiro') aTerceiro(r); else entregar(r.id, true, 'padre');
  });

  /* ---------- Incluir quem não está na lista ---------- */
  $('#ck-incluir').addEventListener('click', () => incluir());
  function incluir(){
    const T = tipoAtual();
    const nomesVic = new Set([...st.linhas.values()].filter(r => r.tipo !== 'bispo').flatMap(r => [r.vicariato, r.vicariato2]).filter(Boolean));
    (typeof PAROQUIAS !== 'undefined' ? PAROQUIAS : []).forEach(p => { if (p[1] !== 'Religiosos') nomesVic.add(p[1]); });
    const opcoes = [...nomesVic].sort((a, b) => a.localeCompare(b, 'pt-BR')).map(g => `<option value="${esc(g)}"${g === ui.vic.value ? ' selected' : ''}>${esc(g)}</option>`).join('');
    const m = abrirModal(`<h2>Incluir ${T.um}</h2>
      <p>Para quem não está na lista. Depois de incluir, registre a entrega da vestimenta no cartão.</p>
      <form id="ck-form-incluir" novalidate>
        <div id="ck-inc-erro" class="alerta erro" hidden></div>
        <div class="campo"><label>Nome (com título, ex.: Pe. João Silva)</label><input name="nome" maxlength="150" autocapitalize="words"></div>
        <div class="campo"${T.vic ? '' : ' hidden'}><label for="ck-inc-vic">Vicariato</label><select id="ck-inc-vic" name="vicariato"><option value="">Escolha…</option>${opcoes}</select></div>
        <div class="campo"${T.vic ? '' : ' hidden'}><label>Paróquia (opcional)</label><input name="paroquia" maxlength="200" list="dl-paroquias"></div>
        <div class="botoes"><button class="btn" type="submit" id="ck-inc-salvar">INCLUIR E MARCAR CHEGADA</button><button class="btn secundario" type="button" id="ck-inc-cancelar">Cancelar</button></div>
      </form>`);
    const f = $('#ck-form-incluir', m);
    $('#ck-inc-cancelar', m).onclick = fecharModal;
    f.nome.focus();
    f.addEventListener('submit', async ev => {
      ev.preventDefault();
      const dados = { nome: limparNome(f.nome.value), vicariato: T.vic ? f.vicariato.value : 'Bispos', paroquia: T.vic ? limparNome(f.paroquia.value) : '', tipo: T.tipo };
      const erro = $('#ck-inc-erro', m);
      if (dados.nome.length < 3) { erro.textContent = 'Informe o nome.'; erro.hidden = false; f.nome.focus(); return; }
      if (T.vic && !dados.vicariato) { erro.textContent = 'Escolha o vicariato.'; erro.hidden = false; f.vicariato.focus(); return; }
      await enviarInclusao(dados, false, m);
    });
  }
  async function enviarInclusao(dados, forcar, m){
    const b = m && $('#ck-inc-salvar', m); if (b) { b.disabled = true; b.textContent = 'SALVANDO…'; }
    try {
      const res = await comTempo(S.api.incluirPadre({ ...dados, recepcionista: S.recep, forcar }));
      if (res && res.status === 'duplicado') {
        const lista = (res.duplicados || []).map(d => `<div class="dup"><b>${esc(d.nome)}</b>${esc(d.vicariato)}${d.vestimenta_em ? `<br><small>Vestimenta entregue às ${esc(hora(d.vestimenta_em))}</small>` : ''}</div>`).join('');
        const m2 = abrirModal(`<h2>Esse nome já está na lista</h2><p>Confira se não é a mesma pessoa:</p>${lista}
          <div class="botoes"><button class="btn secundario" id="ck-dup-voltar" type="button">É a mesma pessoa — voltar</button><button class="btn" id="ck-dup-forcar" type="button">É outra pessoa — incluir</button></div>`);
        $('#ck-dup-voltar', m2).onclick = () => { fecharModal(); ui.vic.value = ''; ui.nome.value = dados.nome; definirFiltro('todos'); };
        // (a busca é feita na aba atual)
        $('#ck-dup-forcar', m2).onclick = () => { fecharModal(); enviarInclusao(dados, true, null); };
        return;
      }
      const r = res && res.registro;
      if (r && r.id != null) st.linhas.set(r.id, r);
      fecharModal();
      ui.vic.value = T_vic() ? r.vicariato : ''; ui.nome.value = r.nome; definirFiltro('todos'); render();
      toast(`✓ Incluído e com chegada marcada: ${r.nome}`);
    } catch (e) {
      if (m && m.isConnected) { const a = $('#ck-inc-erro', m); a.textContent = 'Não foi possível incluir: ' + erroAmigavel(e); a.hidden = false; }
      else toast('Não foi possível incluir: ' + erroAmigavel(e), true);
    } finally { if (b && b.isConnected) { b.disabled = false; b.textContent = 'INCLUIR E MARCAR CHEGADA'; } }
  }

  /* ---------- Exportação (admin) ---------- */
  $('#ck-xlsx').addEventListener('click', async e => {
    if (S.perfil !== 'admin') return;
    const botao = e.currentTarget, txt = botao.textContent; botao.disabled = true; botao.textContent = 'Gerando…';
    try {
      const [rows] = await Promise.all([comTempo(S.api.padres(), 60000), carregarXlsx()]);
      rows.sort((a, b) => a.vicariato.localeCompare(b.vicariato, 'pt-BR') || semTitulo(a.nome).localeCompare(semTitulo(b.nome), 'pt-BR'));
      const dataHora = iso => iso ? new Date(iso).toLocaleString('pt-BR') : '';
      const cab = ['Vicariato', 'Nome', 'Função', 'Paróquia', 'Mitra', 'Vestimenta entregue', 'Entregue a', 'Nome de quem retirou', 'Observação', 'Horário', 'Registrado por', 'Incluído na hora'];
      const wb = XLSX.utils.book_new();
      const resumo = [['Grupo', 'Esperados', 'Entregues', 'Faltam', 'A terceiros']];
      for (const T of Object.values(TIPOS)) {
        const doT = rows.filter(r => (r.tipo || 'padre') === T.tipo);
        const linhas = doT.map(r => [[r.vicariato, r.vicariato2].filter(Boolean).join(' / '), r.nome, r.funcao || '', r.paroquia || '', r.mitra || '',
          r.vestimenta_em ? 'Sim' : 'Não', r.vestimenta_em ? (r.vestimenta_para === 'terceiro' ? 'Terceiro' : 'Padre') : '', r.vestimenta_terceiro || '', r.vestimenta_obs || '', dataHora(r.vestimenta_em), r.vestimenta_por || '', r.incluido_na_hora ? 'Sim' : '']);
        const ws = XLSX.utils.aoa_to_sheet([cab, ...linhas]);
        ws['!cols'] = [{ wch: 26 }, { wch: 44 }, { wch: 20 }, { wch: 50 }, { wch: 8 }, { wch: 8 }, { wch: 20 }, { wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 18 }, { wch: 10 }];
        ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(linhas.length, 1), c: cab.length - 1 } }) };
        XLSX.utils.book_append_sheet(wb, ws, T.varios[0].toUpperCase() + T.varios.slice(1));
        const ct = contar(doT);
        resumo.push([T.varios.toUpperCase(), ct.esperados, ct.vest, ct.faltam, ct.terc]);
        if (T.vic) {
          const m = new Map(); for (const r of doT) for (const v of [r.vicariato, r.vicariato2]) if (v) { if (!m.has(v)) m.set(v, []); m.get(v).push(r); }
          [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt-BR')).forEach(([v, a]) => { const c = contar(a); resumo.push(['   ' + v, c.esperados, c.vest, c.faltam, c.terc]); });
        }
      }
      const ws2 = XLSX.utils.aoa_to_sheet(resumo);
      ws2['!cols'] = [{ wch: 32 }, { wch: 11 }, { wch: 11 }, { wch: 11 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Resumo');
      XLSX.writeFile(wb, `checkin_${carimbo()}.xlsx`);
      toast('✓ Planilha do check-in gerada');
    } catch (err) {
      toast('Não foi possível exportar: ' + erroAmigavel(err), true);
    } finally { botao.disabled = false; botao.textContent = txt; }
  });

  function T_vic(){ return tipoAtual().vic; }
  function aoMostrar(aba){
    const T = TIPOS[aba] || TIPOS.padres;
    if (T.tipo !== st.tipo) {
      st.tipo = T.tipo; ui.vic.value = ''; ui.vic.dataset.html = ''; ui.nome.value = '';
      definirFiltro('todos');
    }
    $('#ck-campo-vic').hidden = !T.vic;
    $('.ck-busca').classList.toggle('sem-vic', !T.vic);
    $('#ck-lbl-nome').textContent = T.vic ? '2 · Nome' : 'Nome';
    ui.nome.placeholder = `Digite parte do nome do ${T.um}`;
    $('#ck-incluir').textContent = `+ ${T.um[0].toUpperCase() + T.um.slice(1)} não está na lista`;
    $('#ck-exportar').hidden = S.perfil !== 'admin';
    render();
  }

  const api = { iniciar, parar, aoMostrar, carregar, renderSoLista: () => { if (!$('#aba-checkin').hidden) renderLista(); }, _estado: st };
  return api;
})();
window.CK = CK;
// Se a sessão já tinha sido restaurada antes deste arquivo carregar
if (S.perfil && !$('#tela-app').hidden) { CK.iniciar(); if (!$('#aba-checkin').hidden) CK.aoMostrar(S.abaCk); }
