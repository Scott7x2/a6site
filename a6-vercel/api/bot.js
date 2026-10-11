// Proxy Vercel -> bot do Discord (Pterodactyl).
// Roda no servidor da Vercel e chama o bot por HTTP, então não depende de
// "rewrite externo" aceitar IP:porta. Só repassa as rotas que o site usa.
const http = require("http");

const BOT = new URL(process.env.BOT_URL || "http://85.209.93.33:30002");
const TIMEOUT_MS = 8000;
const PUBLIC_CACHE = "public, s-maxage=10, stale-while-revalidate=30";

// Lista de rotas permitidas (o resto, como webhook e plugin, vai direto pro bot, não por aqui)
const ROUTES = [
  { methods: ["GET"], re: /^api\/(info|status|me|ranking)$/, cacheable: (p) => p !== "api/me" },
  { methods: ["GET"], re: /^api\/order\/[A-Za-z0-9_-]{1,64}$/ },
  { methods: ["POST"], re: /^api\/checkout$/ },
  { methods: ["GET"], re: /^steam-login(\/callback)?$/ },
  { methods: ["GET"], re: /^vincular(\/callback)?$/ },
  { methods: ["GET"], re: /^logout$/ },
];

const FORWARD_REQ_HEADERS = ["cookie", "content-type", "accept", "accept-language", "user-agent"];
const SKIP_RES_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-length", "content-encoding"]);

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj, null, 2));
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Length", body.length);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function callBot({ method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BOT.hostname,
      port: BOT.port || 80,
      path,
      method,
      headers: { ...headers, host: BOT.host, "accept-encoding": "identity" },
      timeout: TIMEOUT_MS,
    };
    if (body && body.length) opts.headers["content-length"] = body.length;
    const r = http.request(opts, (resp) => {
      const chunks = [];
      resp.on("data", (c) => chunks.push(c));
      resp.on("end", () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    r.on("error", reject);
    if (body && body.length) r.write(body);
    r.end();
  });
}

const HINTS = {
  ECONNREFUSED: "O bot recusou a conexão: bot desligado ou porta errada no vercel/BOT_URL.",
  ETIMEDOUT: "Sem resposta: a hospedagem do bot pode estar bloqueando o IP da Vercel (firewall) ou a porta não está pública.",
  ENOTFOUND: "O endereço do bot não foi encontrado (confira o IP/domínio).",
  ECONNRESET: "A conexão foi derrubada pelo bot ou pela hospedagem.",
};

async function diag(req, res) {
  const t0 = Date.now();
  const info = { bot: BOT.origin, node: process.version, seen_url: req.url };
  try {
    const r = await callBot({ method: "GET", path: "/api/status", headers: {} });
    sendJson(res, 200, { ok: r.status === 200, ...info, bot_status: r.status, ms: Date.now() - t0, preview: r.body.toString("utf8").slice(0, 300) });
  } catch (e) {
    sendJson(res, 200, { ok: false, ...info, error: e.code || e.message, hint: HINTS[e.code] || "Falha ao falar com o bot.", ms: Date.now() - t0 });
  }
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("diag") === "1") return diag(req, res);

  // O caminho original vem no parâmetro __r (definido nos rewrites do vercel.json);
  // se não vier, usa o próprio caminho da requisição.
  let path = null;
  const keep = [];
  const raw = url.search.replace(/^\?/, "");
  try {
    for (const part of raw ? raw.split("&") : []) {
      if (part.startsWith("__r=")) path = decodeURIComponent(part.slice(4));
      else keep.push(part); // mantém a query original intacta (a assinatura do login Steam depende disso)
    }
    if (path === null) path = decodeURIComponent(url.pathname);
  } catch {
    return sendJson(res, 400, { error: "caminho inválido" });
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");

  const route = ROUTES.find((r) => r.re.test(path));
  if (!route) return sendJson(res, 404, { error: "rota não permitida", path });
  if (!route.methods.includes(req.method)) return sendJson(res, 405, { error: "método não permitido" });

  const headers = {};
  for (const h of FORWARD_REQ_HEADERS) if (req.headers[h]) headers[h] = req.headers[h];

  let body;
  if (req.method === "POST") {
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: "corpo inválido" });
    }
  }

  let out;
  try {
    out = await callBot({ method: req.method, path: "/" + path + (keep.length ? "?" + keep.join("&") : ""), headers, body });
  } catch (e) {
    return sendJson(res, 502, { error: "bot indisponível", code: e.code || e.message, hint: HINTS[e.code] });
  }

  res.statusCode = out.status;
  for (const [k, v] of Object.entries(out.headers)) {
    if (SKIP_RES_HEADERS.has(k) || k === "cache-control") continue;
    res.setHeader(k, v); // set-cookie chega como lista e é repassado inteiro
  }
  const cacheable = route.cacheable && route.cacheable(path) && out.status === 200;
  res.setHeader("Cache-Control", cacheable ? PUBLIC_CACHE : "no-store");
  res.setHeader("Content-Length", out.body.length);
  res.end(out.body);
};
