// Vercel serverless proxy for Uniswap's auction data API. The API sends no CORS headers for
// other sites, so the website's planner calls /api/uniswap/<method> instead. Only read-only
// methods are forwarded, and responses are cached briefly at the edge.
const UPSTREAM = 'https://entry-gateway.backend-prod.api.uniswap.org/data.v1.AuctionService';
const ALLOWED = new Set(['ListTopAuctions', 'GetAuction']);
const MAX_BODY = 2048;

export default async function handler(req, res) {
  const method = String(req.query.method || '');
  if (!ALLOWED.has(method)) {
    res.status(404).json({ message: 'unknown method' });
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    res.status(405).json({ message: 'use POST' });
    return;
  }
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {});
  if (body.length > MAX_BODY) {
    res.status(413).json({ message: 'request too large' });
    return;
  }
  try {
    const upstream = await fetch(`${UPSTREAM}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'connect-protocol-version': '1' },
      body,
    });
    const text = await upstream.text();
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'public, s-maxage=20, stale-while-revalidate=60');
    res.status(upstream.status).send(text);
  } catch (e) {
    res
      .status(502)
      .json({ message: `upstream error: ${e instanceof Error ? e.message : String(e)}` });
  }
}
