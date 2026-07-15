/**
 * GET /api/instagram
 *
 * Rota segura que consulta a API oficial do Instagram (graph.instagram.com)
 * e devolve as 6 publicações mais recentes já saneadas para o front-end.
 *
 * - O token NUNCA sai do servidor: a resposta contém apenas dados públicos.
 * - Cache de 30 minutos (memória da função + CDN via Cache-Control).
 * - Em caso de falha da API (token expirado, rate limit, resposta inválida),
 *   responde 200 com a última versão em cache ou lista vazia — a página
 *   nunca quebra.
 */

const GRAPH_BASE = 'https://graph.instagram.com/v23.0';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos
const POST_LIMIT = 6;

// Cache em memória (persiste enquanto a instância serverless estiver quente)
let cache = { data: null, fetchedAt: 0 };

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache na CDN: 30 min fresco + serve versão antiga enquanto revalida
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');
  // Dados públicos: libera consumo pelo ambiente de desenvolvimento (Live Server)
  res.setHeader('Access-Control-Allow-Origin', '*');

  const token = process.env.INSTAGRAM_ACCESS_TOKEN;
  if (!token) {
    return res.status(200).json({ posts: [], error: 'not_configured' });
  }

  // 1) Cache fresco → responde direto
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return res.status(200).json({ profile: cache.profile, posts: cache.data, cached: true });
  }

  try {
    // 2) Obtém/valida a conta profissional autorizada (com dados de perfil)
    const account = await resolveAccount(token);
    const userId = account.id;

    // 3) Busca as publicações mais recentes com os campos mínimos
    const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp';
    const mediaUrl =
      `${GRAPH_BASE}/${encodeURIComponent(userId)}/media` +
      `?fields=${fields}&limit=${POST_LIMIT * 2}&access_token=${encodeURIComponent(token)}`;

    const payload = await fetchGraph(mediaUrl);

    if (!payload || !Array.isArray(payload.data)) {
      throw graphError('invalid_response', 'Resposta da API sem lista de mídias.');
    }

    // 4) Sanea: define a capa por tipo e descarta mídia sem imagem utilizável
    const posts = payload.data
      .map(toPost)
      .filter(Boolean)
      .slice(0, POST_LIMIT);

    cache = { data: posts, profile: account.profile, fetchedAt: Date.now() };
    return res.status(200).json({ profile: account.profile, posts });
  } catch (err) {
    const type = err.igType || 'unknown';
    // Log sem token e sem dados sensíveis
    console.error(`[instagram] falha (${type}): ${err.message}`);

    // Nunca derruba a página: serve cache antigo se existir, senão lista vazia
    if (cache.data) {
      return res
        .status(200)
        .json({ profile: cache.profile, posts: cache.data, cached: true, stale: true, error: type });
    }
    return res.status(200).json({ profile: null, posts: [], error: type });
  }
};

/**
 * Valida o INSTAGRAM_USER_ID configurado contra a conta dona do token e
 * retorna os dados públicos de perfil usados no cabeçalho do feed.
 */
async function resolveAccount(token) {
  const fields = 'id,username,name,profile_picture_url,media_count,followers_count,follows_count';
  const me = await fetchGraph(
    `${GRAPH_BASE}/me?fields=${fields}&access_token=${encodeURIComponent(token)}`
  );
  if (!me || !me.id) {
    throw graphError('invalid_response', 'Não foi possível identificar a conta autorizada.');
  }
  const configured = process.env.INSTAGRAM_USER_ID;
  if (configured && configured !== String(me.id)) {
    console.warn(
      `[instagram] INSTAGRAM_USER_ID configurado não corresponde à conta do token (@${me.username}). Usando o ID validado pela API.`
    );
  }
  return {
    id: String(me.id),
    profile: {
      username: me.username || '',
      name: me.name || '',
      picture: me.profile_picture_url || null,
      media_count: me.media_count ?? null,
      followers_count: me.followers_count ?? null,
      follows_count: me.follows_count ?? null,
    },
  };
}

/** Converte uma mídia da API no formato consumido pelo front. */
function toPost(item) {
  if (!item || !item.id || !item.permalink) return null;

  let cover = null;
  switch (item.media_type) {
    case 'VIDEO':
    case 'REELS':
      cover = item.thumbnail_url || null;
      break;
    case 'CAROUSEL_ALBUM':
    case 'IMAGE':
    default:
      // Para carrossel, media_url é a mídia principal retornada pela API
      cover = item.media_url || item.thumbnail_url || null;
      break;
  }
  if (!cover) return null; // mídia sem imagem utilizável → descarta

  return {
    id: item.id,
    caption: typeof item.caption === 'string' ? item.caption.slice(0, 300) : '',
    media_type: item.media_type || 'IMAGE',
    cover,
    permalink: item.permalink,
    timestamp: item.timestamp || null,
  };
}

/** Chama a Graph API e traduz erros em tipos conhecidos. */
async function fetchGraph(url) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    throw graphError('network', 'Instagram indisponível no momento.');
  }

  let body;
  try {
    body = await response.json();
  } catch (e) {
    throw graphError('invalid_response', `Resposta não é JSON válido (HTTP ${response.status}).`);
  }

  if (!response.ok || body.error) {
    const code = body.error && body.error.code;
    if (code === 190) {
      throw graphError('token_expired', 'Token de acesso expirado ou inválido.');
    }
    if (code === 4 || code === 17 || code === 32 || code === 613) {
      throw graphError('rate_limited', 'Limite de requisições da API atingido.');
    }
    throw graphError('api_error', `Erro da API (HTTP ${response.status}, code ${code || 'n/a'}).`);
  }
  return body;
}

function graphError(type, message) {
  const err = new Error(message);
  err.igType = type;
  return err;
}
