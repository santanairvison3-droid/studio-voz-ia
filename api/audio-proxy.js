const jwt = require('jsonwebtoken');

// Chaves DarkPlanner do usuário (com failover) — usado só no fallback X-API-Key
// (o normal é o CDN público). Com failover o áudio pode estar em qualquer conta.
function dpKeysFor(uid) {
  const keys = [process.env.DP_API_KEY, process.env.DP_API_KEY_2].filter(Boolean);
  if (keys.length <= 1) return keys;
  const s = String(uid || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const primary = h % keys.length;
  return [keys[primary], ...keys.filter((_, i) => i !== primary)];
}

// Só arquivos da própria DarkPlanner passam pelo proxy (não somos proxy aberto)
const HOSTS_PERMITIDOS = /(^|\.)darkplanner\.com\.br$/i;

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  let user;
  try { user = jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Token inválido' }); }

  const audioUrl = req.query.url;
  if (!audioUrl) return res.status(400).json({ error: 'url obrigatória' });

  const alvo = decodeURIComponent(audioUrl);
  try {
    const host = new URL(alvo).hostname;
    if (!HOSTS_PERMITIDOS.test(host))
      return res.status(400).json({ error: 'URL fora do domínio permitido' });
  } catch {
    return res.status(400).json({ error: 'URL inválida' });
  }

  // ?name=meu-audio.mp3 → o navegador baixa com ESSE nome (Content-Disposition, no streaming).
  const nome = String(req.query.name || '').replace(/[^\w\-. ]+/g, '').substring(0, 90);
  const ehSrt = /\.srt(\?|$)/i.test(alvo) || /\.srt$/i.test(nome);

  try {
    // ── ENXUGAR (25/07): o "Fast Origin Transfer" da Vercel ESTOUROU (27GB/10GB do
    // Hobby → projeto PAUSADO) porque cada MP3 passava BYTE A BYTE por esta função.
    // Correção: quando o arquivo é PÚBLICO no CDN do DarkPlanner, REDIRECIONA (302) o
    // navegador direto pro CDN — os bytes deixam de passar pela Vercel (origem ~zero).
    // O SRT é minúsculo → continua pelo proxy (preserva nome/charset). MP3 privado
    // (raro, só no failover X-API-Key) → streaming como antes.
    if (!ehSrt) {
      let publico = false;
      try {
        const head = await fetch(alvo, { method: 'HEAD' });
        publico = head.ok;
      } catch { publico = false; }
      if (publico) {
        res.setHeader('Location', alvo);
        return res.status(302).end();
      }
    }

    // Tenta primeiro sem auth (CDN público)
    let upstream = await fetch(alvo);

    // Se falhou, tenta com X-API-Key — percorre as contas do usuário (failover)
    if (!upstream.ok) {
      for (const dpKey of dpKeysFor(user.sub || user.id)) {
        upstream = await fetch(alvo, { headers: { 'X-API-Key': dpKey } });
        if (upstream.ok) break;
      }
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Falhou: HTTP ${upstream.status}` });
    }

    // ── Nome do arquivo no download (atualização 16/07/2026) ──
    res.setHeader('Content-Type', ehSrt
      ? 'application/x-subrip; charset=utf-8'
      : (upstream.headers.get('content-type') || 'audio/mpeg'));
    if (nome) res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const cl = upstream.headers.get('content-length');
    if (cl) res.setHeader('Content-Length', cl);

    const buffer = await upstream.arrayBuffer();
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: 'Erro: ' + err.message });
  }
};
