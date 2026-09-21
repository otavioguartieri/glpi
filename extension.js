const vscode = require('vscode');
const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

// ---------------------------------------------------------------------------
// Search options do Ticket no GLPI (IDs padrao; ajuste se sua instancia diferir)
// ---------------------------------------------------------------------------
const CAMPO = {
  id: 2,
  titulo: 1,
  status: 12,
  tecnico: 5, // "Atribuido a > Tecnico"
  requerente: 4,
  dataAbertura: 15,
  descricao: 21, // conteudo/descricao
  prazo: 18, // tempo/prazo para solucao (time_to_resolve)
  dataAtualizacao: 19 // ultima atualizacao (date_mod)
};

// ---------------------------------------------------------------------------
// Credenciais (armazenadas no SecretStorage, criptografado e persistente)
// ---------------------------------------------------------------------------
const CHAVES = {
  apiUrl: 'glpi.apiUrl',
  appToken: 'glpi.appToken',
  userToken: 'glpi.userToken'
};

async function lerCredenciais(context) {
  const s = context.secrets;
  const [apiUrl, appToken, userToken] = await Promise.all([
    s.get(CHAVES.apiUrl),
    s.get(CHAVES.appToken),
    s.get(CHAVES.userToken)
  ]);
  return { apiUrl, appToken, userToken };
}

function credenciaisCompletas(cred) {
  return Boolean(cred && cred.apiUrl && cred.appToken && cred.userToken);
}

async function pedirCredenciais(context) {
  const s = context.secrets;
  const atual = await lerCredenciais(context);

  const apiUrl = await vscode.window.showInputBox({
    title: 'GLPI (1/3) - URL da API REST',
    prompt: 'Ex: https://glpi.suaempresa.com/apirest.php',
    value: atual.apiUrl || '',
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : 'Informe a URL da API.')
  });
  if (apiUrl === undefined) return null;

  const appToken = await vscode.window.showInputBox({
    title: 'GLPI (2/3) - App-Token',
    prompt: 'Gerado em Configurar > Geral > API',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : 'Informe o App-Token.')
  });
  if (appToken === undefined) return null;

  const userToken = await vscode.window.showInputBox({
    title: 'GLPI (3/3) - User-Token',
    prompt: 'Token pessoal, no perfil do seu usuario GLPI',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v && v.trim() ? undefined : 'Informe o User-Token.')
  });
  if (userToken === undefined) return null;

  const cred = {
    apiUrl: apiUrl.trim().replace(/\/+$/, ''),
    appToken: appToken.trim(),
    userToken: userToken.trim()
  };
  await Promise.all([
    s.store(CHAVES.apiUrl, cred.apiUrl),
    s.store(CHAVES.appToken, cred.appToken),
    s.store(CHAVES.userToken, cred.userToken)
  ]);
  return cred;
}

// ---------------------------------------------------------------------------
// Cliente da API REST do GLPI
// ---------------------------------------------------------------------------
// O fetch do Node manda um User-Agent que nao parece navegador, e protecoes de
// bot na frente do GLPI (Cloudflare Bot Fight Mode, por exemplo) barram isso com
// 403 e uma pagina de desafio em HTML, antes da requisicao chegar ao GLPI.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Caminho da API dentro do dominio, para mensagens de erro. A URL configurada
// varia por instancia: "/apirest.php" na API legada, "/api.php/v1" na nova.
function caminhoApi(apiUrl) {
  try {
    return new URL(String(apiUrl)).pathname.replace(/\/+$/, '') || '/apirest.php';
  } catch (_) {
    return '/apirest.php';
  }
}

function cabecalho(cfg, sessionToken, comJson) {
  const h = { 'App-Token': cfg.appToken, 'Session-Token': sessionToken, 'User-Agent': USER_AGENT };
  if (comJson) h['Content-Type'] = 'application/json';
  return h;
}

async function initSession(cfg) {
  const res = await fetch(`${cfg.apiUrl}/initSession`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      'App-Token': cfg.appToken,
      'User-Agent': USER_AGENT,
      Authorization: `user_token ${cfg.userToken}`
    }
  });
  const bruto = await res.text().catch(() => '');
  let data = null;
  try {
    data = JSON.parse(bruto);
  } catch (_) {
    data = null;
  }
  if (!res.ok) {
    // Corpo nao-JSON num 403 costuma ser WAF/proxy na frente do GLPI (ou a API
    // REST desativada), nao o GLPI recusando o token: o GLPI responde erro como
    // ["ERROR_...", "mensagem"]. Mostrar o texto cru distingue os dois casos.
    // Pagina de desafio de bot (Cloudflare e afins): a requisicao foi barrada
    // antes de chegar ao GLPI, entao nao adianta mexer em token nem em sessao.
    if (!data && /just a moment|cf-browser-verification|challenge-platform|Attention Required/i.test(bruto)) {
      throw new Error(
        `initSession falhou (${res.status}): bloqueado por protecao de bot (Cloudflare) antes de chegar ao GLPI. ` +
          `Libere o caminho ${caminhoApi(cfg.apiUrl)} no Cloudflare ` +
          '(regra de WAF "Skip" para Bot Fight Mode e Managed Challenge).'
      );
    }
    const detalhe = data
      ? JSON.stringify(data)
      : (bruto ? bruto.replace(/\s+/g, ' ').trim().slice(0, 300) : '(corpo vazio)');
    throw new Error(`initSession falhou (${res.status}): ${detalhe}`);
  }
  return data && data.session_token;
}

async function killSession(cfg, sessionToken) {
  try {
    await fetch(`${cfg.apiUrl}/killSession`, {
      method: 'GET',
      headers: cabecalho(cfg, sessionToken, false)
    });
  } catch (_) {
    // encerramento silencioso
  }
}

async function getFullSession(cfg, sessionToken) {
  const res = await fetch(`${cfg.apiUrl}/getFullSession`, {
    method: 'GET',
    headers: cabecalho(cfg, sessionToken, false)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`getFullSession falhou (${res.status}): ${JSON.stringify(data)}`);
  }
  return (data && data.session) || {};
}

