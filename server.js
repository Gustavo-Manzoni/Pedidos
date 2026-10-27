'use strict';
// Sistema de pedidos - servidor
// Não precisa de "npm install": usa só módulos que já vêm com o Node.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORTA = Number(process.env.PORT) || 3000;
const ARQUIVO_DADOS = path.join(__dirname, 'dados.json');
const PRIMEIRO_PEDIDO = 100;
const STATUS_VALIDOS = ['processando', 'pronto', 'entregue'];
// Senha do caixa. Se a variável de ambiente PIN estiver definida, o caixa pede senha
// e o display (público) só enxerga os números dos pedidos. Sem PIN = modo local, sem senha.
const PIN = String(process.env.PIN || '');

const PADRAO = {
  proximoPedido: PRIMEIRO_PEDIDO,
  cardapio: [
    { id: 1, nome: 'Pipoca', preco: 3 },
    { id: 2, nome: 'Milho', preco: 2 },
    { id: 3, nome: 'Refri', preco: 4 }
  ],
  pedidos: [],
  mudancas: 0
};

// ---------- dados (salvos em dados.json) ----------
function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQUIVO_DADOS, 'utf8'));
    if (d && Array.isArray(d.pedidos) && Array.isArray(d.cardapio) && d.proximoPedido) { d.mudancas = d.mudancas || 0; return d; }
  } catch (e) { /* primeira execução ou arquivo inválido */ }
  return JSON.parse(JSON.stringify(PADRAO));
}

let estado = carregar();

function salvar() {
  try {
    fs.writeFileSync(ARQUIVO_DADOS + '.tmp', JSON.stringify(estado, null, 2));
    fs.renameSync(ARQUIVO_DADOS + '.tmp', ARQUIVO_DADOS);
  } catch (e) {
    console.error('Erro ao salvar dados:', e.message);
  }
}

// ---------- tempo real (Server-Sent Events) ----------
const clientes = new Map(); // resposta -> true (vê tudo) ou false (só números e status)

function visaoPublica() {
  return {
    publico: true,
    pedidos: estado.pedidos
      .filter(function (p) { return p.status !== 'entregue'; })
      .map(function (p) { return { numero: p.numero, status: p.status }; })
  };
}

function mensagem(completo) {
  return 'data: ' + JSON.stringify(completo ? estado : visaoPublica()) + '\n\n';
}

function transmitir() {
  estado.mudancas++;
  salvar();
  clientes.forEach(function (completo, r) { r.write(mensagem(completo)); });
}

setInterval(function () {
  clientes.forEach(function (completo, r) { r.write(': ping\n\n'); });
}, 20000);

// ---------- validações ----------
function arredondar(v) { return Math.round(v * 100) / 100; }

function limparItens(itens) {
  if (!Array.isArray(itens) || itens.length === 0) throw new Error('O pedido está sem itens');
  return itens.map(function (i) {
    const nome = String(i.nome || '').trim().slice(0, 60);
    const preco = Number(i.preco);
    const qtd = parseInt(i.qtd, 10);
    if (!nome || !isFinite(preco) || preco < 0 || !(qtd > 0) || qtd > 99) {
      throw new Error('Item inválido no pedido');
    }
    return { nome: nome, preco: arredondar(preco), qtd: qtd, obs: String(i.obs || '').trim().slice(0, 80) };
  });
}

function limparObs(obs) { return String(obs || '').trim().slice(0, 200); }

function limparCardapio(lista) {
  if (!Array.isArray(lista)) throw new Error('Cardápio inválido');
  let maiorId = lista.reduce(function (a, i) { return Math.max(a, Number(i.id) || 0); }, 0);
  return lista.map(function (i) {
    const nome = String(i.nome || '').trim().slice(0, 40);
    const preco = Number(i.preco);
    if (!nome || !isFinite(preco) || preco < 0) throw new Error('Produto inválido: ' + (nome || '(sem nome)'));
    return { id: Number(i.id) || ++maiorId, nome: nome, preco: arredondar(preco) };
  });
}

// ---------- senha (PIN) ----------
const falhas = {}; // ip -> { n, ate }

function ipDe(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}

