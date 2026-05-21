const express = require('express');
const app = express();
app.use(express.json());

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const PORT = process.env.PORT || 3000;

// Banco de dados em memória (persiste enquanto o servidor rodar)
let dados = { transacoes: [], fixas: [], projetos: [] };

const KWORDS = {
  mercado:'Mercado', roupa:'Roupa', roupas:'Roupa', calca:'Roupa', camisa:'Roupa', tenis:'Roupa',
  uber:'Transporte', onibus:'Transporte', transporte:'Transporte', gasolina:'Transporte', combustivel:'Transporte',
  ifood:'Alimentação', restaurante:'Alimentação', lanche:'Alimentação', comida:'Alimentação', almoco:'Alimentação', jantar:'Alimentação',
  saude:'Saúde', farmacia:'Saúde', medico:'Saúde', remedio:'Saúde',
  netflix:'Lazer', spotify:'Lazer', steam:'Lazer', jogo:'Lazer', lazer:'Lazer',
  conta:'Contas', luz:'Contas', internet:'Contas', agua:'Contas', fatura:'Contas', nubank:'Contas', cartao:'Contas', assinatura:'Contas'
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

function parseMensagem(texto) {
  const n = norm(texto.trim());
  const valorMatch = texto.match(/(\d+[,.]?\d*)/g);
  let valor = 0;
  if (valorMatch) {
    for (const m of [...valorMatch].reverse()) {
      const v = parseFloat(m.replace(',', '.'));
      if (v > 0 && v < 99999) { valor = v; break; }
    }
  }

  if (n.startsWith('gasto ') || n.startsWith('gastei ')) {
    const desc = texto.replace(/^gastei?\s+/i, '').replace(/\s*[\d,.]+\s*$/, '').trim();
    const cat = detectCat(desc);
    return { tipo: 'gasto', desc, valor, cat };
  }

  if (n.startsWith('recebi ') || n.startsWith('receita ')) {
    const desc = texto.replace(/^receb[ia]\s+|^receita\s+/i, '').replace(/\s*[\d,.]+\s*$/, '').trim();
    return { tipo: 'receita', desc, valor, cat: 'Receita' };
  }

  if (n.startsWith('aporte ')) {
    const rest = texto.replace(/^aporte\s+/i, '').trim();
    let melhor = null, score = 0;
    for (const p of dados.projetos) {
      const words = norm(p.nome).split(' ');
      let s = 0; words.forEach(w => { if (norm(rest).includes(w)) s++; });
      if (s > score) { score = s; melhor = p; }
    }
    if (!melhor) return { erro: 'Projeto não encontrado. Crie o projeto no app primeiro.' };
    return { tipo: 'aporte', desc: 'Aporte: ' + melhor.nome, valor, cat: 'Investimento', projId: melhor.id };
  }

  if (n.startsWith('projeto ')) {
    const nome = texto.replace(/^projeto\s+/i, '').trim();
    const proj = { id: Date.now(), nome, tipo: 'Outro', meta: 0, aportes: [] };
    dados.projetos.push(proj);
    return { tipo: 'projeto_criado', nome };
  }

  if (n === 'resumo' || n === 'saldo') {
    return { tipo: 'resumo' };
  }

  return { erro: 'Não entendi. Use:\n• gasto [descrição] [valor]\n• recebi [descrição] [valor]\n• aporte [projeto] [valor]\n• projeto [nome]\n• resumo' };
}

async function enviarMsg(chatId, texto) {
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: 'HTML' })
  });
}

function fmt(v) {
  return 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Webhook do Telegram
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const msg = req.body?.message;
  if (!msg || !msg.text) return;
  if (String(msg.chat.id) !== String(CHAT_ID)) return; // só aceita do seu chat

  const resultado = parseMensagem(msg.text);
  const data = new Date().toLocaleDateString('pt-BR');

  if (resultado.erro) {
    await enviarMsg(msg.chat.id, '❌ ' + resultado.erro);
    return;
  }

  if (resultado.tipo === 'resumo') {
    const mesAtual = new Date().getMonth();
    const anoAtual = new Date().getFullYear();
    const txMes = dados.transacoes.filter(t => {
      const [d, m, a] = t.data.split('/');
      return parseInt(m) - 1 === mesAtual && parseInt(a) === anoAtual;
    });
    const gastos = txMes.filter(t => t.tipo === 'gasto').reduce((s, t) => s + t.valor, 0);
    const receitas = txMes.filter(t => t.tipo === 'receita').reduce((s, t) => s + t.valor, 0);
    const aportes = txMes.filter(t => t.tipo === 'aporte').reduce((s, t) => s + t.valor, 0);
    const fixas = dados.fixas.reduce((s, f) => s + f.valor, 0);
    await enviarMsg(msg.chat.id,
      `📊 <b>Resumo do mês</b>\n\n💚 Receitas: ${fmt(receitas)}\n🔴 Gastos: ${fmt(gastos)}\n🔴 Fixas: ${fmt(fixas)}\n🔵 Investido: ${fmt(aportes)}\n\n💰 Saldo: ${fmt(receitas - gastos - fixas - aportes)}`
    );
    return;
  }

  if (resultado.tipo === 'projeto_criado') {
    await enviarMsg(msg.chat.id, `✅ Projeto <b>${resultado.nome}</b> criado! Agora pode usar: aporte ${resultado.nome} [valor]`);
    return;
  }

  const txn = {
    id: Date.now(),
    desc: resultado.desc,
    valor: resultado.valor,
    cat: resultado.cat,
    tipo: resultado.tipo,
    projId: resultado.projId || null,
    data
  };
  dados.transacoes.unshift(txn);

  if (resultado.tipo === 'aporte' && resultado.projId && resultado.valor > 0) {
    const pi = dados.projetos.findIndex(p => p.id === resultado.projId);
    if (pi >= 0) {
      dados.projetos[pi].aportes = dados.projetos[pi].aportes || [];
      dados.projetos[pi].aportes.unshift({ id: Date.now(), valor: resultado.valor, data });
    }
  }

  const emoji = resultado.tipo === 'receita' ? '💚' : resultado.tipo === 'aporte' ? '🔵' : '🔴';
  await enviarMsg(msg.chat.id,
    `${emoji} <b>Registrado!</b>\n📝 ${resultado.desc}\n💰 ${resultado.valor > 0 ? fmt(resultado.valor) : 'sem valor'}\n🏷 ${resultado.cat}`
  );
});

// API para o app web buscar os dados
app.get('/dados', (req, res) => {
  res.json(dados);
});

app.get('/', (req, res) => res.send('Bot financeiro rodando ✅'));

app.listen(PORT, () => console.log('Servidor rodando na porta', PORT));