async function buscarTodos(cfg, sessionToken, itemtype) {
  const res = await fetch(`${cfg.apiUrl}/${itemtype}?range=0-9999`, {
    method: 'GET',
    headers: cabecalho(cfg, sessionToken, false)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao buscar ${itemtype} (${res.status}): ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? data : [];
}

async function criarChamado(cfg, sessionToken, input) {
  const res = await fetch(`${cfg.apiUrl}/Ticket`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao criar chamado (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function criarValidacao(cfg, sessionToken, input) {
  const res = await fetch(`${cfg.apiUrl}/TicketValidation`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao requisitar validacao (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// --- Detalhe do chamado (painel dedicado) -----------------------------------

async function obterGenerico(cfg, sessionToken, caminho) {
  const res = await fetch(`${cfg.apiUrl}/${caminho}`, {
    method: 'GET',
    headers: cabecalho(cfg, sessionToken, false)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao buscar ${caminho} (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function obterTicket(cfg, sessionToken, id) {
  return obterGenerico(cfg, sessionToken, `Ticket/${id}`);
}

async function obterFollowups(cfg, sessionToken, id) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${id}/ITILFollowup?range=0-499`);
  return Array.isArray(data) ? data : [];
}

async function obterValidacoesTicket(cfg, sessionToken, id) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${id}/TicketValidation?range=0-499`);
  return Array.isArray(data) ? data : [];
}

// Resumo do status de aprovacao de um chamado, para o indicador na listagem.
// Codigos reais do GLPI (confirmados empiricamente): 2=Aguardando, 3=Aprovado, 4=Recusado.
// 'nenhuma' = nao ha nenhum pedido de validacao para este chamado.
async function obterResumoAprovacao(cfg, sessionToken, ticketId) {
  const validacoes = await obterValidacoesTicket(cfg, sessionToken, ticketId);
  if (!validacoes.length) return 'nenhuma';
  if (validacoes.some((v) => Number(v.status) === 2)) return 'aguardando';
  const maisRecente = validacoes
    .slice()
    .sort((a, b) => new Date(b.submission_date) - new Date(a.submission_date))[0];
  if (Number(maisRecente.status) === 4) return 'recusado';
  if (Number(maisRecente.status) === 3) return 'aprovado';
  return 'nenhuma';
}

async function obterDocumentos(cfg, sessionToken, id) {
  const vinculos = await obterGenerico(cfg, sessionToken, `Ticket/${id}/Document_Item?range=0-499`);
  const lista = Array.isArray(vinculos) ? vinculos : [];
  const docs = await Promise.all(
    lista.map(async (v) => {
      try {
        const doc = await obterGenerico(cfg, sessionToken, `Document/${v.documents_id}`);
        return {
          id: doc.id,
          nome: doc.filename || doc.name || `documento-${doc.id}`,
          tamanho: doc.filesize || 0,
          usuarioId: doc.users_id || null,
          data: doc.date_creation || v.date_creation || null
        };
      } catch (_) {
        return null;
      }
    })
  );
  return docs.filter(Boolean);
}

// Vincula um documento ja enviado diretamente ao Ticket (nao ao followup),
// que e exatamente o que obterDocumentos consulta (Ticket/{id}/Document_Item).
// Usado no lugar do campo virtual _documents_id, que em alguns GLPIs vincula
// o documento ao ITILFollowup em vez de ao Ticket, tornando-o invisivel aqui.
async function vincularDocumentoAoTicket(cfg, sessionToken, ticketId, docId) {
  const res = await fetch(`${cfg.apiUrl}/Document_Item`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({
      input: { documents_id: Number(docId), itemtype: 'Ticket', items_id: Number(ticketId) }
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao vincular anexo ao chamado (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Exclusao "suave" do anexo: sem force_purge, o GLPI move para a lixeira
// (mesmo padrao usado para excluir chamados), em vez de apagar definitivamente.
async function excluirDocumento(cfg, sessionToken, docId) {
  const res = await fetch(`${cfg.apiUrl}/Document/${docId}`, {
    method: 'DELETE',
    headers: cabecalho(cfg, sessionToken, true)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao excluir anexo (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function criarFollowup(cfg, sessionToken, ticketId, content, documentIds) {
  const input = { itemtype: 'Ticket', items_id: Number(ticketId), content };
  if (Array.isArray(documentIds) && documentIds.length) {
    input._documents_id = documentIds.map(Number);
  }
  const res = await fetch(`${cfg.apiUrl}/ITILFollowup`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao enviar mensagem (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function editarFollowup(cfg, sessionToken, followupId, content) {
  const res = await fetch(`${cfg.apiUrl}/ITILFollowup/${followupId}`, {
    method: 'PUT',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { id: Number(followupId), content } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao editar mensagem (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function excluirFollowup(cfg, sessionToken, followupId) {
  const res = await fetch(`${cfg.apiUrl}/ITILFollowup/${followupId}`, {
    method: 'DELETE',
    headers: cabecalho(cfg, sessionToken, true)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao excluir mensagem (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function editarTicket(cfg, sessionToken, ticketId, campos) {
  const res = await fetch(`${cfg.apiUrl}/Ticket/${ticketId}`, {
    method: 'PUT',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: Object.assign({ id: Number(ticketId) }, campos) })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao editar chamado (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

const editarTicketConteudo = (cfg, token, ticketId, content) =>
  editarTicket(cfg, token, ticketId, { content });
const alterarStatusTicket = (cfg, token, ticketId, status) =>
  editarTicket(cfg, token, ticketId, { status: Number(status) });

// Exclusao "suave": sem force_purge, o GLPI move o chamado para a lixeira
// (reversivel pela interface web), em vez de apagar definitivamente.
async function excluirTicket(cfg, sessionToken, ticketId) {
  const res = await fetch(`${cfg.apiUrl}/Ticket/${ticketId}`, {
    method: 'DELETE',
    headers: cabecalho(cfg, sessionToken, true)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao excluir chamado (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Atores do chamado: usuarios via Ticket_User e grupos via Group_Ticket.
// type: 1 = requerente, 2 = atribuido, 3 = observador (constantes reais do GLPI/CommonITILActor;
// nao seguem a ordem intuitiva requerente/observador/atribuido).
async function obterAtoresPorTipo(cfg, sessionToken, ticketId, tipo) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${ticketId}/Ticket_User?range=0-99`);
  const linhas = Array.isArray(data) ? data : [];
  return linhas.filter((r) => Number(r.type) === tipo);
}

async function obterGruposAtoresPorTipo(cfg, sessionToken, ticketId, tipo) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${ticketId}/Group_Ticket?range=0-99`);
  const linhas = Array.isArray(data) ? data : [];
  return linhas.filter((r) => Number(r.type) === tipo);
}

// Combina usuarios e grupos atribuidos ao mesmo papel numa unica lista,
// marcando cada item com o itemtype de origem (para remocao correta depois).
async function obterAtoresCombinados(cfg, sessionToken, ticketId, tipo) {
  const [linhasUsuarios, linhasGrupos] = await Promise.all([
    obterAtoresPorTipo(cfg, sessionToken, ticketId, tipo),
    obterGruposAtoresPorTipo(cfg, sessionToken, ticketId, tipo)
  ]);
  const combinado = [];
  linhasUsuarios.forEach((r) =>
    combinado.push({ id: r.id, itemtype: 'Ticket_User', tipoAtor: 'user', refId: r.users_id })
  );
  linhasGrupos.forEach((r) =>
    combinado.push({ id: r.id, itemtype: 'Group_Ticket', tipoAtor: 'group', refId: r.groups_id })
  );
  return combinado;
}
const obterAtribuidos = (cfg, token, ticketId) => obterAtoresCombinados(cfg, token, ticketId, 2);
const obterRequerentesAtuais = (cfg, token, ticketId) => obterAtoresCombinados(cfg, token, ticketId, 1);
const obterObservadoresAtuais = (cfg, token, ticketId) => obterAtoresCombinados(cfg, token, ticketId, 3);

async function adicionarAtor(cfg, sessionToken, ticketId, userId, tipo) {
  const res = await fetch(`${cfg.apiUrl}/Ticket_User`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { tickets_id: Number(ticketId), users_id: Number(userId), type: tipo } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao adicionar ator (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function adicionarGrupoAtor(cfg, sessionToken, ticketId, groupId, tipo) {
  const res = await fetch(`${cfg.apiUrl}/Group_Ticket`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { tickets_id: Number(ticketId), groups_id: Number(groupId), type: tipo } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao adicionar grupo (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Remove qualquer ator (Ticket_User ou Group_Ticket) pelo itemtype e id da linha.
async function removerRelacaoAtor(cfg, sessionToken, itemtype, id) {
  const res = await fetch(`${cfg.apiUrl}/${itemtype}/${id}`, {
    method: 'DELETE',
    headers: cabecalho(cfg, sessionToken, true)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao remover ator (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Sincroniza os atores de um papel: compara o estado atual com o desejado e
// aplica apenas as diferencas (adiciona os novos, remove os que sairam).
// Usado pelo botao "Salvar" do painel lateral, que acumula alteracoes.
async function sincronizarAtores(cfg, sessionToken, ticketId, tipo, desejados) {
  const atuais = await obterAtoresCombinados(cfg, sessionToken, ticketId, tipo);
  const chave = (tipoAtor, refId) => `${tipoAtor}:${refId}`;
  const setDesejado = new Set((desejados || []).map((d) => chave(d.tipoAtor, String(d.id))));
  const setAtual = new Set(atuais.map((a) => chave(a.tipoAtor, String(a.refId))));

  const remover = atuais.filter((a) => !setDesejado.has(chave(a.tipoAtor, String(a.refId))));
  const adicionar = (desejados || []).filter((d) => !setAtual.has(chave(d.tipoAtor, String(d.id))));

  for (const a of remover) {
    await removerRelacaoAtor(cfg, sessionToken, a.itemtype, a.id);
  }
  for (const d of adicionar) {
    if (d.tipoAtor === 'group') {
      await adicionarGrupoAtor(cfg, sessionToken, ticketId, d.id, tipo);
    } else {
      await adicionarAtor(cfg, sessionToken, ticketId, d.id, tipo);
    }
  }
}

// Tarefas (tempo registrado no chamado).
async function obterTasks(cfg, sessionToken, ticketId) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${ticketId}/TicketTask?range=0-499`);
  return Array.isArray(data) ? data : [];
}

async function criarTask(cfg, sessionToken, ticketId, content, actiontime) {
  const res = await fetch(`${cfg.apiUrl}/TicketTask`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({
      input: { tickets_id: Number(ticketId), content, actiontime: Number(actiontime) || 0 }
    })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao registrar tempo (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function editarTask(cfg, sessionToken, taskId, content) {
  const res = await fetch(`${cfg.apiUrl}/TicketTask/${taskId}`, {
    method: 'PUT',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { id: Number(taskId), content } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao editar tarefa (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Solucoes do chamado (ITILSolution): a proposta de fechamento e a resposta
// (aprovada/recusada) de quem abriu o chamado.
async function obterSolucoes(cfg, sessionToken, ticketId) {
  const data = await obterGenerico(cfg, sessionToken, `Ticket/${ticketId}/ITILSolution?range=0-99`);
  return Array.isArray(data) ? data : [];
}

async function editarSolucao(cfg, sessionToken, solucaoId, content) {
  const res = await fetch(`${cfg.apiUrl}/ITILSolution/${solucaoId}`, {
    method: 'PUT',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { id: Number(solucaoId), content } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao editar solucao (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function criarSolucao(cfg, sessionToken, ticketId, content) {
  const res = await fetch(`${cfg.apiUrl}/ITILSolution`, {
    method: 'POST',
    headers: cabecalho(cfg, sessionToken, true),
    body: JSON.stringify({ input: { itemtype: 'Ticket', items_id: Number(ticketId), content } })
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao adicionar solucao (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Upload de anexo (multipart) e vinculo posterior via _documents_id na criacao do followup.
async function uploadDocumento(cfg, sessionToken, nomeArquivo, mimeType, base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const blob = new Blob([buffer], { type: mimeType || 'application/octet-stream' });
  const fd = new FormData();
  fd.append('uploadManifest', JSON.stringify({ input: { name: nomeArquivo, _filename: [nomeArquivo] } }));
  fd.append('filename[0]', blob, nomeArquivo);
  const res = await fetch(`${cfg.apiUrl}/Document`, {
    method: 'POST',
    headers: { 'App-Token': cfg.appToken, 'Session-Token': sessionToken, 'User-Agent': USER_AGENT },
    body: fd
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha ao enviar anexo (${res.status}): ${JSON.stringify(data)}`);
  }
  return data.id;
}

// Formata uma data para o formato aceito pela search API do GLPI.
function paraDataGlpi(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function urlDocumento(apiUrl, docId) {
  const base = String(apiUrl)
    .replace(/\/+$/, '')
    .replace(/\/apirest\.php$/i, '')
    .replace(/\/api\.php(\/v\d+)?$/i, '');
  return `${base}/front/document.send.php?docid=${docId}`;
}

// Baixa o conteudo binario do documento. A API legada do GLPI usa o mesmo
// endpoint de metadados (GET /Document/{id}), mas retorna os bytes brutos
// quando o cabecalho Accept pede application/octet-stream.
async function baixarDocumento(cfg, sessionToken, docId) {
  const res = await fetch(`${cfg.apiUrl}/Document/${docId}`, {
    method: 'GET',
    headers: {
      'App-Token': cfg.appToken,
      'Session-Token': sessionToken,
      'User-Agent': USER_AGENT,
      Accept: 'application/octet-stream'
    }
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(`Falha ao baixar anexo (${res.status}): ${JSON.stringify(data)}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
}

const EXT_IMAGEM = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
function mimePorExtensao(nomeArquivo) {
  const ext = String(nomeArquivo || '').split('.').pop().toLowerCase();
  const mapa = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
  };
  return { ext, ehImagem: EXT_IMAGEM.has(ext), mime: mapa[ext] || 'application/octet-stream' };
}

function formatarTamanho(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(2) + ' KiB';
  return (b / (1024 * 1024)).toFixed(2) + ' MiB';
}

const STATUS_VALIDACAO = { 1: 'Aguardando', 2: 'Aprovado', 3: 'Recusado', 4: 'Reencaminhado' };
function paramsCriteria(criteria) {
  const p = new URLSearchParams();
  criteria.forEach((c, i) => {
    if (i > 0) p.append(`criteria[${i}][link]`, c.link || 'AND');
    p.append(`criteria[${i}][field]`, String(c.field));
    p.append(`criteria[${i}][searchtype]`, c.searchtype || 'equals');
    p.append(`criteria[${i}][value]`, String(c.value));
  });
  return p;
}

// Conta chamados que batem com os criteria (le totalcount, independente de range).
async function contarTickets(cfg, sessionToken, criteria) {
  const p = paramsCriteria(criteria || []);
  p.append('range', '0-0');
  const res = await fetch(`${cfg.apiUrl}/search/Ticket?${p.toString()}`, {
    method: 'GET',
    headers: cabecalho(cfg, sessionToken, false)
  });
  const data = await res.json().catch(() => null);
  if (data && typeof data.totalcount === 'number') return data.totalcount;
  if (!res.ok) {
    throw new Error(`Falha ao contar chamados (${res.status}): ${JSON.stringify(data)}`);
  }
  return 0;
}

// Converte uma linha crua da search API num objeto de chamado.
function mapearLinhaTicket(r) {
  return {
    id: r[String(CAMPO.id)],
    titulo: r[String(CAMPO.titulo)] || '',
    status: r[String(CAMPO.status)] || '',
    tecnico: r[String(CAMPO.tecnico)] || '',
    requerente: r[String(CAMPO.requerente)] || '',
    prazo: r[String(CAMPO.prazo)] || '',
    descricao: r[String(CAMPO.descricao)] || '',
    data: r[String(CAMPO.dataAbertura)] || ''
  };
}

// Mapeadores compartilhados (usados na criacao e no card lateral de detalhes).
function mapearOpcoes(arr) {
  return arr
    .map((i) => ({ id: i.id, name: i.completename || i.name || `#${i.id}` }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapearCategoriasOpcoes(arr) {
  return arr
    .map((i) => ({
      id: i.id,
      name: i.completename || i.name || `#${i.id}`,
      is_incident: i.is_incident === undefined ? null : Number(i.is_incident),
      is_request: i.is_request === undefined ? null : Number(i.is_request)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mapearUsuariosOpcoes(arr) {
  return arr
    .map((u) => ({
      id: u.id,
      name: ((u.firstname || '') + ' ' + (u.realname || '')).trim() || u.name || `#${u.id}`
    }))
    .filter((x) => x.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Busca chamados aplicando o filtro (status/tecnico/id) via search API.
async function buscarTicketsFiltrado(cfg, sessionToken, filtro, limite = 50) {
  // Busca por ID especifico: ignora os demais criterios, traz so aquele chamado.
  if (filtro && filtro.ticketId) {
    const p0 = new URLSearchParams();
    p0.append('criteria[0][field]', String(CAMPO.id));
    p0.append('criteria[0][searchtype]', 'equals');
    p0.append('criteria[0][value]', String(filtro.ticketId));
    [
      CAMPO.id,
      CAMPO.titulo,
      CAMPO.status,
      CAMPO.tecnico,
      CAMPO.requerente,
      CAMPO.prazo,
      CAMPO.descricao,
      CAMPO.dataAbertura
    ].forEach((f, i) => p0.append(`forcedisplay[${i}]`, String(f)));
    p0.append('range', '0-0');
    const res0 = await fetch(`${cfg.apiUrl}/search/Ticket?${p0.toString()}`, {
      method: 'GET',
      headers: cabecalho(cfg, sessionToken, false)
    });
    const data0 = await res0.json().catch(() => null);
    if (!res0.ok) {
      throw new Error(`Falha na busca (${res0.status}): ${JSON.stringify(data0)}`);
    }
    const linhas0 = (data0 && data0.data) || [];
    return linhas0.map((r) => mapearLinhaTicket(r));
  }

  // "Nao solucionado" = status em (1,2,3,4): Novo, em atendimento (atrib./plan.) e Pendente.
  let statusIn = filtro && filtro.statusIn;
  if (!statusIn && filtro && filtro.naoSolucionado) statusIn = [1, 2, 3, 4];

  const p = new URLSearchParams();
  let idx = 0;

  // Tecnico atribuido.
  if (filtro && filtro.tecnicoId) {
    p.append(`criteria[${idx}][field]`, String(CAMPO.tecnico));
    p.append(`criteria[${idx}][searchtype]`, 'equals');
    p.append(`criteria[${idx}][value]`, String(filtro.tecnicoId));
    idx++;
  }

  // Status: um valor especifico (equals) ou um conjunto (grupo OR aninhado).
  if (filtro && filtro.statusId) {
    if (idx > 0) p.append(`criteria[${idx}][link]`, 'AND');
    p.append(`criteria[${idx}][field]`, String(CAMPO.status));
    p.append(`criteria[${idx}][searchtype]`, 'equals');
    p.append(`criteria[${idx}][value]`, String(filtro.statusId));
    idx++;
  } else if (Array.isArray(statusIn) && statusIn.length) {
    if (idx > 0) p.append(`criteria[${idx}][link]`, 'AND');
    statusIn.forEach((st, j) => {
      if (j > 0) p.append(`criteria[${idx}][criteria][${j}][link]`, 'OR');
      p.append(`criteria[${idx}][criteria][${j}][field]`, String(CAMPO.status));
      p.append(`criteria[${idx}][criteria][${j}][searchtype]`, 'equals');
      p.append(`criteria[${idx}][criteria][${j}][value]`, String(st));
    });
    idx++;
  }

  [
    CAMPO.id,
    CAMPO.titulo,
    CAMPO.status,
    CAMPO.tecnico,
    CAMPO.requerente,
    CAMPO.prazo,
    CAMPO.descricao,
    CAMPO.dataAbertura
  ].forEach((f, i) => p.append(`forcedisplay[${i}]`, String(f)));
  p.append('sort', String((filtro && filtro.sortField) || CAMPO.id));
  p.append('order', (filtro && filtro.sortOrder) || 'DESC');
  p.append('range', `0-${limite - 1}`);

  const res = await fetch(`${cfg.apiUrl}/search/Ticket?${p.toString()}`, {
    method: 'GET',
    headers: cabecalho(cfg, sessionToken, false)
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Falha na busca (${res.status}): ${JSON.stringify(data)}`);
  }
  const linhas = (data && data.data) || [];
  return linhas.map((r) => mapearLinhaTicket(r));
}

// Sessao compartilhada e reaproveitada entre chamadas, em vez de abrir/fechar
// uma sessao nova a cada operacao. Isso evita disparar varios logins quase
// simultaneos no GLPI (lista, meus atribuidos, painel, formulario, notificacoes
// costumam carregar ao mesmo tempo), o que alguns GLPIs/proxies bloqueiam com
// 403 por parecer forca bruta. A sessao e renovada um pouco antes do tempo
// assumido de expiracao, e tambem se qualquer chamada relatar 401/403.
let cacheSessao = { token: null, apiUrl: null, expiraEm: 0 };
// Login em andamento, compartilhado por todos os chamadores. Sem isso, as views
// que carregam juntas (lista, meus atribuidos, painel, formulario, notificacoes)
// encontram o cache vazio ao mesmo tempo e disparam um initSession cada uma --
// exatamente a rajada de logins que faz WAF/proxy responder 403.
let loginEmAndamento = null;
const DURACAO_SESSAO_MS = 4 * 60 * 1000; // renovada antes do timeout tipico do GLPI

function limparCacheSessao() {
  cacheSessao = { token: null, apiUrl: null, expiraEm: 0 };
  loginEmAndamento = null;
}

async function obterTokenSessao(cfg) {
  const agora = Date.now();
  if (cacheSessao.token && cacheSessao.apiUrl === cfg.apiUrl && agora < cacheSessao.expiraEm) {
    return cacheSessao.token;
  }
  if (loginEmAndamento) return loginEmAndamento;
  loginEmAndamento = (async () => {
    try {
      const token = await initSession(cfg);
      cacheSessao = { token, apiUrl: cfg.apiUrl, expiraEm: Date.now() + DURACAO_SESSAO_MS };
      return token;
    } finally {
      loginEmAndamento = null;
    }
  })();
  return loginEmAndamento;
}

async function comSessao(cfg, fn) {
  const token = await obterTokenSessao(cfg);
  try {
    return await fn(token);
  } catch (e) {
    const msg = String((e && e.message) || '');
    // Retry so quando a chamada de dados falhou por sessao invalida. Se o
    // proprio initSession devolveu 403, repetir apenas soma mais um login a
    // uma rajada que ja esta sendo barrada.
    if (msg.startsWith('initSession falhou')) throw e;
    // Sessao pode ter expirado/sido invalidada no meio do caminho: tenta uma
    // vez com uma sessao nova antes de desistir.
    if (msg.includes('(401)') || msg.includes('(403)')) {
      limparCacheSessao();
      const novoToken = await obterTokenSessao(cfg);
      return await fn(novoToken);
    }
    throw e;
  }
}

// Cache simples do mapa de usuarios (id -> "Nome Sobrenome"), para resolver
// requerente/tecnico quando a search API retorna apenas o ID numerico.
let cacheUsuarios = { ts: 0, mapa: {} };
const TTL_CACHE_USUARIOS_MS = 5 * 60 * 1000;

async function obterMapaUsuarios(cfg, sessionToken) {
  const agora = Date.now();
  if (agora - cacheUsuarios.ts < TTL_CACHE_USUARIOS_MS && Object.keys(cacheUsuarios.mapa).length) {
    return cacheUsuarios.mapa;
  }
  const users = await buscarTodos(cfg, sessionToken, 'User');
  const mapa = {};
  users.forEach((u) => {
    const nome = ((u.firstname || '') + ' ' + (u.realname || '')).trim() || u.name || `#${u.id}`;
    mapa[String(u.id)] = nome;
  });
  cacheUsuarios = { ts: agora, mapa };
  return mapa;
}

// Resolve um valor de campo de ator: se for puramente numerico, troca pelo nome
// no mapa; caso contrario (ja veio como texto), mantem como esta.
function resolverAtor(valor, mapaUsuarios) {
  const s = String(valor || '').trim();
  if (!s) return '';
  if (/^\d+$/.test(s) && mapaUsuarios && mapaUsuarios[s]) return mapaUsuarios[s];
  return s;
}

// Icone (cosmetico) inferido do rotulo de status; o rotulo real vem da search API.
// Detecta a qual status um valor (texto ou codigo numerico) corresponde.
function chaveStatus(valor) {
  const bruto = String(valor || '').trim().toLowerCase();
  const mapaCodigo = { '1': 'novo', '2': 'atribuido', '3': 'planejado', '4': 'pendente', '5': 'solucionado', '6': 'fechado' };
  if (mapaCodigo[bruto]) return mapaCodigo[bruto];
  if (bruto.includes('fech') || bruto.includes('clos')) return 'fechado';
  if (bruto.includes('soluc') || bruto.includes('solv')) return 'solucionado';
  if (bruto.includes('pend')) return 'pendente';
  if (bruto.includes('planej')) return 'planejado';
  if (bruto.includes('atribu') || bruto.includes('atend')) return 'atribuido';
  if (bruto.includes('nov') || bruto.includes('new')) return 'novo';
  return null;
}

const TEXTO_STATUS = {
  novo: 'Novo',
  atribuido: 'Em atendimento (atribuido)',
  planejado: 'Em atendimento (planejado)',
  pendente: 'Pendente',
  solucionado: 'Solucionado',
  fechado: 'Fechado'
};

// Sempre retorna o texto legivel do status, mesmo que a API tenha mandado
// apenas o codigo numerico cru nesse campo.
function textoStatus(valor) {
  const chave = chaveStatus(valor);
  return chave ? TEXTO_STATUS[chave] : (String(valor || '').trim() || '-');
}

// Icone (e cor) do status do chamado. Aceita tanto o texto retornado pela
// search API (ex: "Fechado") quanto o codigo numerico cru (ex: "6"), pois
// algumas instancias do GLPI retornam um ou outro nesse campo.
// Emoji colorido para o status do chamado, exibido no proprio texto do item.
const EMOJI_STATUS = {
  novo: '\uD83D\uDD35', // azul
  atribuido: '\uD83D\uDFE1', // amarelo
  planejado: '\uD83D\uDFE2', // verde
  pendente: '\uD83D\uDFE3', // roxo
  solucionado: '\uD83D\uDFE4', // marrom
  fechado: '\uD83D\uDFE4' // marrom
};

function emojiStatusTexto(valor) {
  const chave = chaveStatus(valor);
  return EMOJI_STATUS[chave] || '\u26AA';
}

// Emoji colorido para o status de aprovacao, tambem no texto do item.
const EMOJI_APROVACAO = {
  aguardando: '\uD83D\uDFE1', // amarelo
  aprovado: '\uD83D\uDFE2', // verde
  recusado: '\uD83D\uDD34', // vermelho
  nenhuma: '\u26AA' // branco/cinza
};

// Icone nativo (slot a esquerda do texto): so o quadrado de "visualizado",
// com espaco de sobra para nao ficar minusculo (o slot do VSCode e pequeno
// demais para caber 3 formas legiveis, entao status/aprovacao ficam no texto).
const cacheIconesVisto = new Map();
async function obterIconeVisto(visualizado) {
  const chaveCache = visualizado ? 'v' : 'n';
  if (cacheIconesVisto.has(chaveCache)) return cacheIconesVisto.get(chaveCache);

  const corVisto = '#4b5563';
  const svg = visualizado
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<rect x="2" y="2" width="12" height="12" rx="2" fill="${corVisto}"/>` +
      `</svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
      `<rect x="2" y="2" width="12" height="12" rx="2" fill="none" stroke="#9ca3af" stroke-width="1.6"/>` +
      `</svg>`;

  const dir = path.join(os.tmpdir(), 'glpi-icones');
  await fsp.mkdir(dir, { recursive: true });
  const arquivo = path.join(dir, `icone-visto-${chaveCache}.svg`);
  await fsp.writeFile(arquivo, svg, 'utf8');
  const uri = vscode.Uri.file(arquivo);
  cacheIconesVisto.set(chaveCache, uri);
  return uri;
}

function urlChamadoWeb(apiUrl, id) {
  const base = String(apiUrl)
    .replace(/\/+$/, '') // barra final
    .replace(/\/apirest\.php$/i, '') // API REST classica
    .replace(/\/api\.php(\/v\d+)?$/i, ''); // API nova (api.php ou api.php/vN)
  return `${base}/front/ticket.form.php?id=${id}`;
}

// Remove tags HTML e entidades comuns (a descricao do GLPI vem com marcacao).
function limparHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Cria um item de arvore para um chamado (usado pelas duas listagens).

function criarItemTicket(cred, t, mapaUsuarios, statusAprovacao, visualizado, iconUri) {
  const emojiStat = emojiStatusTexto(t.status);
  const emojiAprov = EMOJI_APROVACAO[statusAprovacao] || EMOJI_APROVACAO.nenhuma;
  const item = new vscode.TreeItem(`${emojiStat} ${emojiAprov} #${t.id} ${t.titulo}`.trim());
  item.description = textoStatus(t.status);
  const desc = limparHtml(t.descricao);
  const descCurta = desc.length > 500 ? desc.slice(0, 500) + '...' : desc;
  const requerenteNome = resolverAtor(t.requerente, mapaUsuarios) || '-';
  const tecnicoNome = resolverAtor(t.tecnico, mapaUsuarios) || '-';
  const TEXTO_APROVACAO = {
    aguardando: 'Aguardando aprovacao',
    aprovado: 'Aprovado',
    recusado: 'Recusado',
    nenhuma: 'Sem pedido de aprovacao'
  };
  item.tooltip =
    `#${t.id} - ${t.titulo}\n` +
    `Status: ${textoStatus(t.status)}\n` +
    `Aprovacao: ${TEXTO_APROVACAO[statusAprovacao] || TEXTO_APROVACAO.nenhuma}\n` +
    `Visualizado: ${visualizado ? 'Sim' : 'Nao'}\n` +
    `Requerente: ${requerenteNome}\n` +
    `Atribuido: ${tecnicoNome}\n` +
    `Prazo: ${t.prazo || '-'}\n\n` +
    `Descricao:\n${descCurta || '(sem descricao)'}`;
  item.iconPath = iconUri;
  // Dois contextValue distintos (sem substring em comum) para os menus de
  // contexto "Marcar como visualizado" / "Remover visualizado" alternarem certo.
  item.contextValue = visualizado ? 'chamadoVisto' : 'chamadoNvisto';
  item.ticketId = t.id;
  item.tituloAtual = t.titulo;
  item.command = {
    command: 'glpi.abrirDetalhes',
    title: 'Abrir chamado',
    arguments: [t.id]
  };
  return item;
}

// Marcacao manual de "visualizado", puramente local (nao existe no GLPI).
// Guardada como lista de ids no globalState do VSCode.
function obterVisualizados(context) {
  return new Set((context.globalState.get('glpi.visualizados', []) || []).map(String));
}

async function definirVisualizado(context, ticketId, visto) {
  const atuais = obterVisualizados(context);
  const idStr = String(ticketId);
  if (visto) atuais.add(idStr);
  else atuais.delete(idStr);
  await context.globalState.update('glpi.visualizados', Array.from(atuais));
}

function descricaoFiltro(f) {
  const p = [];
  if (f && f.statusLabel) p.push('Status: ' + f.statusLabel);
  if (f && f.tecnicoNome) p.push('Tec: ' + f.tecnicoNome);
  return p.join('  \u00b7  ');
}

// ---------------------------------------------------------------------------
// Seccao 1: formulario de abertura (webview)
// ---------------------------------------------------------------------------
class GlpiFormProvider {
  static viewId = 'glpi.chamado';

  constructor(context, onChamadoCriado) {
    this.context = context;
    this.onChamadoCriado = onChamadoCriado;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'pronto' || msg.type === 'recarregar') await this.carregarDropdowns();
      else if (msg.type === 'submit') await this.enviar(msg.payload);
    });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  async obterCredenciais() {
    let cred = await lerCredenciais(this.context);
    if (credenciaisCompletas(cred)) return cred;
    cred = await pedirCredenciais(this.context);
    return credenciaisCompletas(cred) ? cred : null;
  }

  async carregarDropdowns() {
    const cfg = await this.obterCredenciais();
    if (!cfg) {
      this.post({
        type: 'erro',
        message: 'Credenciais nao informadas. Use o icone de engrenagem no topo para configurar.'
      });
      return;
    }
    try {
      const { cats, locs, users, groups } = await comSessao(cfg, async (token) => {
        const [cats, locs, users, groups] = await Promise.all([
          buscarTodos(cfg, token, 'ITILCategory'),
          buscarTodos(cfg, token, 'Location'),
          buscarTodos(cfg, token, 'User'),
          buscarTodos(cfg, token, 'Group')
        ]);
        return { cats, locs, users, groups };
      });
      this.post({
        type: 'dropdowns',
        categorias: mapearCategoriasOpcoes(cats),
        localizacoes: mapearOpcoes(locs),
        usuarios: mapearUsuariosOpcoes(users),
        grupos: mapearOpcoes(groups)
      });
    } catch (e) {
      this.post({ type: 'erro', message: String(e.message || e) });
    }
  }

  async enviar(payload) {
    if (!payload.titulo || !payload.descricao) {
      this.post({ type: 'erro', message: 'Titulo e descricao sao obrigatorios.' });
      return;
    }
    const cfg = await this.obterCredenciais();
    if (!cfg) {
      this.post({ type: 'erro', message: 'Credenciais nao informadas.' });
      return;
    }
    try {
      const id = await comSessao(cfg, async (token) => {
        const sessao = await getFullSession(cfg, token);
        const meuId = sessao && sessao.glpiID;
        const input = { name: payload.titulo, content: payload.descricao };
        input.type = Number(payload.tipo) || 1; // 1 = Incidente, 2 = Requisicao
        input.status = Number(payload.status) || 2; // padrao: Em atendimento (atribuido)
        if (payload.categoriaId) input.itilcategories_id = Number(payload.categoriaId);
        if (payload.localizacaoId) input.locations_id = Number(payload.localizacaoId);
        if (payload.actiontime) input.actiontime = Number(payload.actiontime);

        // Atores (multiplos, usuarios e/ou grupos).
        // Vazio -> padrao: requerente e atribuido = usuario atual (so usuarios).
        const paraIds = (arr) => (Array.isArray(arr) ? arr.map(Number).filter(Boolean) : []);
        const reqUsuarios = paraIds(payload.requerentesUsuarios);
        const reqGrupos = paraIds(payload.requerentesGrupos);
        const obsUsuarios = paraIds(payload.observadoresUsuarios);
        const obsGrupos = paraIds(payload.observadoresGrupos);
        const atbUsuarios = paraIds(payload.atribuidosUsuarios);
        const atbGrupos = paraIds(payload.atribuidosGrupos);

        if (reqUsuarios.length) input._users_id_requester = reqUsuarios;
        else if (!reqGrupos.length && meuId) input._users_id_requester = [meuId];
        if (reqGrupos.length) input._groups_id_requester = reqGrupos;

        if (atbUsuarios.length) input._users_id_assign = atbUsuarios;
        else if (!atbGrupos.length && meuId) input._users_id_assign = [meuId];
        if (atbGrupos.length) input._groups_id_assign = atbGrupos;

        if (obsUsuarios.length) input._users_id_observer = obsUsuarios;
        if (obsGrupos.length) input._groups_id_observer = obsGrupos;

        const r = await criarChamado(cfg, token, input);
        const novoId = Array.isArray(r) ? r[0] && r[0].id : r.id;

        // Requisicao de validacao (item TicketValidation a parte).
        if (payload.requisitarValidacao && payload.validatorId && novoId) {
          const vinput = { tickets_id: Number(novoId), comment_submission: '' };
          if (payload.validatorType === 'group') {
            vinput.groups_id_validate = Number(payload.validatorId);
          } else {
            vinput.users_id_validate = Number(payload.validatorId);
          }
          await criarValidacao(cfg, token, vinput);
        }
        return novoId;
      });
      this.post({ type: 'sucesso', id });
      vscode.window.showInformationMessage(`Chamado #${id} criado no GLPI.`);
      if (this.onChamadoCriado) this.onChamadoCriado();
    } catch (e) {
      this.post({ type: 'erro', message: String(e.message || e) });
    }
  }

  html() {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           padding: 8px 4px; font-size: 13px; }
    label { display: block; margin: 12px 0 4px; font-weight: 600; }
    input, textarea, select {
      width: 100%; box-sizing: border-box; padding: 5px 6px;
      background: var(--vscode-input-background); color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px;
      font-family: inherit; font-size: 13px;
    }
    textarea { resize: vertical; min-height: 80px; }
    .linha2 { display: flex; gap: 6px; }
    .linha2 > div { flex: 1; }
    .duracao { display: flex; gap: 6px; }
    .duracao > div { flex: 1; }
    button {
      margin-top: 16px; width: 100%; padding: 7px 12px; cursor: pointer;
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border: none; border-radius: 2px; font-size: 13px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    #status { margin-top: 14px; padding: 8px; border-radius: 2px; display: none; white-space: pre-wrap; }
    #status.erro { display: block; background: var(--vscode-inputValidation-errorBackground);
                   border: 1px solid var(--vscode-inputValidation-errorBorder); }
    #status.ok { display: block; background: var(--vscode-inputValidation-infoBackground, #1e3a2f);
                 border: 1px solid var(--vscode-inputValidation-infoBorder, #2ea043); }
    .hint { opacity: .7; font-weight: 400; font-size: 11px; }
    .check { display: flex; align-items: center; gap: 6px; margin-top: 14px; font-weight: 600; }
    .check input { width: auto; }
    .ator { display: flex; gap: 6px; align-items: center; margin-top: 4px; }
    .ator select { flex: 1; }
    .ator button { width: auto; margin-top: 0; padding: 5px 12px; flex: 0 0 auto; border-radius: 5px; }
    .chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px 3px 4px; border-radius: 12px;
            background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
    .chip .avatarMini { width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center;
                         justify-content: center; font-size: 9px; font-weight: 700; color: #fff; flex: 0 0 auto; }
    .chip .x { cursor: pointer; opacity: .75; font-weight: 700; }
    .chip .x:hover { opacity: 1; }
  </style>
</head>
<body>
  <label for="titulo">Titulo *</label>
  <input id="titulo" type="text" />
  <label for="descricao">Descricao *</label>
  <textarea id="descricao"></textarea>
  <div class="linha2">
    <div>
      <label for="tipo">Tipo</label>
      <select id="tipo">
        <option value="1">Incidente</option>
        <option value="2">Requisicao</option>
      </select>
    </div>
    <div>
      <label for="statusTicket">Status</label>
      <select id="statusTicket">
        <option value="2">Em atendimento (atribuido)</option>
        <option value="1">Novo</option>
        <option value="3">Em atendimento (planejado)</option>
        <option value="4">Pendente</option>
        <option value="5">Solucionado</option>
        <option value="6">Fechado</option>
      </select>
    </div>
  </div>
  <label for="categoria">Categoria <span class="hint">(do GLPI)</span></label>
  <select id="categoria"><option value="">Carregando...</option></select>
  <label for="localizacao">Localizacao <span class="hint">(do GLPI)</span></label>
  <select id="localizacao"><option value="">Carregando...</option></select>
  <label>Requerentes <span class="hint">(vazio = voce)</span></label>
  <div class="ator">
    <select id="reqSelect"><option value="">Carregando...</option></select>
    <button type="button" id="reqAdd">Adicionar</button>
  </div>
  <div id="reqChips" class="chips"></div>
  <label>Observadores</label>
  <div class="ator">
    <select id="obsSelect"><option value="">Carregando...</option></select>
    <button type="button" id="obsAdd">Adicionar</button>
  </div>
  <div id="obsChips" class="chips"></div>
  <label>Atribuidos <span class="hint">(vazio = voce)</span></label>
  <div class="ator">
    <select id="atbSelect"><option value="">Carregando...</option></select>
    <button type="button" id="atbAdd">Adicionar</button>
  </div>
  <div id="atbChips" class="chips"></div>
  <label>Duracao total</label>
  <div class="duracao">
    <div><input id="dias" type="number" min="0" placeholder="dias" /></div>
    <div><input id="horas" type="number" min="0" placeholder="horas" /></div>
    <div><input id="minutos" type="number" min="0" max="59" placeholder="minutos" /></div>
  </div>
  <label class="check"><input type="checkbox" id="reqValidacao" /> Requisitar validacao</label>
  <div id="blocoValidacao" style="display:none">
    <label for="validatorType">Tipo de validador</label>
    <select id="validatorType">
      <option value="user">Usuario</option>
      <option value="group">Grupo</option>
    </select>
    <label for="validator">Validador</label>
    <select id="validator"><option value="">-- Selecione --</option></select>
  </div>
  <button id="enviar" disabled>Abrir chamado</button>
  <div id="status"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const btn = $('enviar');
    const status = $('status');
    function preencher(select, itens) {
      select.innerHTML = '<option value="">-- Selecione --</option>';
      for (const it of itens) {
        const o = document.createElement('option');
        o.value = it.id; o.textContent = it.name; select.appendChild(o);
      }
    }
    // Preenche um select com dois grupos visuais: Usuarios e Grupos.
    // O value de cada option carrega o tipo (u: ou g:) para diferenciar no envio.
    function preencherComGrupos(select, listaUsuarios, listaGrupos) {
      select.innerHTML = '<option value="">-- Selecione --</option>';
      if (listaUsuarios.length) {
        const og = document.createElement('optgroup'); og.label = 'Usuarios';
        listaUsuarios.forEach((it) => {
          const o = document.createElement('option');
          o.value = 'u:' + it.id; o.textContent = it.name; og.appendChild(o);
        });
        select.appendChild(og);
      }
      if (listaGrupos.length) {
        const og = document.createElement('optgroup'); og.label = 'Grupos';
        listaGrupos.forEach((it) => {
          const o = document.createElement('option');
          o.value = 'g:' + it.id; o.textContent = it.name; og.appendChild(o);
        });
        select.appendChild(og);
      }
    }
    function mostrarStatus(texto, tipo) { status.textContent = texto; status.className = tipo; }
    let usuarios = [];
    let grupos = [];
    let categoriasTodas = [];
    function popularCategorias() {
      const tipo = $('tipo').value;
      const visiveis = categoriasTodas.filter((c) => {
        const flag = tipo === '2' ? c.is_request : c.is_incident;
        return flag === null || flag === undefined ? true : Number(flag) === 1;
      });
      preencher($('categoria'), visiveis);
    }
    $('tipo').addEventListener('change', popularCategorias);
    function popularValidador() {
      const tipo = $('validatorType').value;
      preencher($('validator'), tipo === 'group' ? grupos : usuarios);
    }
    $('reqValidacao').addEventListener('change', () => {
      $('blocoValidacao').style.display = $('reqValidacao').checked ? 'block' : 'none';
    });
    $('validatorType').addEventListener('change', popularValidador);

    const atores = { req: [], obs: [], atb: [] };
    function iniciaisCor(nome) {
      const partes = String(nome || '?').trim().split(/\s+/);
      const iniciais = ((partes[0]||'')[0] || '?') + ((partes[1]||'')[0] || '');
      let hash = 0;
      for (let i = 0; i < String(nome).length; i++) hash = String(nome).charCodeAt(i) + ((hash << 5) - hash);
      return { iniciais: iniciais.toUpperCase(), cor: 'hsl(' + (Math.abs(hash) % 360) + ', 55%, 45%)' };
    }
    function preencherAtores() {
      ['req', 'obs', 'atb'].forEach((k) => preencherComGrupos($(k + 'Select'), usuarios, grupos));
    }
    function renderChips(k) {
      const cont = $(k + 'Chips'); cont.innerHTML = '';
      atores[k].forEach((a) => {
        const chip = document.createElement('span'); chip.className = 'chip';
        const av = iniciaisCor(a.name);
        const avatar = document.createElement('span'); avatar.className = 'avatarMini';
        avatar.style.background = av.cor; avatar.textContent = av.iniciais;
        const nome = document.createElement('span');
        nome.textContent = a.name + (a.tipo === 'group' ? ' (grupo)' : '');
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '\u00D7';
        x.addEventListener('click', () => {
          atores[k] = atores[k].filter((it) => !(it.tipo === a.tipo && String(it.id) === String(a.id)));
          renderChips(k);
        });
        chip.appendChild(avatar); chip.appendChild(nome); chip.appendChild(x); cont.appendChild(chip);
      });
    }
    function addAtor(k) {
      const sel = $(k + 'Select');
      const raw = sel.value;
      if (!raw) return;
      const tipo = raw.startsWith('g:') ? 'group' : 'user';
      const id = raw.slice(2);
      const name = sel.options[sel.selectedIndex].text;
      if (!atores[k].some((a) => a.tipo === tipo && String(a.id) === String(id))) {
        atores[k].push({ id: id, name: name, tipo: tipo });
        renderChips(k);
      }
    }
    $('reqAdd').addEventListener('click', () => addAtor('req'));
    $('obsAdd').addEventListener('click', () => addAtor('obs'));
    $('atbAdd').addEventListener('click', () => addAtor('atb'));

    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'dropdowns') {
        categoriasTodas = m.categorias || [];
        popularCategorias();
        preencher($('localizacao'), m.localizacoes);
        usuarios = m.usuarios || [];
        grupos = m.grupos || [];
        popularValidador();
        preencherAtores();
        btn.disabled = false;
      } else if (m.type === 'erro') {
        mostrarStatus('Erro: ' + m.message, 'erro');
        btn.disabled = false; btn.textContent = 'Abrir chamado';
      } else if (m.type === 'sucesso') {
        mostrarStatus('Chamado #' + m.id + ' criado com sucesso.', 'ok');
        btn.disabled = false; btn.textContent = 'Abrir chamado';
        $('titulo').value = ''; $('descricao').value = '';
        $('dias').value = ''; $('horas').value = ''; $('minutos').value = '';
        $('reqValidacao').checked = false;
        $('blocoValidacao').style.display = 'none';
        $('validator').value = '';
        atores.req = []; atores.obs = []; atores.atb = [];
        renderChips('req'); renderChips('obs'); renderChips('atb');
      }
    });
    btn.addEventListener('click', () => {
      const dias = parseInt($('dias').value || '0', 10);
      const horas = parseInt($('horas').value || '0', 10);
      const minutos = parseInt($('minutos').value || '0', 10);
      const actiontime = ((dias * 24 + horas) * 60 + minutos) * 60;
      btn.disabled = true; btn.textContent = 'Enviando...'; mostrarStatus('', '');
      vscode.postMessage({ type: 'submit', payload: {
        titulo: $('titulo').value.trim(), descricao: $('descricao').value.trim(),
        tipo: $('tipo').value,
        status: $('statusTicket').value,
        categoriaId: $('categoria').value, localizacaoId: $('localizacao').value,
        actiontime: actiontime || 0,
        requerentesUsuarios: atores.req.filter((a) => a.tipo === 'user').map((a) => a.id),
        requerentesGrupos: atores.req.filter((a) => a.tipo === 'group').map((a) => a.id),
        observadoresUsuarios: atores.obs.filter((a) => a.tipo === 'user').map((a) => a.id),
        observadoresGrupos: atores.obs.filter((a) => a.tipo === 'group').map((a) => a.id),
        atribuidosUsuarios: atores.atb.filter((a) => a.tipo === 'user').map((a) => a.id),
        atribuidosGrupos: atores.atb.filter((a) => a.tipo === 'group').map((a) => a.id),
        requisitarValidacao: $('reqValidacao').checked,
        validatorType: $('validatorType').value,
        validatorId: $('validator').value
      }});
    });
    vscode.postMessage({ type: 'pronto' });
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Seccao 2: listagem de chamados (TreeView) com filtro
// ---------------------------------------------------------------------------
class GlpiListaProvider {
  static viewId = 'glpi.lista';

  constructor(context) {
    this.context = context;
    this.filtro = {};
    this.buscaId = null;
    this.ordenacao = { campo: null, ordem: 'DESC', label: 'Mais recentes' };
    this.limite = 50;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.itens = null;
  }

  setFiltro(f) {
    this.filtro = f || {};
    this.limite = 50;
    this.refresh();
  }

  setBuscaId(id) {
    this.buscaId = id || null;
    this.limite = 50;
    this.refresh();
  }

  setOrdenacao(o) {
    this.ordenacao = o || { campo: null, ordem: 'DESC', label: 'Mais recentes' };
    this.limite = 50;
    this.refresh();
  }

  carregarMais() {
    this.limite += 50;
    this.refresh();
  }

  refresh() {
    this.itens = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(el) {
    return el;
  }

  mensagem(texto, icone) {
    const it = new vscode.TreeItem(texto);
    if (icone) it.iconPath = new vscode.ThemeIcon(icone);
    return it;
  }

  itemCarregarMais() {
    const it = new vscode.TreeItem('Carregar mais...');
    it.iconPath = new vscode.ThemeIcon('unfold');
    it.command = { command: 'glpi.carregarMaisLista', title: 'Carregar mais' };
    return it;
  }

  async getChildren() {
    if (this.itens) return this.itens;
    const cred = await lerCredenciais(this.context);
    if (!credenciaisCompletas(cred)) {
      return [this.mensagem('Configure as credenciais para listar os chamados.', 'gear')];
    }
    try {
      const filtroEfetivo = this.buscaId
        ? { ticketId: this.buscaId }
        : Object.assign({}, this.filtro, {
            sortField: this.ordenacao.campo,
            sortOrder: this.ordenacao.ordem
          });
      const { tickets, mapaUsuarios, aprovacoes } = await comSessao(cred, async (token) => {
        const [tickets, mapaUsuarios] = await Promise.all([
          buscarTicketsFiltrado(cred, token, filtroEfetivo, this.limite),
          obterMapaUsuarios(cred, token)
        ]);
        const listaAprovacoes = await Promise.all(
          tickets.map((t) => obterResumoAprovacao(cred, token, t.id).catch(() => 'nenhuma'))
        );
        const aprovacoes = {};
        tickets.forEach((t, i) => { aprovacoes[t.id] = listaAprovacoes[i]; });
        return { tickets, mapaUsuarios, aprovacoes };
      });
      if (tickets.length === 0) {
        this.itens = [
          this.mensagem(
            this.buscaId ? `Nenhum chamado com o ID ${this.buscaId}.` : 'Nenhum chamado encontrado.',
            'info'
          )
        ];
        return this.itens;
      }
      const visualizados = obterVisualizados(this.context);
      const icones = await Promise.all(
        tickets.map((t) => obterIconeVisto(visualizados.has(String(t.id))))
      );
      this.itens = tickets.map((t, i) =>
        criarItemTicket(cred, t, mapaUsuarios, aprovacoes[t.id], visualizados.has(String(t.id)), icones[i])
      );
      if (!this.buscaId && tickets.length >= this.limite) {
        this.itens.push(this.itemCarregarMais());
      }
      return this.itens;
    } catch (e) {
      return [this.mensagem('Erro: ' + String(e.message || e), 'error')];
    }
  }
}

// ---------------------------------------------------------------------------
// Seccao: chamados atribuidos ao usuario atual (TreeView)
// ---------------------------------------------------------------------------
class GlpiMeusProvider {
  static viewId = 'glpi.meus';

  constructor(context) {
    this.context = context;
    // Padrao: apenas chamados nao solucionados.
    this.filtroStatus = { statusId: null, naoSolucionado: true, statusLabel: 'Nao solucionado' };
    this.ordenacao = { campo: null, ordem: 'DESC', label: 'Mais recentes' };
    this.limite = 50;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.itens = null;
  }

  setFiltroStatus(f) {
    this.filtroStatus = f || { statusId: null, naoSolucionado: false, statusLabel: null };
    this.limite = 50;
    this.refresh();
  }

  setOrdenacao(o) {
    this.ordenacao = o || { campo: null, ordem: 'DESC', label: 'Mais recentes' };
    this.limite = 50;
    this.refresh();
  }

  carregarMais() {
    this.limite += 50;
    this.refresh();
  }

  refresh() {
    this.itens = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(el) {
    return el;
  }

  mensagem(texto, icone) {
    const it = new vscode.TreeItem(texto);
    if (icone) it.iconPath = new vscode.ThemeIcon(icone);
    return it;
  }

  itemCarregarMais() {
    const it = new vscode.TreeItem('Carregar mais...');
    it.iconPath = new vscode.ThemeIcon('unfold');
    it.command = { command: 'glpi.carregarMaisMeus', title: 'Carregar mais' };
    return it;
  }

  async getChildren() {
    if (this.itens) return this.itens;
    const cred = await lerCredenciais(this.context);
    if (!credenciaisCompletas(cred)) {
      return [this.mensagem('Configure as credenciais para listar os chamados.', 'gear')];
    }
    try {
      const { tickets, mapaUsuarios, aprovacoes } = await comSessao(cred, async (token) => {
        const sessao = await getFullSession(cred, token);
        const meuId = sessao && sessao.glpiID;
        const [tickets, mapaUsuarios] = await Promise.all([
          meuId
            ? buscarTicketsFiltrado(
                cred,
                token,
                {
                  tecnicoId: meuId,
                  statusId: this.filtroStatus.statusId,
                  naoSolucionado: this.filtroStatus.naoSolucionado,
                  sortField: this.ordenacao.campo,
                  sortOrder: this.ordenacao.ordem
                },
                this.limite
              )
            : Promise.resolve([]),
          obterMapaUsuarios(cred, token)
        ]);
        const listaAprovacoes = await Promise.all(
          tickets.map((t) => obterResumoAprovacao(cred, token, t.id).catch(() => 'nenhuma'))
        );
        const aprovacoes = {};
        tickets.forEach((t, i) => { aprovacoes[t.id] = listaAprovacoes[i]; });
        return { tickets, mapaUsuarios, aprovacoes };
      });
      if (tickets.length === 0) {
        this.itens = [this.mensagem('Nenhum chamado atribuido a voce.', 'info')];
        return this.itens;
      }
      const visualizados = obterVisualizados(this.context);
      const icones = await Promise.all(
        tickets.map((t) => obterIconeVisto(visualizados.has(String(t.id))))
      );
      this.itens = tickets.map((t, i) =>
        criarItemTicket(cred, t, mapaUsuarios, aprovacoes[t.id], visualizados.has(String(t.id)), icones[i])
      );
      if (tickets.length >= this.limite) {
        this.itens.push(this.itemCarregarMais());
      }
      return this.itens;
    } catch (e) {
      return [this.mensagem('Erro: ' + String(e.message || e), 'error')];
    }
  }
}

// ---------------------------------------------------------------------------
// Seccao 3: painel de indicadores (webview)
// ---------------------------------------------------------------------------
class GlpiPainelProvider {
  static viewId = 'glpi.painel';

  constructor(context) {
    this.context = context;
    this.view = undefined;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html();
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'pronto' || msg.type === 'recarregar') await this.carregar();
    });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  async carregar() {
    const cred = await lerCredenciais(this.context);
    if (!credenciaisCompletas(cred)) {
      this.post({ type: 'erro', message: 'Configure as credenciais para ver o painel.' });
      return;
    }
    try {
      const dados = await comSessao(cred, async (token) => {
        const sessao = await getFullSession(cred, token);
        const meuId = sessao && sessao.glpiID;

        const totalOrg = await contarTickets(cred, token, []);

        const meusPorStatus = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
        if (meuId) {
          const contagens = await Promise.all(
            [1, 2, 3, 4, 5, 6].map((st) =>
              contarTickets(cred, token, [
                { field: CAMPO.tecnico, searchtype: 'equals', value: meuId },
                { field: CAMPO.status, searchtype: 'equals', value: st }
              ])
            )
          );
          [1, 2, 3, 4, 5, 6].forEach((st, i) => (meusPorStatus[st] = contagens[i]));
        }
        const meusTotais = [1, 2, 3, 4, 5, 6].reduce((a, st) => a + meusPorStatus[st], 0);
        // "Nao solucionado" = novo/em atendimento/pendente (1..4); exclui solucionado (5) e fechado (6).
        const meusAbertos =
          meusPorStatus[1] + meusPorStatus[2] + meusPorStatus[3] + meusPorStatus[4];

        return { totalOrg, meusAbertos, meusTotais, meusPorStatus };
      });
      this.post({ type: 'dados', ...dados });
    } catch (e) {
      this.post({ type: 'erro', message: String(e.message || e) });
    }
  }

  html() {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
           padding: 8px 4px; font-size: 13px; }
    .cards { display: flex; flex-direction: column; gap: 8px; }
    .card { padding: 10px; border-radius: 4px;
            background: var(--vscode-editorWidget-background, rgba(127,127,127,.1));
            border: 1px solid var(--vscode-editorWidget-border, transparent); }
    .card .rot { font-size: 11px; opacity: .8; }
    .card .val { font-size: 22px; font-weight: 700; margin-top: 2px; }
    h4 { margin: 18px 0 8px; }
    .barra-row { display: flex; align-items: center; gap: 6px; margin: 5px 0; }
    .barra-lab { width: 96px; font-size: 11px; }
    .barra-track { flex: 1; height: 12px; border-radius: 6px;
                   background: var(--vscode-editorWidget-background, rgba(127,127,127,.15)); overflow: hidden; }
    .barra-fill { height: 100%; background: var(--vscode-charts-blue, #3794ff); border-radius: 6px; }
    .barra-num { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
    #erro { display: none; margin-top: 10px; padding: 8px; border-radius: 2px;
            background: var(--vscode-inputValidation-errorBackground);
            border: 1px solid var(--vscode-inputValidation-errorBorder); }
    #carregando { opacity: .7; }
  </style>
</head>
<body>
  <div id="carregando">Carregando...</div>
  <div id="conteudo" style="display:none">
    <div class="cards">
      <div class="card"><div class="rot">Chamados da organizacao</div><div class="val" id="org">-</div></div>
      <div class="card"><div class="rot">Meus chamados em aberto</div><div class="val" id="meusAbertos">-</div></div>
      <div class="card"><div class="rot">Meus chamados totais</div><div class="val" id="meusTotais">-</div></div>
    </div>
    <h4>Meus chamados por status</h4>
    <div id="barras"></div>
  </div>
  <div id="erro"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function el(id) { return document.getElementById(id); }
    const labels = { 1:'Novo', 2:'Em atend. (atrib.)', 3:'Em atend. (plan.)', 4:'Pendente', 5:'Solucionado', 6:'Fechado' };
    window.addEventListener('message', (ev) => {
      const m = ev.data;
      if (m.type === 'dados') { render(m); }
      else if (m.type === 'erro') {
        el('carregando').style.display = 'none';
        el('erro').textContent = 'Erro: ' + m.message;
        el('erro').style.display = 'block';
      }
    });
    function render(m) {
      el('erro').style.display = 'none';
      el('carregando').style.display = 'none';
      el('conteudo').style.display = 'block';
      el('org').textContent = m.totalOrg;
      el('meusAbertos').textContent = m.meusAbertos;
      el('meusTotais').textContent = m.meusTotais;
      const cont = el('barras'); cont.innerHTML = '';
      const vals = [1,2,3,4,5,6].map((s) => (m.meusPorStatus[s] || 0));
      const max = Math.max.apply(null, [1].concat(vals));
      [1,2,3,4,5,6].forEach((s) => {
        const v = m.meusPorStatus[s] || 0;
        const row = document.createElement('div'); row.className = 'barra-row';
        const lab = document.createElement('div'); lab.className = 'barra-lab'; lab.textContent = labels[s];
        const track = document.createElement('div'); track.className = 'barra-track';
        const fill = document.createElement('div'); fill.className = 'barra-fill';
        fill.style.width = (v / max * 100) + '%';
        const num = document.createElement('div'); num.className = 'barra-num'; num.textContent = v;
        track.appendChild(fill);
        row.appendChild(lab); row.appendChild(track); row.appendChild(num);
        cont.appendChild(row);
      });
    }
    vscode.postMessage({ type: 'pronto' });
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Ativacao
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Painel dedicado de detalhe do chamado (aba, nao sidebar)
// ---------------------------------------------------------------------------
class GlpiDetalhePanel {
  static paineis = new Map(); // ticketId -> instancia
  static aoAlterarListas = null; // callback definido em activate() para atualizar as listas apos exclusao
  static painelProvisorio = null; // painel "provisorio" atual: reaproveitado no proximo clique simples

  static async abrir(context, ticketId, aoLado) {
    const coluna = aoLado ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;

    const existente = GlpiDetalhePanel.paineis.get(ticketId);
    if (existente) {
      // Pedido explicito de abrir "ao lado" fixa o painel: para de ser provisorio.
      if (aoLado && GlpiDetalhePanel.painelProvisorio === existente) {
        GlpiDetalhePanel.painelProvisorio = null;
      }
      existente.panel.reveal(coluna);
      return;
    }

    const cred = await lerCredenciais(context);
    if (!credenciaisCompletas(cred)) {
      vscode.window.showErrorMessage('Configure as credenciais do GLPI primeiro.');
      return;
    }

    // Abertura normal (clique simples): reaproveita a aba provisoria existente,
    // trocando o chamado exibido nela em vez de abrir uma aba nova.
    if (!aoLado && GlpiDetalhePanel.painelProvisorio) {
      const inst = GlpiDetalhePanel.painelProvisorio;
      GlpiDetalhePanel.paineis.delete(inst.ticketId);
      inst.ticketId = ticketId;
      inst.cred = cred;
      GlpiDetalhePanel.paineis.set(ticketId, inst);
      inst.post({ type: 'resetComposer' });
      inst.panel.reveal(coluna);
      await inst.carregar();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'glpiDetalhe',
      `Chamado #${ticketId}`,
      coluna,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const inst = new GlpiDetalhePanel(context, panel, ticketId, cred);
    GlpiDetalhePanel.paineis.set(ticketId, inst);
    if (!aoLado) {
      GlpiDetalhePanel.painelProvisorio = inst;
    }
    await inst.carregar();
  }

  constructor(context, panel, ticketId, cred) {
    this.context = context;
    this.panel = panel;
    this.ticketId = ticketId;
    this.cred = cred;
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
    this.panel.onDidDispose(() => {
      GlpiDetalhePanel.paineis.delete(this.ticketId);
      if (GlpiDetalhePanel.painelProvisorio === this) GlpiDetalhePanel.painelProvisorio = null;
    });
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  async onMessage(msg) {
    try {
      if (msg.type === 'pronto' || msg.type === 'recarregar') {
        await this.carregar();
      } else if (msg.type === 'abrirNavegador') {
        vscode.env.openExternal(vscode.Uri.parse(urlChamadoWeb(this.cred.apiUrl, this.ticketId)));
      } else if (msg.type === 'copiarLink') {
        await vscode.env.clipboard.writeText(urlChamadoWeb(this.cred.apiUrl, this.ticketId));
        vscode.window.showInformationMessage('Link do chamado copiado.');
      } else if (msg.type === 'salvarAlteracoes') {
        // Salvamento unificado: campos gerais + atores, tudo de uma vez.
        await comSessao(this.cred, async (t) => {
          if (msg.campos && Object.keys(msg.campos).length) {
            await editarTicket(this.cred, t, this.ticketId, msg.campos);
          }
          if (msg.atores) {
            const papeis = { requerente: 1, atribuido: 2, observador: 3 };
            for (const [papel, tipo] of Object.entries(papeis)) {
              if (msg.atores[papel]) {
                await sincronizarAtores(this.cred, t, this.ticketId, tipo, msg.atores[papel]);
              }
            }
          }
        });
        await this.carregar();
        vscode.window.showInformationMessage(`Chamado #${this.ticketId} atualizado.`);
      } else if (msg.type === 'abrirDocumento') {
        await this.abrirDocumentoNoEditor(msg.docId, msg.nome);
      } else if (msg.type === 'pedirPreview') {
        await this.enviarPreview(msg.docId, msg.nome);
      } else if (msg.type === 'salvarAbertura') {
        await comSessao(this.cred, (t) => editarTicketConteudo(this.cred, t, this.ticketId, msg.content));
        await this.carregar();
      } else if (msg.type === 'salvarFollowup') {
        await comSessao(this.cred, (t) => editarFollowup(this.cred, t, msg.id, msg.content));
        await this.carregar();
      } else if (msg.type === 'excluirFollowup') {
        const confirmacao = await vscode.window.showWarningMessage(
          'Excluir esta mensagem? Esta acao nao pode ser desfeita.',
          { modal: true },
          'Excluir'
        );
        if (confirmacao !== 'Excluir') return;
        await comSessao(this.cred, (t) => excluirFollowup(this.cred, t, msg.id));
        await this.carregar();
      } else if (msg.type === 'excluirDocumento') {
        const confirmacao = await vscode.window.showWarningMessage(
          `Excluir o anexo "${msg.nome || ''}"? Ele sera movido para a lixeira do GLPI.`,
          { modal: true },
          'Excluir'
        );
        if (confirmacao !== 'Excluir') return;
        await comSessao(this.cred, (t) => excluirDocumento(this.cred, t, msg.id));
        await this.carregar();
      } else if (msg.type === 'salvarTarefa') {
        await comSessao(this.cred, (t) => editarTask(this.cred, t, msg.id, msg.content));
        await this.carregar();
      } else if (msg.type === 'salvarSolucao') {
        await comSessao(this.cred, (t) => editarSolucao(this.cred, t, msg.id, msg.content));
        await this.carregar();
      } else if (msg.type === 'criarSolucao') {
        await comSessao(this.cred, (t) => criarSolucao(this.cred, t, this.ticketId, msg.content));
        await this.context.globalState.update(`glpi.rascunho.${this.ticketId}`, undefined);
        await this.carregar();
      } else if (msg.type === 'criarTarefa') {
        await comSessao(this.cred, (t) => criarTask(this.cred, t, this.ticketId, msg.content, msg.actiontime));
        await this.carregar();
      } else if (msg.type === 'enviarResposta') {
        await this.enviarResposta(msg.content, msg.arquivos);
      } else if (msg.type === 'pedirAprovacao') {
        const input = { tickets_id: Number(this.ticketId), comment_submission: '' };
        if (msg.validatorType === 'group') input.groups_id_validate = Number(msg.validatorId);
        else input.users_id_validate = Number(msg.validatorId);
        await comSessao(this.cred, (t) => criarValidacao(this.cred, t, input));
        await this.carregar();
      } else if (msg.type === 'alterarStatus') {
        await comSessao(this.cred, (t) => alterarStatusTicket(this.cred, t, this.ticketId, msg.status));
        await this.carregar();
      } else if (msg.type === 'adicionarAtor') {
        // type real do GLPI: 1=requerente, 2=atribuido, 3=observador.
        const tipoNum = msg.papel === 'requerente' ? 1 : msg.papel === 'observador' ? 3 : 2;
        await comSessao(this.cred, (t) =>
          msg.ehGrupo
            ? adicionarGrupoAtor(this.cred, t, this.ticketId, msg.id, tipoNum)
            : adicionarAtor(this.cred, t, this.ticketId, msg.id, tipoNum)
        );
        await this.carregar();
      } else if (msg.type === 'removerAtor') {
        await comSessao(this.cred, (t) => removerRelacaoAtor(this.cred, t, msg.itemtype, msg.id));
        await this.carregar();
      } else if (msg.type === 'copiarLink') {
        await vscode.env.clipboard.writeText(urlChamadoWeb(this.cred.apiUrl, this.ticketId));
        vscode.window.showInformationMessage('Link do chamado copiado.');
      } else if (msg.type === 'salvarTudo') {
        await this.salvarTudo(msg.campos, msg.atores);
      } else if (msg.type === 'salvarCampos') {
        await comSessao(this.cred, (t) => editarTicket(this.cred, t, this.ticketId, msg.campos));
        await this.carregar();
        vscode.window.showInformationMessage(`Chamado #${this.ticketId} atualizado.`);
      } else if (msg.type === 'salvarRascunho') {
        const chave = `glpi.rascunho.${this.ticketId}`;
        if (msg.content && msg.content.trim()) {
          await this.context.globalState.update(chave, msg.content);
        } else {
          await this.context.globalState.update(chave, undefined);
        }
      } else if (msg.type === 'salvarLarguraPainel') {
        await this.context.globalState.update('glpi.larguraPainelDetalhe', msg.largura);
      } else if (msg.type === 'excluirChamado') {
        // Segunda confirmacao (a primeira foi o overlay dentro do painel).
        const confirmacao = await vscode.window.showWarningMessage(
          `Excluir o chamado #${this.ticketId}? Ele sera movido para a lixeira do GLPI.`,
          { modal: true },
          'Excluir'
        );
        if (confirmacao !== 'Excluir') return;
        await comSessao(this.cred, (t) => excluirTicket(this.cred, t, this.ticketId));
        vscode.window.showInformationMessage(`Chamado #${this.ticketId} excluido.`);
        if (GlpiDetalhePanel.aoAlterarListas) GlpiDetalhePanel.aoAlterarListas();
        this.panel.dispose();
      }
    } catch (e) {
      this.post({ type: 'erro', message: String(e.message || e) });
    }
  }

  // Envia a resposta: se houver arquivos, faz upload de cada um antes de criar o followup.
  // Aplica campos gerais e reconcilia os atores (adiciona os novos, remove os
  // que sairam), tudo num unico "Salvar" vindo do painel lateral.
  async salvarTudo(campos, atores) {
    const PAPEIS = { requerente: 1, atribuido: 2, observador: 3 };
    await comSessao(this.cred, async (token) => {
      if (campos && Object.keys(campos).length) {
        await editarTicket(this.cred, token, this.ticketId, campos);
      }
      if (!atores) return;
      for (const papel of Object.keys(PAPEIS)) {
        const desejados = Array.isArray(atores[papel]) ? atores[papel] : null;
        if (!desejados) continue;
        const tipo = PAPEIS[papel];
        const atuais = await obterAtoresCombinados(this.cred, token, this.ticketId, tipo);

        const chave = (ehGrupo, id) => (ehGrupo ? 'g:' : 'u:') + String(id);
        const chavesDesejadas = new Set(desejados.map((d) => chave(d.ehGrupo, d.id)));
        const chavesAtuais = new Set(atuais.map((a) => chave(a.tipoAtor === 'group', a.refId)));

        for (const a of atuais) {
          if (!chavesDesejadas.has(chave(a.tipoAtor === 'group', a.refId))) {
            await removerRelacaoAtor(this.cred, token, a.itemtype, a.id);
          }
        }
        for (const d of desejados) {
          if (!chavesAtuais.has(chave(d.ehGrupo, d.id))) {
            if (d.ehGrupo) {
              await adicionarGrupoAtor(this.cred, token, this.ticketId, d.id, tipo);
            } else {
              await adicionarAtor(this.cred, token, this.ticketId, d.id, tipo);
            }
          }
        }
      }
    });
    await this.carregar();
    vscode.window.showInformationMessage(`Chamado #${this.ticketId} atualizado.`);
  }

  // Baixa o anexo e abre numa aba do proprio VSCode (imagens usam o
  // visualizador nativo; outros tipos abrem conforme o editor associado).
  async abrirDocumentoNoEditor(docId, nomeArquivo) {
    try {
      const buffer = await comSessao(this.cred, (t) => baixarDocumento(this.cred, t, docId));
      const dir = path.join(os.tmpdir(), 'glpi-anexos', String(this.ticketId));
      await fsp.mkdir(dir, { recursive: true });
      const nomeSeguro = path.basename(nomeArquivo || `documento-${docId}`);
      const arquivoPath = path.join(dir, nomeSeguro);
      await fsp.writeFile(arquivoPath, buffer);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(arquivoPath));
    } catch (e) {
      vscode.window.showErrorMessage('Falha ao abrir anexo: ' + String(e.message || e));
    }
  }

  // Baixa uma imagem pequena e envia como base64 para a webview exibir como miniatura.
  async enviarPreview(docId, nomeArquivo) {
    try {
      const { ehImagem, mime } = mimePorExtensao(nomeArquivo);
      if (!ehImagem) return;
      const buffer = await comSessao(this.cred, (t) => baixarDocumento(this.cred, t, docId));
      this.post({ type: 'previewDoc', docId, base64: buffer.toString('base64'), mime });
    } catch (e) {
      // Falha ao gerar preview nao deve interromper a timeline; o anexo continua clicavel.
    }
  }

  async enviarResposta(content, arquivos) {
    await comSessao(this.cred, async (token) => {
      const docIds = [];
      if (Array.isArray(arquivos) && arquivos.length) {
        for (const a of arquivos) {
          const id = await uploadDocumento(this.cred, token, a.nome, a.tipo, a.base64);
          await vincularDocumentoAoTicket(this.cred, token, this.ticketId, id);
          docIds.push(id);
        }
      }
      const texto = content && content.trim() ? content : (docIds.length ? ' ' : content);
      await criarFollowup(this.cred, token, this.ticketId, texto, null);
    });
    await this.context.globalState.update(`glpi.rascunho.${this.ticketId}`, undefined);
    await this.carregar();
  }

  async carregar() {
    try {
      const dados = await comSessao(this.cred, async (token) => {
        const [
          ticket,
          followups,
          validacoes,
          documentos,
          tasks,
          solucoes,
          atribuidosAtuais,
          requerentesAtuais,
          observadoresAtuais,
          mapaUsuarios,
          users,
          groups,
          categorias,
          localizacoes
        ] = await Promise.all([
          obterTicket(this.cred, token, this.ticketId),
          obterFollowups(this.cred, token, this.ticketId),
          obterValidacoesTicket(this.cred, token, this.ticketId),
          obterDocumentos(this.cred, token, this.ticketId),
          obterTasks(this.cred, token, this.ticketId),
          obterSolucoes(this.cred, token, this.ticketId),
          obterAtribuidos(this.cred, token, this.ticketId),
          obterRequerentesAtuais(this.cred, token, this.ticketId),
          obterObservadoresAtuais(this.cred, token, this.ticketId),
          obterMapaUsuarios(this.cred, token),
          buscarTodos(this.cred, token, 'User'),
          buscarTodos(this.cred, token, 'Group'),
          buscarTodos(this.cred, token, 'ITILCategory'),
          buscarTodos(this.cred, token, 'Location')
        ]);
        return {
          ticket,
          followups,
          validacoes,
          documentos,
          tasks,
          solucoes,
          atribuidosAtuais,
          requerentesAtuais,
          observadoresAtuais,
          mapaUsuarios,
          users,
          groups,
          categorias,
          localizacoes
        };
      });

      const rascunho = this.context.globalState.get(`glpi.rascunho.${this.ticketId}`) || '';
      const larguraPainel = this.context.globalState.get('glpi.larguraPainelDetalhe') || 250;

      // Titulo curto na aba: nome longo estica a guia e atrapalha a navegacao.
      const nomeCurto = String(dados.ticket.name || '');
      this.panel.title =
        `#${this.ticketId}` + (nomeCurto ? ' ' + (nomeCurto.length > 18 ? nomeCurto.slice(0, 18) + '...' : nomeCurto) : '');
      this.post({
        type: 'dados',
        ticket: dados.ticket,
        followups: dados.followups,
        validacoes: dados.validacoes,
        documentos: dados.documentos,
        tasks: dados.tasks,
        solucoes: dados.solucoes,
        atribuidosAtuais: dados.atribuidosAtuais,
        requerentesAtuais: dados.requerentesAtuais,
        observadoresAtuais: dados.observadoresAtuais,
        mapaUsuarios: dados.mapaUsuarios,
        usuarios: mapearUsuariosOpcoes(dados.users),
        grupos: mapearOpcoes(dados.groups),
        categorias: mapearCategoriasOpcoes(dados.categorias),
        localizacoes: mapearOpcoes(dados.localizacoes),
        rascunho,
        larguraPainel
      });
    } catch (e) {
      this.post({ type: 'erro', message: String(e.message || e) });
    }
  }

  html() {
    const nonce = String(Math.random()).slice(2);
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;`;
    return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 0; margin: 0; display: flex; flex-direction: column; height: 100vh; font-size: 13px; }

  /* ---- Cabecalho ---- */
  #topo { padding: 18px 20px 14px; border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18)); }
  #linhaTitulo { display: flex; align-items: flex-start; gap: 8px; }
  #tituloChamado { font-size: 21px; font-weight: 600; margin: 0; flex: 1; line-height: 1.35; word-break: break-word; }
  #tituloEditor { flex: 1; display: none; flex-direction: column; gap: 6px; }
  #tituloInput { width: 100%; font-size: 17px; padding: 6px 8px; font-family: inherit;
                 background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                 border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 4px; }
  #acoesTitulo { display: flex; gap: 2px; flex: 0 0 auto; padding-top: 2px; }
  .btnIcone { background: transparent; border: none; color: var(--vscode-foreground); cursor: pointer;
              padding: 5px 7px; border-radius: 4px; font-size: 14px; opacity: .6; line-height: 1; }
  .btnIcone:hover { background: rgba(127,127,127,.15); opacity: 1; }
  .btnIcone.girando { animation: girar .8s linear infinite; }
  @keyframes girar { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  #numeroChamado { font-size: 18px; font-weight: 400; color: var(--vscode-descriptionForeground, #9d9d9d); margin-top: 1px; }
  #metaChamado { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 12px;
                 font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .pilulaStatus { display: inline-flex; align-items: center; gap: 5px; padding: 2px 10px; border-radius: 12px;
                  font-size: 11px; font-weight: 600; background: rgba(150,150,150,.18); color: #9d9d9d; }
  .pilulaStatus.novo { background: rgba(59,130,246,.18); color: #60a5fa; }
  .pilulaStatus.atribuido { background: rgba(230,180,50,.18); color: #e6b432; }
  .pilulaStatus.planejado { background: rgba(60,180,90,.18); color: #4cbb6c; }
  .pilulaStatus.pendente { background: rgba(168,85,247,.18); color: #a68bea; }
  .pilulaStatus.solucionado { background: rgba(180,130,90,.22); color: #c08552; }
  .pilulaStatus.fechado { background: rgba(180,130,90,.22); color: #c08552; }
  #metaChamado strong { font-weight: 600; color: var(--vscode-foreground); }

  /* ---- Corpo ---- */
  #corpo { flex: 1; display: flex; min-height: 0; }
  #colunaPrincipal { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #timeline { flex: 1; overflow-y: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 4px; }
  #resizer { width: 5px; flex: 0 0 auto; cursor: col-resize; background: transparent; }
  #resizer:hover, #resizer.arrastando { background: var(--vscode-focusBorder, #007acc); }

  /* ---- Cards de mensagem (comentarios reais: abertura, respostas, solucao) ---- */
  .itemTimeline { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; }
  .avatar, .avatarMini { border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-weight: 700; color: #fff; flex: 0 0 auto; }
  .avatar { width: 28px; height: 28px; font-size: 11px; }
  .avatarMini { width: 18px; height: 18px; font-size: 9px; }
  .cardMensagem { flex: 1; min-width: 0; background: var(--vscode-editor-background);
           border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.16));
           border-radius: 8px; overflow: hidden; }
  .cardMensagem .cab { display: flex; justify-content: space-between; align-items: center; gap: 8px;
                font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); padding: 8px 12px;
                background: rgba(127,127,127,.05);
                border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.14)); }
  .cardMensagem .cab .meta { display: flex; gap: 10px; flex-wrap: wrap; }
  .cardMensagem .cab strong { color: var(--vscode-foreground); font-weight: 600; }
  .cardMensagem .corpoBolha { padding: 12px; }
  .cardMensagem .titulo { font-weight: 700; margin-bottom: 6px; }
  .cardMensagem .conteudo { white-space: pre-wrap; line-height: 1.55; }
  .cardMensagem .menu { cursor: pointer; opacity: .5; padding: 2px 4px; flex: 0 0 auto; border-radius: 3px; }
  .cardMensagem .menu:hover { opacity: 1; background: rgba(127,127,127,.15); }
  .cardMensagem .menu.perigo:hover, .linhaEvento .menu.perigo:hover { color: #ff6b6b; background: rgba(220,70,70,.15); }
  .cardMensagem .cab .acoesCab { display: flex; align-items: center; gap: 2px; flex: 0 0 auto; }
  .cardMensagem textarea { width: 100%; min-height: 100px; font-family: inherit; font-size: 13px;
                    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
                    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; padding: 8px; }
  .acoesEdicao { display: flex; gap: 6px; margin-top: 8px; }
  .anexo { display: flex; align-items: center; gap: 8px; cursor: pointer; }
  .anexo:hover { text-decoration: underline; }
  .anexo .tamanho { opacity: .6; font-size: 11px; margin-left: auto; }
  .cardMensagem.solucao { border-left: 3px solid var(--vscode-charts-blue, #3794ff); }
  .respostaSolucao { margin-top: 10px; font-size: 12px; color: var(--vscode-textLink-foreground, #3794ff); }
  .respostaSolucao.recusada { color: #ff6b6b; }

  /* ---- Eventos em linha (validacoes, tarefas): sem card, estilo timeline enxuto ---- */
  .linhaEvento { display: flex; align-items: flex-start; gap: 10px; padding: 7px 0; font-size: 12.5px;
                 color: var(--vscode-descriptionForeground, #9d9d9d); }
  .linhaEvento .iconeEvento { width: 28px; height: 28px; flex: 0 0 auto; display: flex; align-items: center;
                               justify-content: center; font-size: 13px; opacity: .8; }
  .linhaEvento .textoEvento { flex: 1; padding-top: 4px; line-height: 1.5; }
  .linhaEvento .textoEvento strong { color: var(--vscode-foreground); font-weight: 600; }
  .linhaEvento .badge { margin-left: 4px; }
  .linhaEvento .horaEvento { opacity: .7; white-space: nowrap; padding-top: 4px; }
  .linhaEvento .menu { cursor: pointer; opacity: .45; padding: 2px 4px; border-radius: 3px; align-self: flex-start;
                        margin-top: 4px; }
  .linhaEvento .menu:hover { opacity: 1; background: rgba(127,127,127,.15); }
  .linhaEvento .respostaSolucao { margin-top: 4px; }
  .caixaEdicaoInline { flex: 1; }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; }
  .badge.aguardando { background: rgba(230,180,50,.2); color: #e6b432; }
  .badge.aprovado { background: rgba(60,180,90,.2); color: #4cbb6c; }
  .badge.recusado { background: rgba(220,70,70,.2); color: #ff6b6b; }

  /* ---- Composer ---- */
  #areaComposer { border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18)); padding: 12px 20px 14px; }
  #caixaComposer { border: 1px solid var(--vscode-input-border, rgba(127,127,127,.3)); border-radius: 8px;
                   background: var(--vscode-input-background); overflow: hidden; }
  #caixaComposer:focus-within { border-color: var(--vscode-focusBorder, #007acc); }
  #bannerComposer { display: flex; align-items: center; justify-content: space-between; gap: 10px;
                    padding: 8px 12px; font-size: 12px;
                    background: rgba(55,148,255,.12); color: var(--vscode-textLink-foreground, #3794ff);
                    border-bottom: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2)); }
  #bannerComposer .btnSecundario { padding: 3px 10px; font-size: 11px; flex: 0 0 auto; }
  #composerTexto { width: 100%; min-height: 80px; resize: vertical; border: none; outline: none; padding: 10px 12px;
                   background: transparent; color: var(--vscode-input-foreground); font-family: inherit; font-size: 13px; }
  #barraComposer { display: flex; align-items: center; gap: 6px; padding: 6px 8px;
                   border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.14)); }
  #barraComposer .espaco { flex: 1; }
  .anexosComposer { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 12px 8px; }
  .anexoChip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px;
               background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .anexoChip .x { cursor: pointer; opacity: .8; font-weight: 700; }

  button { font-family: inherit; cursor: pointer; }
  .btnPrimario { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                 border: none; border-radius: 5px; padding: 6px 14px; font-size: 12px; }
  .btnPrimario:hover { background: var(--vscode-button-hoverBackground); }
  .btnPrimario:disabled { opacity: .5; cursor: default; }
  .btnSecundario { background: transparent; color: var(--vscode-foreground);
                   border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
                   border-radius: 5px; padding: 6px 12px; font-size: 12px; }
  .btnSecundario:hover { background: rgba(127,127,127,.12); }
  .btnPerigo { background: #d9534f; color: #fff; border: none; border-radius: 5px;
               padding: 6px 12px; font-size: 12px; }
  .btnPerigo:hover { background: #c9302c; }

  .splitBtn { position: relative; display: inline-flex; }
  .splitBtn .principal { border-radius: 5px 0 0 5px; }
  .splitBtn .chevron { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
                       border: none; border-left: 1px solid rgba(255,255,255,.22);
                       border-radius: 0 5px 5px 0; padding: 6px 9px; font-size: 10px; }
  .splitBtn .chevron:hover { background: var(--vscode-button-hoverBackground); }
  .menuDropdown { position: absolute; bottom: 115%; left: 0; min-width: 190px;
                  background: var(--vscode-dropdown-background, #252526); color: var(--vscode-dropdown-foreground, #ccc);
                  border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.3));
                  border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.4); display: none; z-index: 30; }
  .menuDropdown.aberto { display: block; }
  .menuDropdown.alinharDireita { left: auto; right: 0; }
  .menuDropdown .item { padding: 8px 12px; font-size: 12px; cursor: pointer; }
  .menuDropdown .item:hover { background: rgba(127,127,127,.15); }
  .menuDropdown .item.perigo { color: #ff6b6b; }

  /* ---- Painel lateral ---- */
  #painelLateral { width: 280px; flex: 0 0 auto; display: flex; flex-direction: column;
                   border-left: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18)); }
  #camposLaterais { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 18px; }
  .secaoLateral { display: flex; flex-direction: column; gap: 6px; position: relative; }
  .cabecalhoSecao { display: flex; align-items: center; justify-content: space-between; }
  .cabecalhoSecao span.rot { font-size: 11px; font-weight: 700; text-transform: uppercase;
                             letter-spacing: .04em; color: var(--vscode-descriptionForeground, #9d9d9d); }
  #painelLateral select, #painelLateral input[type="text"], #painelLateral input[type="number"] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(127,127,127,.3)); border-radius: 5px;
    padding: 5px 7px; font-family: inherit; font-size: 12px; width: 100%;
  }
  #painelLateral select:focus, #painelLateral input:focus { outline: 1px solid var(--vscode-focusBorder, #007acc); }
  #painelLateral select option, #painelLateral select optgroup {
    background: var(--vscode-dropdown-background, #252526); color: var(--vscode-dropdown-foreground, #ccc);
  }
  #statusEdit { font-weight: 600; }
  #statusEdit option[value="1"] { color: #60a5fa; }
  #statusEdit option[value="2"] { color: #e6b432; }
  #statusEdit option[value="3"] { color: #4cbb6c; }
  #statusEdit option[value="4"] { color: #a68bea; }
  #statusEdit option[value="5"] { color: #c08552; }
  #statusEdit option[value="6"] { color: #c08552; }
  .duracaoLinha { display: flex; gap: 5px; }
  .duracaoLinha input { min-width: 0; }
  .chipsAtor { display: flex; flex-wrap: wrap; gap: 4px; }
  .chipAtor { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px 3px 4px; border-radius: 12px;
              background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 11px; }
  .chipAtor .x { cursor: pointer; opacity: .7; font-weight: 700; }
  .chipAtor .x:hover { opacity: 1; }
  .vazioAtor { font-size: 11px; opacity: .5; font-style: italic; }

  /* Popover flutuante do seletor multiplo (estilo "add reviewers" do GitHub) */
  .popoverAtor { display: none; position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
                 background: var(--vscode-dropdown-background, #252526);
                 border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.35));
                 border-radius: 6px; box-shadow: 0 6px 18px rgba(0,0,0,.5); overflow: hidden; }
  .popoverAtor.aberto { display: block; }
  .popoverAtor .cabPopover { display: flex; align-items: center; gap: 6px; padding: 7px; }
  .popoverAtor .cabPopover input { flex: 1; margin: 0 !important; }
  .popoverAtor .contagem { font-size: 10px; white-space: nowrap; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .popoverAtor .btnOk { flex: 0 0 auto; padding: 5px 10px; font-size: 11px; }
  .listaOpcoes { max-height: 200px; overflow-y: auto; border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.2)); }
  .listaOpcoes .grupoRot { padding: 6px 10px 3px; font-size: 10px; text-transform: uppercase;
                           color: var(--vscode-descriptionForeground, #9d9d9d); font-weight: 700; }
  .opcaoItem { display: flex; align-items: center; gap: 7px; padding: 6px 10px; cursor: pointer; font-size: 12px; }
  .opcaoItem:hover { background: rgba(127,127,127,.15); }
  .opcaoItem input { width: auto !important; margin: 0 !important; flex: 0 0 auto; }
  .opcaoItem span.nomeOpcao { flex: 1; }
  .opcaoItem.marcada { background: rgba(55,148,255,.1); }

  #rodapeLateral { border-top: 1px solid var(--vscode-widget-border, rgba(127,127,127,.18));
                   padding: 10px 14px; display: flex; align-items: center; gap: 8px; }
  #btnSalvarDetalhes { flex: 1; }
  #confirmacaoSalvo { font-size: 11px; color: #4cbb6c; opacity: 0; transition: opacity .3s; white-space: nowrap; }
  #confirmacaoSalvo.visivel { opacity: 1; }

  /* ---- Overlays ---- */
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.55); display: none;
             align-items: center; justify-content: center; z-index: 50; }
  .overlay.aberto { display: flex; }
  .card { background: var(--vscode-editor-background);
          border: 1px solid var(--vscode-widget-border, rgba(127,127,127,.3));
          border-radius: 8px; padding: 18px; width: 340px; }
  .card h3 { margin: 0 0 12px; font-size: 14px; }
  .card label { display: block; font-size: 11px; font-weight: 600; margin: 10px 0 4px;
                color: var(--vscode-descriptionForeground, #9d9d9d); }
  .card select, .card input, .card textarea {
    width: 100%; padding: 6px 8px; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, rgba(127,127,127,.3));
    border-radius: 5px; font-family: inherit; font-size: 12px;
  }
  .card .acoes { display: flex; gap: 6px; margin-top: 16px; justify-content: flex-end; }
  .card .linhaDupla { display: flex; gap: 6px; }

  #erro { display: none; margin: 12px 20px; padding: 9px; border-radius: 5px; font-size: 12px;
          background: var(--vscode-inputValidation-errorBackground);
          border: 1px solid var(--vscode-inputValidation-errorBorder); }
  #carregando { padding: 20px; opacity: .7; }
</style>
</head>
<body>
  <div id="topo" style="display:none">
    <div id="linhaTitulo">
      <h1 id="tituloChamado"></h1>
      <div id="tituloEditor">
        <input type="text" id="tituloInput" />
        <div class="acoesEdicao">
          <button class="btnPrimario" id="tituloSalvar">Salvar</button>
          <button class="btnSecundario" id="tituloCancelar">Cancelar</button>
        </div>
      </div>
      <div id="acoesTitulo">
        <button class="btnIcone" id="btnAtualizar" title="Atualizar chamado">&#8635;</button>
        <button class="btnIcone" id="btnRenomear" title="Renomear chamado">&#9998;</button>
        <button class="btnIcone" id="btnCopiarLink" title="Copiar link do chamado">&#128279;</button>
        <button class="btnIcone" id="btnNavegador" title="Abrir no navegador">&#8663;</button>
      </div>
    </div>
    <div id="numeroChamado"></div>
    <div id="metaChamado"></div>
  </div>

  <div id="erro"></div>
  <div id="carregando">Carregando chamado...</div>

  <div id="corpo" style="display:none">
    <div id="colunaPrincipal">
      <div id="timeline"></div>
      <div id="areaComposer">
        <div id="caixaComposer">
          <div id="bannerComposer" style="display:none">
            <span>&#128161; Voce esta adicionando uma <strong>solucao</strong> para este chamado</span>
            <button class="btnSecundario" id="cancelarModoComposer">Cancelar</button>
          </div>
          <textarea id="composerTexto" placeholder="Deixe um comentario..."></textarea>
          <div class="anexosComposer" id="anexosComposer"></div>
          <div id="barraComposer">
            <button class="btnIcone" id="btnAnexar" title="Anexar arquivo">&#128206;</button>
            <input type="file" id="composerArquivo" multiple style="display:none" />
            <span class="espaco"></span>
            <div class="splitBtn">
              <button class="btnPrimario principal" id="btnComentar">Comentar</button>
              <button class="chevron" id="btnChevron" title="Outras acoes">&#9662;</button>
              <div class="menuDropdown alinharDireita" id="menuAcoes">
                <div class="item" id="opAprovacao">Pedir aprovacao</div>
                <div class="item" id="opTarefa">Registrar tempo</div>
                <div class="item" id="opSolucao">Adicionar solucao</div>
              </div>
            </div>
            <div class="splitBtn">
              <button class="btnIcone" id="btnMaisOpcoes" title="Mais opcoes">&#8942;</button>
              <div class="menuDropdown alinharDireita" id="menuMaisOpcoes">
                <div class="item perigo" id="opExcluir">Excluir chamado</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div id="resizer" title="Arraste para redimensionar"></div>

    <div id="painelLateral">
      <div id="camposLaterais">
        <div class="secaoLateral">
          <div class="cabecalhoSecao"><span class="rot">Tipo</span></div>
          <select id="tipoEdit">
            <option value="1">Incidente</option>
            <option value="2">Requisicao</option>
          </select>
        </div>
        <div class="secaoLateral">
          <div class="cabecalhoSecao"><span class="rot">Status</span></div>
          <select id="statusEdit">
            <option value="1">Novo</option>
            <option value="2">Em atendimento (atribuido)</option>
            <option value="3">Em atendimento (planejado)</option>
            <option value="4">Pendente</option>
            <option value="5">Solucionado</option>
            <option value="6">Fechado</option>
          </select>
        </div>
        <div class="secaoLateral">
          <div class="cabecalhoSecao"><span class="rot">Categoria</span></div>
          <select id="categoriaEdit"></select>
        </div>
        <div class="secaoLateral">
          <div class="cabecalhoSecao"><span class="rot">Localizacao</span></div>
          <select id="localizacaoEdit"></select>
        </div>
        <div class="secaoLateral">
          <div class="cabecalhoSecao"><span class="rot">Duracao total</span></div>
          <div class="duracaoLinha">
            <input type="number" min="0" id="duracaoDias" placeholder="dias" />
            <input type="number" min="0" id="duracaoHoras" placeholder="horas" />
            <input type="number" min="0" max="59" id="duracaoMinutos" placeholder="min" />
          </div>
        </div>

        <div class="secaoLateral">
          <div class="cabecalhoSecao">
            <span class="rot">Requerentes</span>
            <button class="btnIcone" id="gearRequerente" title="Selecionar requerentes">&#9881;</button>
          </div>
          <div class="chipsAtor" id="chipsRequerente"></div>
          <div class="popoverAtor" id="pickerRequerente">
            <div class="cabPopover">
              <input type="text" id="buscaRequerente" placeholder="Buscar..." />
              <span class="contagem" id="contagemRequerente">0 selecionado(s)</span>
              <button class="btnPrimario btnOk" id="okRequerente">OK</button>
            </div>
            <div class="listaOpcoes" id="listaRequerente"></div>
          </div>
        </div>

        <div class="secaoLateral">
          <div class="cabecalhoSecao">
            <span class="rot">Observadores</span>
            <button class="btnIcone" id="gearObservador" title="Selecionar observadores">&#9881;</button>
          </div>
          <div class="chipsAtor" id="chipsObservador"></div>
          <div class="popoverAtor" id="pickerObservador">
            <div class="cabPopover">
              <input type="text" id="buscaObservador" placeholder="Buscar..." />
              <span class="contagem" id="contagemObservador">0 selecionado(s)</span>
              <button class="btnPrimario btnOk" id="okObservador">OK</button>
            </div>
            <div class="listaOpcoes" id="listaObservador"></div>
          </div>
        </div>

        <div class="secaoLateral">
          <div class="cabecalhoSecao">
            <span class="rot">Atribuidos</span>
            <button class="btnIcone" id="gearAtribuido" title="Selecionar atribuidos">&#9881;</button>
          </div>
          <div class="chipsAtor" id="chipsAtribuido"></div>
          <div class="popoverAtor" id="pickerAtribuido">
            <div class="cabPopover">
              <input type="text" id="buscaAtribuido" placeholder="Buscar..." />
              <span class="contagem" id="contagemAtribuido">0 selecionado(s)</span>
              <button class="btnPrimario btnOk" id="okAtribuido">OK</button>
            </div>
            <div class="listaOpcoes" id="listaAtribuido"></div>
          </div>
        </div>
      </div>
      <div id="rodapeLateral">
        <span id="confirmacaoSalvo">Salvo</span>
        <button class="btnPrimario" id="btnSalvarDetalhes" disabled>Salvar alteracoes</button>
      </div>
    </div>
  </div>

  <div class="overlay" id="overlayAprovacao">
    <div class="card">
      <h3>Pedir aprovacao</h3>
      <label for="aprovTipo">Tipo de validador</label>
      <select id="aprovTipo">
        <option value="user">Usuario</option>
        <option value="group">Grupo</option>
      </select>
      <label for="aprovValidador">Validador</label>
      <select id="aprovValidador"></select>
      <div class="acoes">
        <button class="btnSecundario" id="aprovCancelar">Cancelar</button>
        <button class="btnPrimario" id="aprovEnviar">Enviar</button>
      </div>
    </div>
  </div>

  <div class="overlay" id="overlayTarefa">
    <div class="card">
      <h3>Registrar tempo</h3>
      <label for="tarefaTexto">Descricao</label>
      <textarea id="tarefaTexto" style="min-height:70px;"></textarea>
      <label>Tempo gasto</label>
      <div class="linhaDupla">
        <input type="number" min="0" id="tarefaHoras" placeholder="horas" />
        <input type="number" min="0" max="59" id="tarefaMinutos" placeholder="minutos" />
      </div>
      <div class="acoes">
        <button class="btnSecundario" id="tarefaCancelar">Cancelar</button>
        <button class="btnPrimario" id="tarefaEnviar">Salvar</button>
      </div>
    </div>
  </div>

  <div class="overlay" id="overlayExcluir">
    <div class="card">
      <h3>Excluir chamado</h3>
      <p style="font-size:12px; margin:0; opacity:.9;">
        Tem certeza que deseja excluir o chamado #<span id="excluirIdTexto"></span>?
        Ele sera movido para a lixeira do GLPI.
      </p>
      <div class="acoes">
        <button class="btnSecundario" id="excluirCancelar">Cancelar</button>
        <button class="btnPerigo" id="excluirConfirmar">Excluir</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const STATUS_TXT = { 1:'Novo', 2:'Em atendimento (atribuido)', 3:'Em atendimento (planejado)',
                       4:'Pendente', 5:'Solucionado', 6:'Fechado' };
  const STATUS_VAL_TXT = { 2: 'Aguardando', 3: 'Aprovado', 4: 'Recusado' };
  const PAPEIS = ['Requerente', 'Observador', 'Atribuido'];

  let usuarios = [], grupos = [], mapaUsuarios = {}, mapaGrupos = {}, categoriasTodas = [];
  let ultimoEstado = null;
  let camposPendentes = {};
  let selecionados = { Requerente: [], Observador: [], Atribuido: [] };
  let atoresAlterados = false;
  let salvandoDetalhes = false;
  let arquivosSelecionados = [];
  let modoComposer = 'comentario'; // 'comentario' | 'solucao'

  /* ---------- utilitarios ---------- */
  function iniciaisCor(nome) {
    const partes = String(nome || '?').trim().split(/\\s+/);
    const iniciais = ((partes[0]||'')[0] || '?') + ((partes[1]||'')[0] || '');
    let hash = 0;
    for (let i = 0; i < String(nome).length; i++) hash = String(nome).charCodeAt(i) + ((hash << 5) - hash);
    return { iniciais: iniciais.toUpperCase(), cor: 'hsl(' + (Math.abs(hash) % 360) + ', 55%, 45%)' };
  }
  function criarAvatar(nome, mini) {
    const av = iniciaisCor(nome);
    const el = document.createElement('div'); el.className = mini ? 'avatarMini' : 'avatar';
    el.style.background = av.cor; el.textContent = av.iniciais;
    return el;
  }
  function resolverNome(id) {
    const s = String(id || '').trim();
    if (!s) return '-';
    if (/^\\d+$/.test(s) && mapaUsuarios[s]) return mapaUsuarios[s];
    return s;
  }
  function resolverGrupo(id) {
    const s = String(id || '').trim();
    if (!s) return '-';
    return mapaGrupos[s] || ('Grupo #' + s);
  }
  function fmtData(iso) {
    if (!iso) return '-';
    const d = new Date(String(iso).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR');
  }
  function limparHtml(s) {
    const div = document.createElement('div');
    div.innerHTML = String(s || '').replace(/<br\\s*\\/?>/gi, '\\n');
    return (div.textContent || div.innerText || '').trim();
  }
  function formatarTamanhoLocal(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024*1024) return (b/1024).toFixed(2) + ' KiB';
    return (b/(1024*1024)).toFixed(2) + ' MiB';
  }
  function preencherSelect(select, itens, incluirVazio) {
    select.innerHTML = incluirVazio === false ? '' : '<option value="">-- Selecione --</option>';
    itens.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.id; o.textContent = it.name; select.appendChild(o);
    });
  }

  /* ---------- cards de mensagem (comentarios reais) ---------- */
  function montarCard(autorNome, cabHtml, comMenu, comExcluir) {
    const linha = document.createElement('div'); linha.className = 'itemTimeline';
    linha.appendChild(criarAvatar(autorNome, false));
    const bolha = document.createElement('div'); bolha.className = 'cardMensagem';
    const cab = document.createElement('div'); cab.className = 'cab';
    const meta = document.createElement('div'); meta.className = 'meta'; meta.innerHTML = cabHtml;
    cab.appendChild(meta);
    let menu = null, excluir = null;
    if (comMenu || comExcluir) {
      const acoesCab = document.createElement('div'); acoesCab.className = 'acoesCab';
      if (comMenu) {
        menu = document.createElement('span'); menu.className = 'menu'; menu.textContent = '\\u22EF'; menu.title = 'Editar';
        acoesCab.appendChild(menu);
      }
      if (comExcluir) {
        excluir = document.createElement('span'); excluir.className = 'menu perigo';
        excluir.textContent = '\\uD83D\\uDDD1'; excluir.title = 'Excluir';
        acoesCab.appendChild(excluir);
      }
      cab.appendChild(acoesCab);
    }
    const corpo = document.createElement('div'); corpo.className = 'corpoBolha';
    bolha.appendChild(cab); bolha.appendChild(corpo);
    linha.appendChild(bolha);
    return { linha, bolha, corpo, menu, excluir };
  }

  function ativarEdicaoCard(menu, corpo, textoOriginal, aoSalvar) {
    menu.addEventListener('click', () => {
      const area = document.createElement('textarea');
      area.value = limparHtml(textoOriginal);
      const acoes = document.createElement('div'); acoes.className = 'acoesEdicao';
      const salvar = document.createElement('button'); salvar.className = 'btnPrimario'; salvar.textContent = 'Salvar';
      const cancelar = document.createElement('button'); cancelar.className = 'btnSecundario'; cancelar.textContent = 'Cancelar';
      acoes.appendChild(salvar); acoes.appendChild(cancelar);
      corpo.innerHTML = ''; corpo.appendChild(area); corpo.appendChild(acoes);
      area.focus();
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); salvar.click(); }
      });
      salvar.addEventListener('click', () => aoSalvar(area.value));
      cancelar.addEventListener('click', () => renderizar(ultimoEstado));
    });
  }

  function cardMensagem(autor, criadoEm, atualizadoEm, tituloOpc, conteudo, aoSalvar, idExclusao) {
    const cabHtml = '<span><strong>' + autor + '</strong> comentou em ' + fmtData(criadoEm) + '</span>' +
      (atualizadoEm && atualizadoEm !== criadoEm ? '<span>editado em ' + fmtData(atualizadoEm) + '</span>' : '');
    const c = montarCard(autor, cabHtml, true, Boolean(idExclusao));
    if (tituloOpc) {
      const t = document.createElement('div'); t.className = 'titulo'; t.textContent = tituloOpc;
      c.corpo.appendChild(t);
    }
    const txt = document.createElement('div'); txt.className = 'conteudo'; txt.textContent = limparHtml(conteudo);
    c.corpo.appendChild(txt);
    ativarEdicaoCard(c.menu, c.corpo, conteudo, aoSalvar);
    if (idExclusao && c.excluir) {
      c.excluir.addEventListener('click', () => vscode.postMessage({ type: 'excluirFollowup', id: idExclusao }));
    }
    return c.linha;
  }

  let elementosPreview = {};
  function ehImagemNome(nome) {
    const ext = String(nome || '').split('.').pop().toLowerCase();
    return ['jpg','jpeg','png','gif','webp','bmp','svg'].includes(ext);
  }

  function cardAnexo(autor, criadoEm, nome, tamanho, docId) {
    const c = montarCard(autor, '<span><strong>' + autor + '</strong> anexou um arquivo em ' + fmtData(criadoEm) + '</span>', false, true);
    const anexo = document.createElement('div'); anexo.className = 'anexo';
    anexo.style.flexDirection = 'column'; anexo.style.alignItems = 'flex-start'; anexo.style.gap = '8px';
    const linhaInfo = document.createElement('div');
    linhaInfo.style.display = 'flex'; linhaInfo.style.alignItems = 'center'; linhaInfo.style.gap = '8px'; linhaInfo.style.width = '100%';
    linhaInfo.innerHTML = '<span>\\uD83D\\uDCCE</span><span>' + nome + '</span><span class="tamanho">' + tamanho + '</span>';
    anexo.appendChild(linhaInfo);
    if (ehImagemNome(nome)) {
      const img = document.createElement('img');
      img.alt = nome;
      img.style.maxWidth = '260px'; img.style.maxHeight = '180px'; img.style.borderRadius = '6px'; img.style.display = 'block';
      img.style.border = '1px solid var(--vscode-widget-border, rgba(127,127,127,.2))';
      elementosPreview[docId] = img;
      anexo.appendChild(img);
      vscode.postMessage({ type: 'pedirPreview', docId: docId, nome: nome });
    }
    anexo.addEventListener('click', () => vscode.postMessage({ type: 'abrirDocumento', docId: docId, nome: nome }));
    if (c.excluir) {
      c.excluir.addEventListener('click', () => vscode.postMessage({ type: 'excluirDocumento', id: docId, nome: nome }));
    }
    c.corpo.appendChild(anexo);
    return c.linha;
  }

  function cardSolucao(s) {
    const autor = resolverNome(s.users_id);
    const c = montarCard(autor, '<span><strong>' + autor + '</strong> propos uma solucao em ' + fmtData(s.date_creation || s.date) + '</span>', true);
    c.bolha.classList.add('solucao');
    const t = document.createElement('div'); t.className = 'titulo'; t.textContent = 'Solucao proposta';
    c.corpo.appendChild(t);
    const txt = document.createElement('div'); txt.className = 'conteudo'; txt.textContent = limparHtml(s.content);
    c.corpo.appendChild(txt);
    if (s.date_approval) {
      const recusada = Number(s.status) === 4;
      const r = document.createElement('div');
      r.className = 'respostaSolucao' + (recusada ? ' recusada' : '');
      r.textContent = (recusada ? 'Recusado' : 'Aprovado') + ' em ' + fmtData(s.date_approval) +
        ' por ' + resolverNome(s.users_id_approval);
      c.corpo.appendChild(r);
    }
    ativarEdicaoCard(c.menu, c.corpo, s.content,
      (txt2) => vscode.postMessage({ type: 'salvarSolucao', id: s.id, content: txt2 }));
    return c.linha;
  }

  /* ---------- eventos em linha (sem card): validacoes e tarefas ---------- */
  function resolverValidador(v) {
    if (v.itemtype_target === 'User' && v.items_id_target) return resolverNome(v.items_id_target);
    if (v.itemtype_target === 'Group' && v.items_id_target) return resolverGrupo(v.items_id_target) + ' (grupo)';
    if (v.users_id_validate) return resolverNome(v.users_id_validate);
    if (v.groups_id_validate) return resolverGrupo(v.groups_id_validate) + ' (grupo)';
    return '-';
  }

  function linhaValidacao(v) {
    const autor = resolverNome(v.users_id);
    const linha = document.createElement('div'); linha.className = 'linhaEvento';
    const icone = document.createElement('div'); icone.className = 'iconeEvento'; icone.textContent = '\\u2713';
    const texto = document.createElement('div'); texto.className = 'textoEvento';
    const cls = v.status == 3 ? 'aprovado' : (v.status == 4 ? 'recusado' : 'aguardando');
    texto.innerHTML = '<strong>' + autor + '</strong> pediu aprovacao para <strong>' + resolverValidador(v) + '</strong>' +
      ' <span class="badge ' + cls + '">' + (STATUS_VAL_TXT[v.status] || 'Aguardando') + '</span>';
    if (v.comment_validation) {
      const cm = document.createElement('div'); cm.style.marginTop = '4px'; cm.style.opacity = '.85';
      cm.textContent = limparHtml(v.comment_validation);
      texto.appendChild(cm);
    }
    const hora = document.createElement('div'); hora.className = 'horaEvento'; hora.textContent = fmtData(v.submission_date);
    linha.appendChild(icone); linha.appendChild(texto); linha.appendChild(hora);
    return linha;
  }

  function linhaTarefa(t) {
    const autor = resolverNome(t.users_id);
    const min = Math.round((Number(t.actiontime) || 0) / 60);
    const tempoTxt = min >= 60 ? Math.floor(min/60) + 'h ' + (min%60) + 'min' : min + 'min';
    const linha = document.createElement('div'); linha.className = 'linhaEvento';
    const icone = document.createElement('div'); icone.className = 'iconeEvento'; icone.textContent = '\\u23F1';
    const texto = document.createElement('div'); texto.className = 'textoEvento';
    const spanConteudo = document.createElement('span');
    spanConteudo.innerHTML = '<strong>' + autor + '</strong> registrou ' + tempoTxt + ': ';
    const spanTexto = document.createElement('span'); spanTexto.textContent = limparHtml(t.content);
    texto.appendChild(spanConteudo); texto.appendChild(spanTexto);
    const menu = document.createElement('span'); menu.className = 'menu'; menu.textContent = '\\u22EF'; menu.title = 'Editar';
    const hora = document.createElement('div'); hora.className = 'horaEvento'; hora.textContent = fmtData(t.date || t.date_creation);
    linha.appendChild(icone); linha.appendChild(texto); linha.appendChild(menu); linha.appendChild(hora);
    menu.addEventListener('click', () => {
      texto.innerHTML = '';
      const area = document.createElement('textarea'); area.className = 'caixaEdicaoInline';
      area.value = limparHtml(t.content); area.style.width = '100%'; area.style.minHeight = '60px';
      area.style.fontFamily = 'inherit'; area.style.fontSize = '13px'; area.style.padding = '6px';
      area.style.background = 'var(--vscode-input-background)'; area.style.color = 'var(--vscode-input-foreground)';
      area.style.border = '1px solid var(--vscode-input-border, transparent)'; area.style.borderRadius = '4px';
      const acoes = document.createElement('div'); acoes.className = 'acoesEdicao';
      const salvar = document.createElement('button'); salvar.className = 'btnPrimario'; salvar.textContent = 'Salvar';
      const cancelar = document.createElement('button'); cancelar.className = 'btnSecundario'; cancelar.textContent = 'Cancelar';
      acoes.appendChild(salvar); acoes.appendChild(cancelar);
      texto.appendChild(area); texto.appendChild(acoes);
      area.focus();
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); salvar.click(); }
      });
      salvar.addEventListener('click', () => vscode.postMessage({ type: 'salvarTarefa', id: t.id, content: area.value }));
      cancelar.addEventListener('click', () => renderizar(ultimoEstado));
    });
    return linha;
  }

  /* ---------- painel lateral: campos e atores ---------- */
  function marcarAlterado(campo, valor) {
    camposPendentes[campo] = valor;
    atualizarBotaoSalvar();
  }
  function atualizarBotaoSalvar() {
    const temPendencia = Object.keys(camposPendentes).length > 0 || atoresAlterados;
    $('btnSalvarDetalhes').disabled = !temPendencia;
    if (temPendencia) $('confirmacaoSalvo').classList.remove('visivel');
  }

  function popularCategoriaEdit(tipo) {
    const visiveis = categoriasTodas.filter((c) => {
      const flag = tipo === '2' ? c.is_request : c.is_incident;
      return flag === null || flag === undefined ? true : Number(flag) === 1;
    });
    const atual = $('categoriaEdit').value;
    preencherSelect($('categoriaEdit'), visiveis);
    if (visiveis.some((c) => String(c.id) === atual)) $('categoriaEdit').value = atual;
  }

  function renderChips(papel) {
    const cont = $('chips' + papel); cont.innerHTML = '';
    const lista = selecionados[papel];
    if (!lista.length) {
      const v = document.createElement('span'); v.className = 'vazioAtor'; v.textContent = 'Ninguem definido';
      cont.appendChild(v); return;
    }
    lista.forEach((a) => {
      const chip = document.createElement('span'); chip.className = 'chipAtor';
      chip.appendChild(criarAvatar(a.nome, true));
      const nome = document.createElement('span');
      nome.textContent = a.ehGrupo ? a.nome + ' (grupo)' : a.nome;
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '\\u00D7'; x.title = 'Remover';
      x.addEventListener('click', () => {
        selecionados[papel] = selecionados[papel].filter((i) => !(i.ehGrupo === a.ehGrupo && String(i.id) === String(a.id)));
        atoresAlterados = true;
        renderChips(papel); renderLista(papel); atualizarBotaoSalvar();
      });
      chip.appendChild(nome); chip.appendChild(x); cont.appendChild(chip);
    });
  }

  function atualizarContagem(papel) {
    $('contagem' + papel).textContent = selecionados[papel].length + ' selecionado(s)';
  }

  function renderLista(papel) {
    const cont = $('lista' + papel); cont.innerHTML = '';
    const filtro = ($('busca' + papel).value || '').toLowerCase();
    const marcado = (ehGrupo, id) =>
      selecionados[papel].some((s) => s.ehGrupo === ehGrupo && String(s.id) === String(id));

    const secoes = [
      { rot: 'Usuarios', itens: usuarios, ehGrupo: false },
      { rot: 'Grupos', itens: grupos, ehGrupo: true }
    ];
    secoes.forEach((sec) => {
      const filtrados = sec.itens.filter((i) => i.name.toLowerCase().includes(filtro));
      if (!filtrados.length) return;
      const rot = document.createElement('div'); rot.className = 'grupoRot'; rot.textContent = sec.rot;
      cont.appendChild(rot);
      filtrados.slice(0, 80).forEach((i) => {
        const item = document.createElement('label'); item.className = 'opcaoItem';
        const cb = document.createElement('input'); cb.type = 'checkbox';
        cb.checked = marcado(sec.ehGrupo, i.id);
        if (cb.checked) item.classList.add('marcada');
        cb.addEventListener('change', () => {
          if (cb.checked) {
            selecionados[papel].push({ ehGrupo: sec.ehGrupo, id: i.id, nome: i.name });
          } else {
            selecionados[papel] = selecionados[papel].filter(
              (s) => !(s.ehGrupo === sec.ehGrupo && String(s.id) === String(i.id)));
          }
          atoresAlterados = true;
          item.classList.toggle('marcada', cb.checked);
          renderChips(papel); atualizarContagem(papel); atualizarBotaoSalvar();
        });
        if (!sec.ehGrupo) item.appendChild(criarAvatar(i.name, true));
        const txt = document.createElement('span'); txt.className = 'nomeOpcao'; txt.textContent = i.name;
        item.appendChild(cb); item.appendChild(txt); cont.appendChild(item);
      });
    });
    if (!cont.children.length) {
      const v = document.createElement('div'); v.className = 'grupoRot'; v.textContent = 'Nenhum resultado';
      cont.appendChild(v);
    }
  }

  PAPEIS.forEach((papel) => {
    $('gear' + papel).addEventListener('click', (e) => {
      e.stopPropagation();
      const p = $('picker' + papel);
      const abrindo = !p.classList.contains('aberto');
      PAPEIS.forEach((outro) => { if (outro !== papel) $('picker' + outro).classList.remove('aberto'); });
      p.classList.toggle('aberto', abrindo);
      if (abrindo) {
        $('busca' + papel).value = '';
        renderLista(papel); atualizarContagem(papel);
        $('busca' + papel).focus();
      }
    });
    $('busca' + papel).addEventListener('input', () => renderLista(papel));
    $('ok' + papel).addEventListener('click', () => $('picker' + papel).classList.remove('aberto'));
  });
  document.addEventListener('click', (e) => {
    PAPEIS.forEach((papel) => {
      const p = $('picker' + papel);
      if (p.classList.contains('aberto') && !p.contains(e.target) && e.target !== $('gear' + papel)) {
        p.classList.remove('aberto');
      }
    });
  });

  /* ---------- renderizacao geral ---------- */
  function renderizar(m) {
    ultimoEstado = m;
    elementosPreview = {};
    usuarios = m.usuarios || []; grupos = m.grupos || [];
    mapaUsuarios = m.mapaUsuarios || {};
    mapaGrupos = {}; grupos.forEach((g) => { mapaGrupos[String(g.id)] = g.name; });
    categoriasTodas = m.categorias || [];

    $('carregando').style.display = 'none';
    $('erro').style.display = 'none';
    $('topo').style.display = 'block';
    $('btnAtualizar').classList.remove('girando');
    $('corpo').style.display = 'flex';
    if (m.larguraPainel) $('painelLateral').style.width = m.larguraPainel + 'px';

    const t = m.ticket;

    /* cabecalho */
    $('tituloChamado').textContent = t.name || '(sem titulo)';
    $('tituloChamado').style.display = 'block';
    $('tituloEditor').style.display = 'none';
    $('numeroChamado').textContent = '#' + t.id;
    const st = Number(t.status);
    const MAPA_CLS_STATUS = { 1: 'novo', 2: 'atribuido', 3: 'planejado', 4: 'pendente', 5: 'solucionado', 6: 'fechado' };
    const clsPil = MAPA_CLS_STATUS[st] || '';
    const criador = resolverNome(t.users_id_recipient || t.users_id);
    $('metaChamado').innerHTML =
      '<span class="pilulaStatus ' + clsPil + '">' + (STATUS_TXT[st] || '-') + '</span>' +
      '<span>Aberto por <strong>' + criador + '</strong> em ' + fmtData(t.date) + '</span>' +
      (t.date_mod ? '<span>&middot; atualizado em ' + fmtData(t.date_mod) + '</span>' : '');

    /* timeline */
    const tl = $('timeline'); tl.innerHTML = '';
    tl.appendChild(cardMensagem(criador, t.date, t.date_mod, t.name, t.content,
      (txt) => vscode.postMessage({ type: 'salvarAbertura', content: txt })));
    const itens = [];
    (m.documentos || []).forEach((d) => itens.push({ tipo: 'anexo', data: d.data || t.date, obj: d }));
    (m.followups || []).forEach((f) => itens.push({ tipo: 'followup', data: f.date || f.date_creation, obj: f }));
    (m.validacoes || []).forEach((v) => itens.push({ tipo: 'validacao', data: v.submission_date, obj: v }));
    (m.tasks || []).forEach((tk) => itens.push({ tipo: 'tarefa', data: tk.date || tk.date_creation, obj: tk }));
    (m.solucoes || []).forEach((s) => itens.push({ tipo: 'solucao', data: s.date_creation || s.date, obj: s }));
    itens.sort((a, b) => new Date(a.data) - new Date(b.data));
    itens.forEach((it) => {
      if (it.tipo === 'anexo') {
        const d = it.obj;
        const autorAnexo = d.usuarioId ? resolverNome(d.usuarioId) : criador;
        tl.appendChild(cardAnexo(autorAnexo, d.data || t.date, d.nome, formatarTamanhoLocal(d.tamanho), d.id));
      } else if (it.tipo === 'followup') {
        const f = it.obj;
        tl.appendChild(cardMensagem(resolverNome(f.users_id), f.date || f.date_creation, f.date_mod, null, f.content,
          (txt) => vscode.postMessage({ type: 'salvarFollowup', id: f.id, content: txt }), f.id));
      } else if (it.tipo === 'tarefa') { tl.appendChild(linhaTarefa(it.obj)); }
      else if (it.tipo === 'solucao') { tl.appendChild(cardSolucao(it.obj)); }
      else { tl.appendChild(linhaValidacao(it.obj)); }
    });
    tl.scrollTop = tl.scrollHeight;

    /* painel lateral */
    $('tipoEdit').value = String(t.type || 1);
    $('statusEdit').value = String(t.status || 1);
    atualizarCorStatusSelect();
    preencherSelect($('localizacaoEdit'), m.localizacoes || []);
    $('localizacaoEdit').value = t.locations_id ? String(t.locations_id) : '';
    popularCategoriaEdit($('tipoEdit').value);
    $('categoriaEdit').value = t.itilcategories_id ? String(t.itilcategories_id) : '';
    const seg = Number(t.actiontime) || 0;
    $('duracaoDias').value = Math.floor(seg / 86400) || '';
    $('duracaoHoras').value = Math.floor((seg % 86400) / 3600) || '';
    $('duracaoMinutos').value = Math.floor((seg % 3600) / 60) || '';

    const converter = (lista) => (lista || []).map((a) => ({
      ehGrupo: a.tipoAtor === 'group',
      id: a.refId,
      nome: a.tipoAtor === 'group' ? resolverGrupo(a.refId) : resolverNome(a.refId)
    }));
    selecionados.Requerente = converter(m.requerentesAtuais);
    selecionados.Observador = converter(m.observadoresAtuais);
    selecionados.Atribuido = converter(m.atribuidosAtuais);
    PAPEIS.forEach((p) => { renderChips(p); $('picker' + p).classList.remove('aberto'); });

    /* rascunho e estado do botao salvar */
    if (m.rascunho && !$('composerTexto').value) $('composerTexto').value = m.rascunho;
    camposPendentes = {}; atoresAlterados = false;
    $('btnSalvarDetalhes').disabled = true;
    $('btnSalvarDetalhes').textContent = 'Salvar alteracoes';
    if (salvandoDetalhes) {
      salvandoDetalhes = false;
      $('confirmacaoSalvo').classList.add('visivel');
      setTimeout(() => $('confirmacaoSalvo').classList.remove('visivel'), 2500);
    }
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'dados') renderizar(m);
    else if (m.type === 'previewDoc') {
      const img = elementosPreview[m.docId];
      if (img) img.src = 'data:' + m.mime + ';base64,' + m.base64;
    }
    else if (m.type === 'resetComposer') {
      // Painel provisorio trocou de chamado: limpa rascunho/anexos da tela anterior
      // antes dos dados do novo chamado chegarem.
      $('composerTexto').value = '';
      arquivosSelecionados = []; renderAnexosComposer();
      modoComposer = 'comentario'; atualizarModoComposer();
      $('carregando').style.display = 'block';
      $('corpo').style.display = 'none';
      $('topo').style.display = 'none';
    }
    else if (m.type === 'erro') {
      $('carregando').style.display = 'none';
      $('erro').textContent = 'Erro: ' + m.message;
      $('erro').style.display = 'block';
      $('btnSalvarDetalhes').disabled = false;
      $('btnSalvarDetalhes').textContent = 'Salvar alteracoes';
      $('btnComentar').disabled = false;
      $('btnComentar').textContent = 'Comentar';
      $('btnAtualizar').classList.remove('girando');
    }
  });

  /* ---------- cabecalho: renomear, copiar, abrir ---------- */
  $('btnRenomear').addEventListener('click', () => {
    $('tituloInput').value = ultimoEstado && ultimoEstado.ticket ? (ultimoEstado.ticket.name || '') : '';
    $('tituloChamado').style.display = 'none';
    $('tituloEditor').style.display = 'flex';
    $('tituloInput').focus();
  });
  $('tituloCancelar').addEventListener('click', () => {
    $('tituloEditor').style.display = 'none';
    $('tituloChamado').style.display = 'block';
  });
  $('tituloSalvar').addEventListener('click', () => {
    const v = $('tituloInput').value.trim();
    if (!v) return;
    salvandoDetalhes = true;
    vscode.postMessage({ type: 'salvarTudo', campos: { name: v }, atores: null });
  });
  $('tituloInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('tituloSalvar').click();
    if (e.key === 'Escape') $('tituloCancelar').click();
  });
  $('btnCopiarLink').addEventListener('click', () => vscode.postMessage({ type: 'copiarLink' }));
  $('btnNavegador').addEventListener('click', () => vscode.postMessage({ type: 'abrirNavegador' }));
  $('btnAtualizar').addEventListener('click', () => {
    $('btnAtualizar').classList.add('girando');
    vscode.postMessage({ type: 'recarregar' });
  });

  /* ---------- campos do painel lateral ---------- */
  $('tipoEdit').addEventListener('change', () => {
    popularCategoriaEdit($('tipoEdit').value);
    marcarAlterado('type', Number($('tipoEdit').value));
  });
  const CORES_STATUS_SELECT = { '1': '#60a5fa', '2': '#e6b432', '3': '#4cbb6c', '4': '#a68bea', '5': '#c08552', '6': '#c08552' };
  function atualizarCorStatusSelect() {
    $('statusEdit').style.color = CORES_STATUS_SELECT[$('statusEdit').value] || '';
  }
  $('statusEdit').addEventListener('change', () => {
    marcarAlterado('status', Number($('statusEdit').value));
    atualizarCorStatusSelect();
  });
  $('categoriaEdit').addEventListener('change', () => {
    const v = $('categoriaEdit').value; marcarAlterado('itilcategories_id', v ? Number(v) : 0);
  });
  $('localizacaoEdit').addEventListener('change', () => {
    const v = $('localizacaoEdit').value; marcarAlterado('locations_id', v ? Number(v) : 0);
  });
  function marcarDuracao() {
    const d = parseInt($('duracaoDias').value || '0', 10);
    const h = parseInt($('duracaoHoras').value || '0', 10);
    const mi = parseInt($('duracaoMinutos').value || '0', 10);
    marcarAlterado('actiontime', ((d * 24 + h) * 60 + mi) * 60);
  }
  ['duracaoDias','duracaoHoras','duracaoMinutos'].forEach((id) => $(id).addEventListener('input', marcarDuracao));

  $('btnSalvarDetalhes').addEventListener('click', () => {
    if (Object.keys(camposPendentes).length === 0 && !atoresAlterados) return;
    salvandoDetalhes = true;
    $('btnSalvarDetalhes').disabled = true;
    $('btnSalvarDetalhes').textContent = 'Salvando...';
    const atores = atoresAlterados ? {
      requerente: selecionados.Requerente.map((a) => ({ ehGrupo: a.ehGrupo, id: a.id })),
      observador: selecionados.Observador.map((a) => ({ ehGrupo: a.ehGrupo, id: a.id })),
      atribuido: selecionados.Atribuido.map((a) => ({ ehGrupo: a.ehGrupo, id: a.id }))
    } : null;
    vscode.postMessage({ type: 'salvarTudo', campos: camposPendentes, atores: atores });
  });

  /* ---------- composer ---------- */
  function renderAnexosComposer() {
    const cont = $('anexosComposer'); cont.innerHTML = '';
    arquivosSelecionados.forEach((a, i) => {
      const chip = document.createElement('span'); chip.className = 'anexoChip';
      const nome = document.createElement('span'); nome.textContent = a.nome;
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '\\u00D7';
      x.addEventListener('click', () => { arquivosSelecionados.splice(i, 1); renderAnexosComposer(); });
      chip.appendChild(nome); chip.appendChild(x); cont.appendChild(chip);
    });
  }
  function lerArquivoBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }
  $('btnAnexar').addEventListener('click', () => $('composerArquivo').click());
  $('composerArquivo').addEventListener('change', () => {
    Array.from($('composerArquivo').files || []).forEach((f) =>
      arquivosSelecionados.push({ nome: f.name, tipo: f.type, arquivo: f }));
    renderAnexosComposer();
    $('composerArquivo').value = '';
  });
  function atualizarModoComposer() {
    if (modoComposer === 'solucao') {
      $('bannerComposer').style.display = 'flex';
      $('btnComentar').textContent = 'Adicionar solucao';
      $('composerTexto').placeholder = 'Descreva a solucao proposta...';
    } else {
      $('bannerComposer').style.display = 'none';
      $('btnComentar').textContent = 'Comentar';
      $('composerTexto').placeholder = 'Deixe um comentario...';
    }
  }
  $('cancelarModoComposer').addEventListener('click', () => {
    modoComposer = 'comentario';
    atualizarModoComposer();
  });

  $('btnComentar').addEventListener('click', async () => {
    const v = $('composerTexto').value.trim();
    if (!v && arquivosSelecionados.length === 0) return;

    if (modoComposer === 'solucao') {
      if (!v) return;
      vscode.postMessage({ type: 'criarSolucao', content: v });
      $('composerTexto').value = '';
      modoComposer = 'comentario';
      atualizarModoComposer();
      return;
    }

    $('btnComentar').disabled = true;
    $('btnComentar').textContent = arquivosSelecionados.length ? 'Enviando anexos...' : 'Enviando...';
    try {
      const arquivos = [];
      for (const a of arquivosSelecionados) {
        arquivos.push({ nome: a.nome, tipo: a.tipo, base64: await lerArquivoBase64(a.arquivo) });
      }
      vscode.postMessage({ type: 'enviarResposta', content: v, arquivos: arquivos });
      $('composerTexto').value = '';
      arquivosSelecionados = []; renderAnexosComposer();
    } finally {
      $('btnComentar').disabled = false;
      $('btnComentar').textContent = 'Comentar';
    }
  });
  let timerRascunho = null;
  $('composerTexto').addEventListener('input', () => {
    clearTimeout(timerRascunho);
    timerRascunho = setTimeout(() => {
      vscode.postMessage({ type: 'salvarRascunho', content: $('composerTexto').value });
    }, 800);
  });
  $('composerTexto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      $('btnComentar').click();
    }
  });

  /* ---------- menus e overlays ---------- */
  $('btnChevron').addEventListener('click', (e) => {
    e.stopPropagation();
    $('menuMaisOpcoes').classList.remove('aberto');
    $('menuAcoes').classList.toggle('aberto');
  });
  $('btnMaisOpcoes').addEventListener('click', (e) => {
    e.stopPropagation();
    $('menuAcoes').classList.remove('aberto');
    $('menuMaisOpcoes').classList.toggle('aberto');
  });
  document.addEventListener('click', () => {
    $('menuAcoes').classList.remove('aberto');
    $('menuMaisOpcoes').classList.remove('aberto');
  });

  function popularValidadorAprov() {
    preencherSelect($('aprovValidador'), $('aprovTipo').value === 'group' ? grupos : usuarios);
  }
  $('aprovTipo').addEventListener('change', popularValidadorAprov);
  $('opAprovacao').addEventListener('click', () => {
    popularValidadorAprov();
    $('overlayAprovacao').classList.add('aberto');
  });
  $('aprovCancelar').addEventListener('click', () => $('overlayAprovacao').classList.remove('aberto'));
  $('aprovEnviar').addEventListener('click', () => {
    const id = $('aprovValidador').value;
    if (!id) return;
    vscode.postMessage({ type: 'pedirAprovacao', validatorType: $('aprovTipo').value, validatorId: id });
    $('overlayAprovacao').classList.remove('aberto');
  });

  $('opTarefa').addEventListener('click', () => {
    $('tarefaTexto').value = ''; $('tarefaHoras').value = ''; $('tarefaMinutos').value = '';
    $('overlayTarefa').classList.add('aberto');
  });
  $('tarefaCancelar').addEventListener('click', () => $('overlayTarefa').classList.remove('aberto'));
  $('tarefaEnviar').addEventListener('click', () => {
    const c = $('tarefaTexto').value.trim();
    if (!c) return;
    const h = parseInt($('tarefaHoras').value || '0', 10);
    const mi = parseInt($('tarefaMinutos').value || '0', 10);
    vscode.postMessage({ type: 'criarTarefa', content: c, actiontime: (h * 60 + mi) * 60 });
    $('overlayTarefa').classList.remove('aberto');
  });
  $('tarefaTexto').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('tarefaEnviar').click(); }
  });

  // Adicionar solucao: reaproveita o texto ja digitado no composer.
  $('opSolucao').addEventListener('click', () => {
    $('menuAcoes').classList.remove('aberto');
    modoComposer = 'solucao';
    atualizarModoComposer();
    $('composerTexto').focus();
  });

  $('opExcluir').addEventListener('click', () => {
    $('excluirIdTexto').textContent = ultimoEstado && ultimoEstado.ticket ? ultimoEstado.ticket.id : '';
    $('overlayExcluir').classList.add('aberto');
  });
  $('excluirCancelar').addEventListener('click', () => $('overlayExcluir').classList.remove('aberto'));
  $('excluirConfirmar').addEventListener('click', () => {
    $('overlayExcluir').classList.remove('aberto');
    vscode.postMessage({ type: 'excluirChamado' });
  });

  /* ---------- redimensionamento ---------- */
  let arrastando = false;
  $('resizer').addEventListener('mousedown', (e) => {
    arrastando = true; $('resizer').classList.add('arrastando');
    document.body.style.cursor = 'col-resize'; e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!arrastando) return;
    const r = $('corpo').getBoundingClientRect();
    const nova = Math.max(240, Math.min(520, r.right - e.clientX));
    $('painelLateral').style.width = nova + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!arrastando) return;
    arrastando = false; $('resizer').classList.remove('arrastando');
    document.body.style.cursor = '';
    const l = parseInt($('painelLateral').style.width, 10);
    if (l) vscode.postMessage({ type: 'salvarLarguraPainel', largura: l });
  });

  vscode.postMessage({ type: 'pronto' });
</script>
</body>
</html>`;
  }

}

function activate(context) {
  const listaProvider = new GlpiListaProvider(context);
  const meusProvider = new GlpiMeusProvider(context);
  const painelProvider = new GlpiPainelProvider(context);
  const formProvider = new GlpiFormProvider(context, () => {
    listaProvider.refresh();
    meusProvider.refresh();
    painelProvider.carregar();
  });

  GlpiDetalhePanel.aoAlterarListas = () => {
    listaProvider.refresh();
    meusProvider.refresh();
    painelProvider.carregar();
  };

  const filtroSalvo =
    context.globalState.get('glpi.filtro') || {
      statusId: null,
      statusLabel: null,
      tecnicoId: null,
      tecnicoNome: null
    };
  listaProvider.setFiltro(filtroSalvo);

  const listaView = vscode.window.createTreeView(GlpiListaProvider.viewId, {
    treeDataProvider: listaProvider
  });
  listaView.description = descricaoFiltro(filtroSalvo);

  const filtroMeusSalvo =
    context.globalState.get('glpi.filtroMeus') || {
      statusId: null,
      naoSolucionado: true,
      statusLabel: 'Nao solucionado'
    };
  meusProvider.setFiltroStatus(filtroMeusSalvo);
  const meusView = vscode.window.createTreeView(GlpiMeusProvider.viewId, {
    treeDataProvider: meusProvider
  });
  meusView.description = filtroMeusSalvo.statusLabel ? 'Status: ' + filtroMeusSalvo.statusLabel : '';

  const opcoesOrdenacao = [
    { label: 'Mais recentes', campo: null, ordem: 'DESC' },
    { label: 'Data de abertura', campo: CAMPO.dataAbertura, ordem: 'DESC' },
    { label: 'Prazo mais proximo', campo: CAMPO.prazo, ordem: 'ASC' },
    { label: 'Ultima atualizacao', campo: CAMPO.dataAtualizacao, ordem: 'DESC' }
  ];
  const ordenacaoListaSalva = context.globalState.get('glpi.ordenacaoLista') || opcoesOrdenacao[0];
  listaProvider.setOrdenacao(ordenacaoListaSalva);
  const ordenacaoMeusSalva = context.globalState.get('glpi.ordenacaoMeus') || opcoesOrdenacao[0];
  meusProvider.setOrdenacao(ordenacaoMeusSalva);

  context.subscriptions.push(
    listaView,
    meusView,
    vscode.window.registerWebviewViewProvider(GlpiFormProvider.viewId, formProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.window.registerWebviewViewProvider(GlpiPainelProvider.viewId, painelProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('glpi.atualizarLista', () => listaProvider.refresh()),
    vscode.commands.registerCommand('glpi.carregarMaisLista', () => listaProvider.carregarMais()),
    vscode.commands.registerCommand('glpi.carregarMaisMeus', () => meusProvider.carregarMais()),
    vscode.commands.registerCommand('glpi.ordenarLista', async () => {
      const esc = await vscode.window.showQuickPick(opcoesOrdenacao, {
        title: 'Ordenar chamados',
        placeHolder: 'Selecione o criterio de ordenacao'
      });
      if (!esc) return;
      await context.globalState.update('glpi.ordenacaoLista', esc);
      listaProvider.setOrdenacao(esc);
    }),
    vscode.commands.registerCommand('glpi.ordenarMeus', async () => {
      const esc = await vscode.window.showQuickPick(opcoesOrdenacao, {
        title: 'Ordenar meus atribuidos',
        placeHolder: 'Selecione o criterio de ordenacao'
      });
      if (!esc) return;
      await context.globalState.update('glpi.ordenacaoMeus', esc);
      meusProvider.setOrdenacao(esc);
    }),
    vscode.commands.registerCommand('glpi.buscarPorId', async () => {
      const valor = await vscode.window.showInputBox({
        title: 'Buscar chamado por ID',
        prompt: 'Informe o numero do chamado (ex: 1080). Deixe vazio para limpar a busca.',
        value: listaProvider.buscaId ? String(listaProvider.buscaId) : '',
        validateInput: (v) => {
          if (!v) return undefined;
          return /^\d+$/.test(v.trim()) ? undefined : 'Informe apenas numeros.';
        }
      });
      if (valor === undefined) return;
      const id = valor.trim() ? Number(valor.trim()) : null;
      listaProvider.setBuscaId(id);
      listaView.description = id ? `Buscando #${id}` : descricaoFiltro(filtroSalvo);
    }),
    vscode.commands.registerCommand('glpi.atualizarMeus', () => meusProvider.refresh()),
    vscode.commands.registerCommand('glpi.filtrarMeus', async () => {
      const opcoes = [
        { label: 'Nao solucionado', statusId: null, naoSolucionado: true },
        { label: 'Todos os status', statusId: null, naoSolucionado: false },
        { label: 'Novo', statusId: 1 },
        { label: 'Em atendimento (atribuido)', statusId: 2 },
        { label: 'Em atendimento (planejado)', statusId: 3 },
        { label: 'Pendente', statusId: 4 },
        { label: 'Solucionado', statusId: 5 },
        { label: 'Fechado', statusId: 6 }
      ];
      const esc = await vscode.window.showQuickPick(opcoes, {
        title: 'Filtrar meus atribuidos por status',
        placeHolder: 'Selecione o status'
      });
      if (!esc) return;
      const temFiltro = Boolean(esc.statusId) || Boolean(esc.naoSolucionado);
      const filtro = {
        statusId: esc.statusId || null,
        naoSolucionado: Boolean(esc.naoSolucionado),
        statusLabel: temFiltro ? esc.label : null
      };
      await context.globalState.update('glpi.filtroMeus', filtro);
      meusProvider.setFiltroStatus(filtro);
      meusView.description = filtro.statusLabel ? 'Status: ' + filtro.statusLabel : '';
    }),
    vscode.commands.registerCommand('glpi.atualizarPainel', () => painelProvider.carregar()),
    vscode.commands.registerCommand('glpi.abrirNoNavegador', (apiUrl, id) => {
      vscode.env.openExternal(vscode.Uri.parse(urlChamadoWeb(apiUrl, id)));
    }),
    vscode.commands.registerCommand('glpi.abrirDetalhes', (idOuItem) => {
      // Clique na linha passa o id direto; menu de contexto passa o TreeItem.
      const id = idOuItem && typeof idOuItem === 'object' ? idOuItem.ticketId : idOuItem;
      if (id) GlpiDetalhePanel.abrir(context, id);
    }),
    vscode.commands.registerCommand('glpi.abrirDetalhesAoLado', (item) => {
      if (item && item.ticketId) GlpiDetalhePanel.abrir(context, item.ticketId, true);
    }),
    vscode.commands.registerCommand('glpi.renomearChamado', async (item) => {
      if (!item || !item.ticketId) return;
      const cred = await lerCredenciais(context);
      if (!credenciaisCompletas(cred)) {
        vscode.window.showErrorMessage('Configure as credenciais do GLPI primeiro.');
        return;
      }
      const novoTitulo = await vscode.window.showInputBox({
        title: `Renomear chamado #${item.ticketId}`,
        value: item.tituloAtual || '',
        prompt: 'Novo titulo do chamado',
        validateInput: (v) => (v && v.trim() ? undefined : 'O titulo nao pode ficar vazio.')
      });
      if (novoTitulo === undefined || novoTitulo.trim() === (item.tituloAtual || '')) return;
      try {
        await comSessao(cred, (t) => editarTicket(cred, t, item.ticketId, { name: novoTitulo.trim() }));
        listaProvider.refresh();
        meusProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage('Falha ao renomear: ' + String(e.message || e));
      }
    }),
    vscode.commands.registerCommand('glpi.marcarVisualizado', async (item) => {
      if (!item || !item.ticketId) return;
      await definirVisualizado(context, item.ticketId, true);
      listaProvider.refresh();
      meusProvider.refresh();
    }),
    vscode.commands.registerCommand('glpi.removerVisualizado', async (item) => {
      if (!item || !item.ticketId) return;
      await definirVisualizado(context, item.ticketId, false);
      listaProvider.refresh();
      meusProvider.refresh();
    }),
    vscode.commands.registerCommand('glpi.limparFiltro', async () => {
      const filtro = { statusId: null, statusLabel: null, tecnicoId: null, tecnicoNome: null };
      await context.globalState.update('glpi.filtro', filtro);
      listaProvider.buscaId = null;
      listaProvider.setFiltro(filtro);
      listaView.description = descricaoFiltro(filtro);
    }),
    vscode.commands.registerCommand('glpi.filtrar', async () => {
      const cred = await lerCredenciais(context);
      if (!credenciaisCompletas(cred)) {
        vscode.window.showErrorMessage('Configure as credenciais do GLPI primeiro.');
        return;
      }
      const statusItens = [
        { label: 'Todos os status', id: null },
        { label: 'Novo', id: 1 },
        { label: 'Em atendimento (atribuido)', id: 2 },
        { label: 'Em atendimento (planejado)', id: 3 },
        { label: 'Pendente', id: 4 },
        { label: 'Solucionado', id: 5 },
        { label: 'Fechado', id: 6 }
      ];
      const st = await vscode.window.showQuickPick(statusItens, {
        title: 'Filtrar por status',
        placeHolder: 'Selecione o status'
      });
      if (!st) return;

      let tecnicoId = null;
      let tecnicoNome = null;
      try {
        const users = await comSessao(cred, (t) => buscarTodos(cred, t, 'User'));
        const techItens = [{ label: 'Todos os tecnicos', id: null }].concat(
          users
            .map((u) => ({
              label: ((u.firstname || '') + ' ' + (u.realname || '')).trim() || u.name || '#' + u.id,
              id: u.id
            }))
            .filter((x) => x.label)
            .sort((a, b) => a.label.localeCompare(b.label))
        );
        const tc = await vscode.window.showQuickPick(techItens, {
          title: 'Filtrar por tecnico',
          placeHolder: 'Selecione o tecnico'
        });
        if (!tc) return;
        tecnicoId = tc.id;
        tecnicoNome = tc.id ? tc.label : null;
      } catch (e) {
        vscode.window.showErrorMessage('Falha ao carregar tecnicos: ' + String(e.message || e));
        return;
      }

      const filtro = {
        statusId: st.id,
        statusLabel: st.id ? st.label : null,
        tecnicoId,
        tecnicoNome
      };
      await context.globalState.update('glpi.filtro', filtro);
      listaProvider.buscaId = null;
      listaProvider.setFiltro(filtro);
      listaView.description = descricaoFiltro(filtro);
    }),
    vscode.commands.registerCommand('glpi.reconfigurar', async () => {
      const cred = await pedirCredenciais(context);
      if (cred) {
        limparCacheSessao();
        vscode.window.showInformationMessage('Credenciais do GLPI atualizadas.');
        formProvider.carregarDropdowns();
        listaProvider.refresh();
        meusProvider.refresh();
        painelProvider.carregar();
      }
    })
  );

  // --- Notificacao de chamados atualizados (verificacao periodica) ---------
  async function checarAtualizacoes() {
    const cred = await lerCredenciais(context);
    if (!credenciaisCompletas(cred)) return;
    try {
      await comSessao(cred, async (token) => {
        const sessao = await getFullSession(cred, token);
        const meuId = sessao && sessao.glpiID;
        if (!meuId) return;
        const desde =
          context.globalState.get('glpi.ultimaChecagem') ||
          paraDataGlpi(new Date(Date.now() - 24 * 60 * 60 * 1000));
        const total = await contarTickets(cred, token, [
          { field: CAMPO.tecnico, searchtype: 'equals', value: meuId },
          { field: CAMPO.dataAtualizacao, searchtype: 'morethan', value: desde }
        ]);
        await context.globalState.update('glpi.ultimaChecagem', paraDataGlpi(new Date()));
        if (total > 0) {
          meusProvider.refresh();
          const escolha = await vscode.window.showInformationMessage(
            `Voce tem ${total} chamado(s) atualizado(s) no GLPI.`,
            'Ver meus atribuidos'
          );
          if (escolha) {
            vscode.commands.executeCommand('workbench.view.extension.glpi');
          }
        }
      });
    } catch (_) {
      // Falha pontual de rede/sessao nao deve incomodar o usuario.
    }
  }
  const intervaloNotificacao = setInterval(checarAtualizacoes, 5 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(intervaloNotificacao) });
  setTimeout(checarAtualizacoes, 15 * 1000);
}

function deactivate() {}

module.exports = { activate, deactivate };
