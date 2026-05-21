const express = require('express');
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;
const PORT = process.env.PORT || 3000;

let BIN_ID = process.env.BIN_ID || null;

// ── JSONBin helpers ──────────────────────────────────────
async function lerDados() {
  if (!BIN_ID) return { transacoes: [], fixas: [], projetos: [] };
  const res = await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });
  const json = await res.json();
  return json.record || { transacoes: [], fixas: [], projetos: [] };
}

async function salvarDados(dados) {
  if (!BIN_ID) {
    // Cria o bin na primeira vez
    const res = await fetch('https://api.jsonbin.io/v3/b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Name': 'financas' },
      body: JSON.stringify(dados)
    });
    const json = await res.json();
    BIN_ID = json.metadata?.id;
    console.log('Bin criado:', BIN_ID);
    return;
  }
  await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
    body: JSON.stringify(dados)
  });
}

// ── Parser de mensagem ───────────────────────────────────
const KWORDS = {
  mercado:'Mercado', roupa:'Roupa', roupas:'Roupa', calca:'Roupa', camisa:'Roupa', tenis:'Roupa',
  uber:'Transporte', onibus:'Transporte', transporte:'Transporte', gasolina:'Transporte',
  ifood:'Alimentação', restaurante:'Alimentação', lanche:'Alimentação', comida:'Alimentação',
  almoco:'Alimentação', jantar:'Alimentação',
  saude:'Saúde', farmacia:'Saúde', medico:'Saúde', remedio:'Saúde',
  netflix:'Lazer', spotify:'Lazer', steam:'Lazer', jogo:'Lazer', lazer:'Lazer',
  conta:'Contas', luz:'Contas', internet:'Contas', agua:'Contas', fatura:'Contas',
  nubank:'Contas', cartao:'Contas', assinatura:'Contas'
};

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectCat(text) {
  const n = norm(text);
  for (const [kw, cat] of Object.entries(KWORDS)) {
    if (n.includes(kw)) return cat;
  }
  return 'Outro';
}

function extrairValor(texto) {
  const matches = texto.match(/\d+([.,]\d+)?/g);
  if (!matches) return 0;
  for (const m of [...matches].reverse()) {
    const v = parseFloat(m.replace(',', '.'));
    if (v > 0 && v < 99999) return v;
  }
  return 0;
}

async function parseMensagem(texto) {
  const n = norm(texto.trim());
  const valor = extrairValor(texto);
  const dados = await lerDados();

  if (n.startsWith('gasto ') || n.startsWith('gastei ')) {
    const desc = texto.replace(/^gastei?\s+/i, '').replace(/\s*\d+([.,]\d+)?\s*$/, '').trim() || texto.replace(/^gastei?\s+/i, '').trim();
    return { tipo: 'gasto', desc, valor, cat: detectCat(desc), dados };
  }

  if (n.startsWith('recebi ') || n.startsWith('receita ')) {
    const desc = texto.replace(/^receb[ia]\s+|^receita\s+/i, '').replace(/\s*\d+([.,]\d+)?\s*$/, '').trim();
    return { tipo: 'receita', desc, valor, cat: 'Receita', dados };
  }

  if (n.startsWith('aporte ')) {
    const rest = texto.replace(/^aporte\s+/i, '').trim();
    let melhor = null, score = 0;
    for (const p of dados.projetos) {
      const words = norm(p.nome).split(' ');
      let s = 0; words.forEach(w => { if (norm(rest).includes(w)) s++; });
      if (s > score) { score = s; melhor = p; }
    }
    if (!melhor) return { erro: 'Projeto não encontrado. Crie com: projeto [nome]', dados };
    return { tipo: 'aporte', desc: 'Aporte: ' + melhor.nome, valor, cat: 'Investimento', projId: melhor.id, dados };
  }

  if (n.startsWith('projeto ')) {
    const nome = texto.replace(/^projeto\s+/i, '').trim();
    return { tipo: 'projeto_criar', nome, dados };
  }

  if (n === 'resumo' || n === 'saldo') {
    return { tipo: 'resumo', dados };
  }

  if (n === 'ajuda' || n === '/start') {
    return { tipo: 'ajuda', dados };
  }

  return { erro: 'Não entendi 🤔\n\nUse:\n• gasto [descrição] [valor]\n• recebi [descrição] [valor]\n• aporte [projeto] [valor]\n• projeto [nome]\n• resumo', dados };
}

