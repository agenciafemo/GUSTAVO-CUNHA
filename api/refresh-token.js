/**
 * GET/POST /api/refresh-token
 *
 * Rotina segura, executada no servidor, para renovar o token de longa
 * duração do Instagram (validade de 60 dias) antes do vencimento.
 *
 * - Protegida por CRON_SECRET: só executa com
 *   "Authorization: Bearer <CRON_SECRET>". Na Vercel, o cron configurado
 *   em vercel.json envia esse cabeçalho automaticamente.
 * - Se VERCEL_TOKEN + VERCEL_PROJECT_ID estiverem configurados, o novo
 *   token é gravado automaticamente na variável de ambiente
 *   INSTAGRAM_ACCESS_TOKEN do projeto (renovação 100% automática).
 * - O token NUNCA aparece na resposta nem nos logs.
 */

const GRAPH_BASE = 'https://graph.instagram.com';

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  // --- Autorização -------------------------------------------------------
  const secret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'] || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'not_configured' });
  }

  // --- Renovação na API do Instagram --------------------------------------
  let refreshed;
  try {
    const url =
      `${GRAPH_BASE}/refresh_access_token` +
      `?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const body = await response.json();

    if (!response.ok || body.error || !body.access_token) {
      const code = body.error && body.error.code;
      console.error(`[refresh-token] falha na renovação (HTTP ${response.status}, code ${code || 'n/a'})`);
      return res.status(502).json({
        ok: false,
        error: code === 190 ? 'token_expired' : 'refresh_failed',
      });
    }
    refreshed = body; // { access_token, token_type, expires_in }
  } catch (e) {
    console.error('[refresh-token] Instagram indisponível durante a renovação.');
    return res.status(502).json({ ok: false, error: 'network' });
  }

  const expiresInDays = Math.floor((refreshed.expires_in || 0) / 86400);

  // --- Persistência do novo token -----------------------------------------
  const persisted = await persistOnVercel(refreshed.access_token);

  // A Meta devolve um token com string diferente, e as funções só enxergam a
  // env nova após um deploy — então dispara um redeploy da produção.
  const redeployed = persisted ? await redeployProduction() : false;

  return res.status(200).json({
    ok: true,
    expires_in_days: expiresInDays,
    persisted, // true = env atualizada automaticamente; false = atualizar no painel
    redeployed, // true = produção redeployada com o token novo
    note: persisted
      ? 'Novo token gravado na variável de ambiente do projeto.'
      : 'Renovado na Meta, mas VERCEL_TOKEN/VERCEL_PROJECT_ID não configurados — atualize INSTAGRAM_ACCESS_TOKEN manualmente no painel da hospedagem.',
  });
};

/**
 * Atualiza INSTAGRAM_ACCESS_TOKEN no projeto da Vercel via API oficial.
 * Retorna true em caso de sucesso, false se não configurado ou em erro.
 */
async function persistOnVercel(newToken) {
  const apiToken = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!apiToken || !projectId) return false;

  const teamQS = process.env.VERCEL_TEAM_ID
    ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : '';
  const base = `https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}/env`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // Localiza o ID da variável INSTAGRAM_ACCESS_TOKEN
    const listRes = await fetch(`${base}${teamQS}`, { headers });
    const list = await listRes.json();
    const envVar = (list.envs || []).find((e) => e.key === 'INSTAGRAM_ACCESS_TOKEN');
    if (!envVar) {
      console.error('[refresh-token] variável INSTAGRAM_ACCESS_TOKEN não encontrada na Vercel.');
      return false;
    }

    const patchRes = await fetch(`${base}/${envVar.id}${teamQS}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ value: newToken }),
    });
    if (!patchRes.ok) {
      console.error(`[refresh-token] falha ao gravar env na Vercel (HTTP ${patchRes.status}).`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[refresh-token] erro de rede ao gravar env na Vercel.');
    return false;
  }
}

/**
 * Redeploya a última produção para que as funções passem a usar o token novo.
 * Retorna true se o redeploy foi criado com sucesso.
 */
async function redeployProduction() {
  const apiToken = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!apiToken || !projectId) return false;

  const teamParam = process.env.VERCEL_TEAM_ID
    ? `&teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}`
    : '';
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    'Content-Type': 'application/json',
  };

  try {
    // Localiza o deployment de produção mais recente
    const listRes = await fetch(
      `https://api.vercel.com/v6/deployments?projectId=${encodeURIComponent(projectId)}&target=production&state=READY&limit=1${teamParam}`,
      { headers }
    );
    const list = await listRes.json();
    const latest = list.deployments && list.deployments[0];
    if (!latest) {
      console.error('[refresh-token] nenhum deployment de produção encontrado para redeploy.');
      return false;
    }

    // Cria um novo deployment a partir do atual (equivalente ao "Redeploy")
    const createRes = await fetch(
      `https://api.vercel.com/v13/deployments?forceNew=1${teamParam}`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: latest.name,
          deploymentId: latest.uid,
          target: 'production',
          meta: { trigger: 'instagram-token-refresh' },
        }),
      }
    );
    if (!createRes.ok) {
      console.error(`[refresh-token] falha ao redeployar produção (HTTP ${createRes.status}).`);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[refresh-token] erro de rede ao redeployar produção.');
    return false;
  }
}