// devolve 'ok', 'errado' ou 'bloqueado' (muitas tentativas erradas)
function checarPin(req, url) {
  if (!PIN) return 'ok';
  const ip = ipDe(req);
  let f = falhas[ip];
  if (f && Date.now() >= f.ate) { delete falhas[ip]; f = null; }
  if (f && f.n >= 10) return 'bloqueado';
  const informado = String(req.headers['x-pin'] || url.searchParams.get('pin') || '');
  if (informado === PIN) { delete falhas[ip]; return 'ok'; }
  if (informado) {
    const g = f || { n: 0, ate: 0 };
    g.n++;
    g.ate = Date.now() + 5 * 60 * 1000;
    falhas[ip] = g;
  }
  return 'errado';
}

function negar(res, auth) {
  if (auth === 'bloqueado') return resp(res, 429, { erro: 'Muitas tentativas. Espere 5 minutos.' });
  return resp(res, 401, { erro: 'Senha incorreta' });
}

// ---------- utilidades HTTP ----------
function lerCorpo(req) {
  return new Promise(function (ok, erro) {
    let txt = '';
    req.on('data', function (c) {
      txt += c;
      if (txt.length > 1e6) { req.destroy(); erro(new Error('Requisição muito grande')); }
    });
    req.on('end', function () {
      try { ok(txt ? JSON.parse(txt) : {}); } catch (e) { erro(new Error('JSON inválido')); }
    });
    req.on('error', erro);
  });
}

function resp(res, codigo, obj) {
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function enviarHtml(res, nome) {
  fs.readFile(path.join(__dirname, nome), function (err, dados) {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Arquivo não encontrado: ' + nome); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(dados);
  });
}

const PAGINA_INICIAL = '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sistema de Pedidos</title>' +
  '<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:40px auto;padding:0 16px}' +
  'a{display:block;padding:22px;margin:14px 0;background:#e8590c;color:#fff;text-decoration:none;' +
  'border-radius:14px;font-size:22px;font-weight:700;text-align:center}a.b{background:#333}</style></head><body>' +
  '<h1>Sistema de Pedidos</h1><a href="/host">Caixa (host)</a><a class="b" href="/display">Display de pedidos</a></body></html>';

// ---------- servidor ----------
const servidor = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  try {
    if (m === 'GET') {
      if (p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGINA_INICIAL);
      }
      if (p === '/host') return enviarHtml(res, 'host.html');
      if (p === '/display') return enviarHtml(res, 'display.html');
      if (p === '/saude') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end('ok');
      }
      if (p === '/api/estado') {
        const auth = checarPin(req, url);
        if (auth !== 'ok') return negar(res, auth);
        return resp(res, 200, estado);
      }
      if (p === '/eventos') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.write('retry: 2000\n\n');
        const completo = checarPin(req, url) === 'ok';
        res.write(mensagem(completo));
        clientes.set(res, completo);
        req.on('close', function () { clientes.delete(res); });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Página não encontrada');
    }

    // tudo daqui para baixo altera dados: exige a senha (quando existir)
    const auth = checarPin(req, url);
    if (auth !== 'ok') return negar(res, auth);

    // criar pedido
    if (m === 'POST' && p === '/api/pedidos') {
      const corpo = await lerCorpo(req);
      const itens = limparItens(corpo.itens);
      const pedido = {
        numero: estado.proximoPedido++,
        itens: itens,
        obs: limparObs(corpo.obs),
        status: 'processando',
        criadoEm: Date.now()
      };
      estado.pedidos.push(pedido);
      transmitir();
      return resp(res, 201, pedido);
    }

    // trocar o cardápio (vale para todos os caixas)
    if (m === 'PUT' && p === '/api/cardapio') {
      const corpo = await lerCorpo(req);
      estado.cardapio = limparCardapio(corpo);
      transmitir();
      return resp(res, 200, estado.cardapio);
    }

    // começar um novo dia: apaga pedidos e volta para o 100
    if (m === 'POST' && p === '/api/reiniciar') {
      estado.pedidos = [];
      estado.proximoPedido = PRIMEIRO_PEDIDO;
      transmitir();
      return resp(res, 200, { ok: true });
    }

    // restaurar o backup guardado no caixa quando o servidor reiniciou vazio
    if (m === 'POST' && p === '/api/restaurar') {
      if (estado.mudancas !== 0) throw new Error('O servidor já tem dados novos. Restauração cancelada.');
      const corpo = await lerCorpo(req);
      const cardapio = limparCardapio(corpo.cardapio);
      if (!Array.isArray(corpo.pedidos)) throw new Error('Pedidos inválidos no backup');
      const pedidos = corpo.pedidos.map(function (x) {
        const numero = parseInt(x.numero, 10);
        if (!(numero > 0) || STATUS_VALIDOS.indexOf(x.status) === -1) throw new Error('Pedido inválido no backup');
        return {
          numero: numero,
          itens: limparItens(x.itens),
          obs: limparObs(x.obs),
          status: x.status,
          criadoEm: Number(x.criadoEm) || Date.now()
        };
      });
      const maior = pedidos.reduce(function (a, x) { return Math.max(a, x.numero); }, PRIMEIRO_PEDIDO - 1);
      estado.cardapio = cardapio;
      estado.pedidos = pedidos;
      estado.proximoPedido = Math.max(maior + 1, parseInt(corpo.proximoPedido, 10) || 0, PRIMEIRO_PEDIDO);
      transmitir();
      return resp(res, 200, { ok: true });
    }

    // operações em um pedido
    const mt = p.match(/^\/api\/pedidos\/(\d+)(\/status)?$/);
    if (mt) {
      const numero = Number(mt[1]);
      const pedido = estado.pedidos.find(function (x) { return x.numero === numero; });
      if (!pedido) return resp(res, 404, { erro: 'Pedido #' + numero + ' não existe mais' });

      if (m === 'POST' && mt[2]) {
        const corpo = await lerCorpo(req);
        if (STATUS_VALIDOS.indexOf(corpo.status) === -1) throw new Error('Status inválido');
        pedido.status = corpo.status;
        pedido.atualizadoEm = Date.now();
        transmitir();
        return resp(res, 200, pedido);
      }

      if (m === 'PUT' && !mt[2]) {
        const corpo = await lerCorpo(req);
        if (pedido.status === 'entregue') throw new Error('Pedido já foi entregue, não dá para editar');
        pedido.itens = limparItens(corpo.itens);
        pedido.obs = limparObs(corpo.obs);
        pedido.atualizadoEm = Date.now();
        transmitir();
        return resp(res, 200, pedido);
      }

      if (m === 'DELETE' && !mt[2]) {
        estado.pedidos = estado.pedidos.filter(function (x) { return x.numero !== numero; });
        transmitir();
        return resp(res, 200, { ok: true });
      }
    }

    return resp(res, 404, { erro: 'Rota não encontrada' });
  } catch (e) {
    return resp(res, 400, { erro: e.message });
  }
});

