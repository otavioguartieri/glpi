# GLPI - Chamados (extensão VSCode)

Adiciona um container do GLPI na barra lateral (activity bar) com três seções:

1. **Abrir Chamado** — formulário (título, descrição, categoria, localização, duração).
2. **Chamados** — listagem com filtro persistente por status e técnico.
3. **Painel** — indicadores: total da organização, meus chamados, chamados abertos
   e distribuição por status.

## Requisito: API REST legada do GLPI (v1)

Esta extensão usa a **API REST legada** do GLPI (`api.php/v1`), não a API nova
(`api.php/v2.x`). Antes de configurar, confirme que ela está habilitada e reúna os
três valores abaixo.

### 1. Habilitar a API legada e obter a URL

No GLPI: **Configurar > Geral > API**. Ative o toggle **"Habilitar REST API legada"**.

Copie a **URL da API** que aparece logo abaixo desse toggle (na seção "API Legada"),
não a do topo da página — aquela é da API nova (v2.x) e não funciona com esta
extensão. A URL correta tem o formato:

```
https://SEU-GLPI/api.php/v1
```

### 2. Gerar o App-Token (Cliente de API)

Na mesma tela (**Configurar > Geral > API**), role até **"Clientes de API (API Legado)"**
e clique em **"Adicionar cliente de API"**. Preencha um nome, marque **Ativo = Sim**,
marque **"Re-gerar"** ao lado de **"Token da aplicação (app_token)"** e clique em
**"Adicionar"**. O valor gerado é o **App-Token**.

Se restringir por IP, deixe os campos de intervalo de IPv4 vazios para não bloquear
o acesso, a menos que você saiba o IP de quem vai usar a extensão.

### 3. Gerar o User-Token (token pessoal)

Clique no seu nome/avatar no canto superior direito e vá em **"Minhas configurações"**.
Na aba **Principal**, no campo **"Token de API"**, marque **"Re-gerar"** e clique em
**"Salvar"** (canto inferior direito). O valor gerado é o **User-Token** — pessoal,
vinculado ao seu usuário.

### 4. Informar na extensão

Na primeira abertura de qualquer seção da extensão, ela pede em sequência a URL da
API, o App-Token e o User-Token, e grava tudo no **SecretStorage** do VSCode
(criptografado). Não pergunta de novo depois disso. Para trocar (token expirado,
regenerado, etc.), use o ícone de engrenagem no topo da seção "Abrir Chamado"
(`GLPI: Reconfigurar credenciais`).

## Filtro da listagem

Na seção "Chamados", os ícones no topo permitem:

- **Filtrar** (funil): escolhe status e técnico. A seleção é gravada no `globalState`
  e permanece fixa entre sessões. O filtro ativo aparece na descrição da seção.
- **Limpar filtro**.
- **Atualizar**.

O filtro usa a search API do GLPI (`/search/Ticket`) com `criteria` (status = campo 12,
técnico = campo 5). Clicar num chamado abre-o na interface web do GLPI.

## Painel

Conta chamados via `totalcount` da search API, por status (campos 1..6), soma os
abertos (status 1 a 4) e obtém "meus" pelo requerente (campo 4) usando o `glpiID`
retornado por `getFullSession`. Botão de atualizar no topo da seção.

## Pré-requisitos

- VSCode 1.85+ (`fetch` global — Node 18+).
- API REST habilitada no GLPI.
- Rede/VPN até o servidor.
- Usuário (dono do User-Token) com permissão de leitura em Categorias, Localizações,
  Usuários e Chamados, e de criação de Chamados.

## Executar / empacotar

- Desenvolvimento: abrir a pasta no VSCode e pressionar `F5` (sem dependências).
- Pacote `.vsix`: `npm install -g @vscode/vsce` e `vsce package`.

## Search options (IDs) usados

Definidos no início do `extension.js`, na constante `CAMPO`. São os IDs padrão do
Ticket no GLPI: id=2, título=1, status=12, técnico=5, requerente=4, abertura=15.
Se alguma instância divergir, ajuste ali.
