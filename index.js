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

// Aguardando confirmação: { chatId: { pendente: [...transacoes] } }
const pendentes = {};

// ── JSONBin ──────────────────────────────────────────────
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
    const res = await fetch('https://api.jsonbin.io/v3/b', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY, 'X-Bin-Name': 'financas' },
      body: JSON.stringify(dados)
    });
    const json = await res.json();
    BIN_ID = json.metadata?.id;
    return;
  }
  await fetch(`https://api.jsonbin.io/v3/b/${BIN_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
    body: JSON.stringify(dados)
  });
}

// ── Categorias ───────────────────────────────────────────
const KWORDS = {
  mercado:'Mercado', supermercado:'Mercado', feira:'Mercado',
  roupa:'Roupa', roupas:'Roupa', calca:'Roupa', camisa:'Roupa', tenis:'Roupa', vestido:'Roupa', blusa:'Roupa',
  uber:'Transporte', onibus:'Transporte', transporte:'Transporte', gasolina:'Transporte', combustivel:'Transporte', moto:'Transporte', taxi:'Transporte',
  ifood:'Alimentação', restaurante:'Alimentação', lanche:'Alimentação', comida:'Alimentação',
  almoco:'Alimentação', jantar:'Alimentação', pizza:'Alimentação', hamburguer:'Alimentação', acai:'Alimentação',
  saude:'Saúde', farmacia:'Saúde', medico:'Saúde', remedio:'Saúde', consulta:'Saúde',
  netflix:'Lazer', spotify:'Lazer', steam:'Lazer', jogo:'Lazer', lazer:'Lazer', cinema:'Lazer', show:'Lazer',
  conta:'Contas', luz:'Contas', internet:'Contas', agua:'Contas', fatura:'Contas',
  nubank:'Contas', cartao:'Contas', assinatura:'Contas', aluguel:'Contas', boleto:'Contas',
  freela:'Receita', freelas:'Receita', salario:'Receita', pagamento:'Receita', recebi:'Receita', renda:'Receita'
};

const CAT_EMOJI = {
  Mercado:'🛒', Roupa:'👕', Transporte:'🚗', 'Alimentação':'🍔', 'Saúde':'💊',
  Lazer:'🎮', Contas:'💡', Receita:'💰', Investimento:'📈', Outro:'📦'
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

function fmt(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ── Parser inteligente ───────────────────────────────────
// Suporta múltiplos gastos: "mercado 35, uber 12, lanche 8"
// Suporta formato livre: "mercado 35" ou "gasto mercado 35"
function parseLinha(linha) {
  linha = linha.trim();
  if (!linha) return null;
  const n = norm(linha);

  // Remove prefixos opcionais
  const semPrefixo = linha
    .replace(/^gastei?\s+/i, '')
    .replace(/^receb[ia]\s+/i, '')
    .replace(/^receita\s+/i, '')
    .trim();

  const valor = extrairValor(semPrefixo);
  const desc = semPrefixo.replace(/\s*\d+([.,]\d+)?\s*$/, '').trim() || semPrefixo.trim();
  const cat = detectCat(desc || linha);

  // Detecta se é receita
  const isReceita = n.startsWith('recebi ') || n.startsWith('receita ') ||
    cat === 'Receita' || n.includes('recebi') || n.includes('salario') || n.includes('freela');

  return {
    desc: desc || semPrefixo,
    valor,
    cat: isReceita ? 'Receita' : cat,
    tipo: isReceita ? 'receita' : 'gasto'
  };
}

// Divide mensagem em múltiplos itens por vírgula/quebra de linha
function parseMensagemMultipla(texto) {
  // Divide por vírgula ou nova linha
  const linhas = texto.split(/,|\n/).map(l => l.trim()).filter(Boolean);
  if (linhas.length <= 1) return null; // não é múltiplo
  return linhas.map(parseLinha).filter(Boolean);
}

async function enviarMsg(chatId, texto) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' })
  });
}

// ── Webhook ──────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) return;

  const texto = msg.text.trim();
  const n = norm(texto);
  const chatId = msg.chat.id;
  const data = new Date().toLocaleDateString('pt-BR');

  // ── Resposta a confirmação pendente ──
  if (pendentes[chatId]) {
    if (n === 'sim' || n === 's' || n === '✅' || n === 'confirmar' || n === 'ok') {
      const itens = pendentes[chatId];
      delete pendentes[chatId];
      const dados = await lerDados();
      dados.transacoes = dados.transacoes || [];
      for (const item of itens) {
        dados.transacoes.unshift({ id: Date.now() + Math.random(), ...item, data });
      }
      await salvarDados(dados);
      const total = itens.reduce((s, i) => s + i.valor, 0);
      const linhas = itens.map(i => `${CAT_EMOJI[i.cat]||'📦'} ${i.desc}${i.valor > 0 ? ' — ' + fmt(i.valor) : ''}`).join('\n');
      await enviarMsg(chatId, `✅ <b>${itens.length} item(s) salvo(s)!</b>\n\n${linhas}${total > 0 ? '\n\n💰 Total: <b>' + fmt(total) + '</b>' : ''}`);
      return;
    }
    if (n === 'nao' || n === 'não' || n === 'n' || n === 'cancelar') {
      delete pendentes[chatId];
      await enviarMsg(chatId, '❌ Cancelado. Nada foi salvo.');
      return;
    }
    // Se mandou outra coisa, cancela o pendente e processa normalmente
    delete pendentes[chatId];
  }

  // ── Comandos especiais ──
  if (n === 'resumo' || n === 'saldo') {
    const dados = await lerDados();
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
    await enviarMsg(chatId, `📊 <b>Resumo do mês</b>\n\n💚 Receitas: <b>${fmt(r)}</b>\n🔴 Gastos variáveis: <b>${fmt(g)}</b>\n🔴 Fixas: <b>${fmt(f)}</b>\n🔵 Investido: <b>${fmt(a)}</b>\n\n💰 Saldo: <b>${fmt(saldo)}</b>`);
    return;
  }

  if (n === 'ajuda' || n === '/start') {
    await enviarMsg(chatId,
      '👋 <b>Como registrar:</b>\n\n' +
      '🔴 Gasto simples:\n<code>mercado 35,50</code>\n<code>spotify</code>\n<code>fatura nubank 150</code>\n\n' +
      '💚 Receita:\n<code>recebi freela 300</code>\n\n' +
      '📋 Vários de uma vez:\n<code>mercado 35, uber 12, lanche 8</code>\n\n' +
      '🔵 Investimento:\n<code>aporte projeto loja 200</code>\n<code>projeto loja virtual</code>\n\n' +
      '📊 Ver saldo:\n<code>resumo</code>'
    );
    return;
  }

  // ── Criar projeto ──
  if (n.startsWith('projeto ')) {
    const nome = texto.replace(/^projeto\s+/i, '').trim();
    const dados = await lerDados();
    dados.projetos = dados.projetos || [];
    dados.projetos.push({ id: Date.now(), nome, tipo: 'Outro', meta: 0, aportes: [] });
    await salvarDados(dados);
    await enviarMsg(chatId, `📁 Projeto <b>${nome}</b> criado!\n\nUse: <code>aporte ${nome} [valor]</code>`);
    return;
  }

  // ── Aporte ──
  if (n.startsWith('aporte ')) {
    const rest = texto.replace(/^aporte\s+/i, '').trim();
    const valor = extrairValor(rest);
    const dados = await lerDados();
    let melhor = null, score = 0;
    for (const p of (dados.projetos||[])) {
      const words = norm(p.nome).split(' ');
      let s = 0; words.forEach(w => { if (norm(rest).includes(w)) s++; });
      if (s > score) { score = s; melhor = p; }
    }
    if (!melhor) { await enviarMsg(chatId, '❌ Projeto não encontrado.\nCrie com: <code>projeto [nome]</code>'); return; }
    const txn = { id: Date.now(), desc: 'Aporte: '+melhor.nome, valor, cat: 'Investimento', tipo: 'aporte', projId: melhor.id, data };
    dados.transacoes.unshift(txn);
    const pi = dados.projetos.findIndex(p=>p.id===melhor.id);
    if (pi>=0) { dados.projetos[pi].aportes=dados.projetos[pi].aportes||[]; dados.projetos[pi].aportes.unshift({id:Date.now(),valor,data}); }
    await salvarDados(dados);
    await enviarMsg(chatId, `🔵 <b>Aporte registrado!</b>\n📁 ${melhor.nome}\n💰 ${valor>0?fmt(valor):'sem valor'}`);
    return;
  }

  // ── Múltiplos gastos ──
  const multiplos = parseMensagemMultipla(texto);
  if (multiplos && multiplos.length > 1) {
    pendentes[chatId] = multiplos;
    const total = multiplos.reduce((s,i)=>s+i.valor,0);
    const linhas = multiplos.map(i =>
      `${CAT_EMOJI[i.cat]||'📦'} <b>${i.desc}</b> [${i.cat}]${i.valor>0?' — '+fmt(i.valor):' — sem valor'}`
    ).join('\n');
    await enviarMsg(chatId,
      `📋 <b>Entendi ${multiplos.length} itens:</b>\n\n${linhas}${total>0?'\n\n💰 Total: <b>'+fmt(total)+'</b>':''}\n\nConfirma? <b>sim</b> ou <b>não</b>`
    );
    return;
  }

  // ── Gasto/receita único ──
  const item = parseLinha(texto);
  if (!item || !item.desc) {
    await enviarMsg(chatId, '🤔 Não entendi. Tenta assim:\n<code>mercado 35,50</code>\nOu manda <code>ajuda</code>');
    return;
  }

  pendentes[chatId] = [item];
  await enviarMsg(chatId,
    `${CAT_EMOJI[item.cat]||'📦'} <b>${item.desc}</b>\n` +
    `🏷 Categoria: ${item.cat}\n` +
    `💰 Valor: ${item.valor>0?fmt(item.valor):'não detectado'}\n\n` +
    `Confirma? <b>sim</b> ou <b>não</b>`
  );
});

// ── API web ──────────────────────────────────────────────
app.get('/dados', async (req, res) => {
  try { res.json(await lerDados()); }
  catch(e) { res.status(500).json({ erro: 'Falha ao ler dados' }); }
});

app.get('/', (req, res) => res.send('Bot financeiro ✅'));

app.listen(PORT, () => console.log('Rodando na porta', PORT));