function enderecosLocais() {
  const lista = [];
  try {
    // No Android (Termux) esta chamada pode falhar; nesse caso o IP é visto nas configurações do Wi-Fi.
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach(function (nome) {
      ifs[nome].forEach(function (i) {
        if ((i.family === 'IPv4' || i.family === 4) && !i.internal) lista.push(i.address);
      });
    });
  } catch (e) { /* sem lista de IPs */ }
  return lista;
}

servidor.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('\nA porta ' + PORTA + ' já está em uso. O sistema já está aberto em outra janela?');
  } else {
    console.error('\nErro no servidor:', e.message);
  }
  process.exit(1);
});

servidor.listen(PORTA, '0.0.0.0', function () {
  console.log('==============================================');
  console.log('  SISTEMA DE PEDIDOS RODANDO');
  console.log('==============================================');
  const ips = enderecosLocais();
  if (ips.length === 0) {
    console.log('  Nao deu para detectar o IP automaticamente.');
    console.log('  Veja o IP deste aparelho (Config. > Wi-Fi > rede conectada) e use:');
    console.log('     http://IP-DO-APARELHO:' + PORTA + '/host   e   /display');
    console.log('');
  }
  ips.forEach(function (ip) {
    console.log('  Caixa (tablets):  http://' + ip + ':' + PORTA + '/host');
    console.log('  Display (PC):     http://' + ip + ':' + PORTA + '/display');
    console.log('');
  });
  console.log(PIN ? '  Senha (PIN) do caixa: ATIVADA' : '  Senha (PIN) do caixa: desativada (modo local)');
  console.log('  Neste PC também funciona: http://localhost:' + PORTA + '/display');
  console.log('  Para desligar: feche esta janela.');
  console.log('==============================================');
});
