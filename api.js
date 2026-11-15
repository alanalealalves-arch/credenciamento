
function criarApiSupabase(sb, cfg){
  const COLS = 'id,nome,telefone,email,paroquia,vicariato,recepcionista,dispositivo,criado_em,atualizado_em';
  const falha = error => { const e = new Error(error.message || 'Erro'); e.code = error.code; throw e; };
  return {
    async sessao(){
      const { data, error } = await sb.auth.getSession();
      if (error) falha(error);
      return data.session ? { email: data.session.user.email } : null;
    },
    async entrar(email, senha){
      const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) falha(error);
      return { email: data.user.email };
    },
    async sair(){ const { error } = await sb.auth.signOut(); if (error) falha(error); },
    async cadastrar(p){
      const { data, error } = await sb.rpc('cadastrar', {
        p_nome: p.nome, p_telefone: p.telefone, p_email: p.email, p_paroquia: p.paroquia, p_vicariato: p.vicariato,
        p_recepcionista: p.recepcionista, p_dispositivo: p.dispositivo,
        p_client_id: p.client_id, p_forcar: !!p.forcar
      });
      if (error) falha(error);
      return data;
    },
    async todos(){
      const out = []; let ultimo = 0;
      for (;;) {
        const { data, error } = await sb.from('participantes').select(COLS)
          .gt('id', ultimo).order('id', { ascending: true }).limit(1000);
        if (error) falha(error);
        out.push(...data);
        if (data.length < 1000) break;
        ultimo = data[data.length - 1].id;
      }
      return out;
    },
    async contar(){
      const { count, error } = await sb.from('participantes').select('id', { count: 'exact', head: true });
      if (error) falha(error);
      return count;
    },
    async atualizar(id, campos){
      const { data, error } = await sb.from('participantes').update(campos).eq('id', id).select(COLS);
      if (error) falha(error);
      if (!data || !data.length) { const e = new Error('permission: nenhum registro alterado'); e.code = '42501'; throw e; }
      return data[0];
    },
    async excluir(id){
      const { error, count } = await sb.from('participantes').delete({ count: 'exact' }).eq('id', id);
      if (error) falha(error);
      if (!count) { const e = new Error('permission: nenhum registro excluído'); e.code = '42501'; throw e; }
    },
    ouvir(aoMudar, aoStatus){
      const canal = sb.channel('participantes-' + Math.random().toString(36).slice(2))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'participantes' },
            pl => aoMudar({ tipo: pl.eventType, novo: pl.new, antigo: pl.old }))
        .subscribe(st => aoStatus(st));
      return () => sb.removeChannel(canal);
    }
  };
}