async function enviarMsg(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' })
  });
}

function fmt(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Webhook ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  const data = new Date().toLocaleDateString('pt-BR');
  let resultado;
  try { resultado = await parseMensagem(msg.text); }
  catch(e) { await enviarMsg(msg.chat.id, '❌ Erro interno. Tenta de novo.'); return; }

  if (resultado.erro) { await enviarMsg(msg.chat.id, '❌ ' + resultado.erro); return; }

  const { dados } = resultado;

  if (resultado.tipo === 'ajuda') {
    await enviarMsg(msg.chat.id, '👋 <b>Comandos disponíveis:</b>\n\n🔴 <code>gasto mercado 35,50</code>\n🔴 <code>gasto assinatura spotify</code>\n💚 <code>recebi freela 300</code>\n🔵 <code>aporte projeto loja 200</code>\n📁 <code>projeto loja virtual</code>\n📊 <code>resumo</code>');
    return;
  }

  if (resultado.tipo === 'resumo') {
    const mesAtual = new Date().getMonth();
    const anoAtual = new Date().getFullYear();
    const txMes = dados.transacoes.filter(t => {
      const p = (t.data||'').split('/');
      return p.length >= 3 && parseInt(p[1])-1 === mesAtual && parseInt(p[2]) === anoAtual;
    });
    const g = txMes.filter(t=>t.tipo==='gasto').reduce((s,t)=>s+t.valor,0);
    const r = txMes.filter(t=>t.tipo==='receita').reduce((s,t)=>s+t.valor,0);
    const a = txMes.filter(t=>t.tipo==='aporte').reduce((s,t)=>s+t.valor,0);
    const f = (dados.fixas||[]).reduce((s,x)=>s+x.valor,0);
    const saldo = r - g - f - a;
    await enviarMsg(msg.chat.id, `📊 <b>Resumo do mês</b>\n\n💚 Receitas: <b>${fmt(r)}</b>\n🔴 Gastos: <b>${fmt(g)}</b>\n🔴 Fixas: <b>${fmt(f)}</b>\n🔵 Investido: <b>${fmt(a)}</b>\n\n💰 Saldo: <b>${saldo>=0?'💚':'🔴'} ${fmt(saldo)}</b>`);
    return;
  }

  if (resultado.tipo === 'projeto_criar') {
    dados.projetos = dados.projetos || [];
    dados.projetos.push({ id: Date.now(), nome: resultado.nome, tipo: 'Outro', meta: 0, aportes: [] });
    await salvarDados(dados);
    await enviarMsg(msg.chat.id, `📁 Projeto <b>${resultado.nome}</b> criado!\n\nAgora use: <code>aporte ${resultado.nome} [valor]</code>`);
    return;
  }

  const txn = { id: Date.now(), desc: resultado.desc, valor: resultado.valor, cat: resultado.cat, tipo: resultado.tipo, projId: resultado.projId || null, data };
  dados.transacoes = dados.transacoes || [];
  dados.transacoes.unshift(txn);

  if (resultado.tipo === 'aporte' && resultado.projId && resultado.valor > 0) {
    const pi = dados.projetos.findIndex(p => p.id === resultado.projId);
    if (pi >= 0) {
      dados.projetos[pi].aportes = dados.projetos[pi].aportes || [];
      dados.projetos[pi].aportes.unshift({ id: Date.now(), valor: resultado.valor, data });
    }
  }

  await salvarDados(dados);

  const emoji = resultado.tipo === 'receita' ? '💚' : resultado.tipo === 'aporte' ? '🔵' : '🔴';
  await enviarMsg(msg.chat.id, `${emoji} <b>Registrado!</b>\n📝 ${resultado.desc}\n💰 ${resultado.valor > 0 ? fmt(resultado.valor) : 'sem valor'}\n🏷 ${resultado.cat}`);
});

// ── API para o app web ───────────────────────────────────
app.get('/dados', async (req, res) => {
  try {
    const dados = await lerDados();
    res.json(dados);
  } catch(e) {
    res.status(500).json({ erro: 'Falha ao ler dados' });
  }
});

app.get('/', (req, res) => res.send('Bot financeiro rodando ✅'));

app.listen(PORT, () => console.log('Servidor rodando na porta', PORT));
