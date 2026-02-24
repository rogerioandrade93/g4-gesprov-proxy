// server.js (Node 18+)
// Proxy Gesprov - com sessão (PHPSESSID) + token (Basic) + rotas cliente e faturas

import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,
  GESPROV_URL,
  GESPROV_CLIENT_ID,
  GESPROV_CLIENT_SECRET,
  PROXY_API_KEY,
  GESPROV_PHPSESSID // opcional: fallback caso não consiga abrir sessão
} = process.env;

function base64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

function requireKey(req, res) {
  if (!PROXY_API_KEY) return true; // se não setar, não exige
  const key = req.headers["x-api-key"] || req.headers["api_key"];
  if (key !== PROXY_API_KEY) {
    res.status(401).json({ error: "Unauthorized (invalid proxy key)" });
    return false;
  }
  return true;
}

// abre sessão pra pegar PHPSESSID (se o servidor devolver)
async function openSession(baseUrl) {
  const tries = [`${baseUrl}/`, `${baseUrl}/ges-api/`, `${baseUrl}/ges-api/v1/`];

  for (const url of tries) {
    try {
      const r = await fetch(url, { method: "GET" });
      const setCookie = r.headers.get("set-cookie");
      const m = setCookie?.match(/PHPSESSID=[^;]+/i);
      if (m) return m[0]; // "PHPSESSID=..."
    } catch {
      // ignora e tenta o próximo
    }
  }
  return null;
}

async function getToken(baseUrl, phpsessidCookie) {
  const tokenUrl = `${baseUrl}/ges-api/v1/token`;
  const basic = base64(`${GESPROV_CLIENT_ID}:${GESPROV_CLIENT_SECRET}`);

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      Cookie: phpsessidCookie,
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "railway-proxy"
    },
    body: JSON.stringify({})
  });

  const text = await r.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  if (!r.ok) return { ok: false, status: r.status, raw: payload ?? text };
  if (payload?.erro) return { ok: false, status: 401, raw: payload };

  const access_token =
    payload?.data?.access_token || payload?.access_token || payload?.token_acesso;
  const token_type = payload?.data?.token_type || payload?.token_type || "Bearer";

  if (!access_token) return { ok: false, status: 502, raw: payload ?? text };

  return { ok: true, access_token, token_type };
}

async function authCycle() {
  const baseUrl = (GESPROV_URL || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, status: 500, error: "GESPROV_URL not set" };
  if (!GESPROV_CLIENT_ID || !GESPROV_CLIENT_SECRET) {
    return {
      ok: false,
      status: 500,
      error: "GESPROV_CLIENT_ID / GESPROV_CLIENT_SECRET not set"
    };
  }

  const sid = await openSession(baseUrl);

  // fallback: se você tiver um PHPSESSID fixo que funciona
  const fixed = GESPROV_PHPSESSID ? `PHPSESSID=${GESPROV_PHPSESSID}` : null;
  const cookie = sid || fixed;

  if (!cookie) {
    return { ok: false, status: 502, error: "Could not obtain PHPSESSID (session required)" };
  }

  const tok = await getToken(baseUrl, cookie);
  if (!tok.ok) return { ok: false, status: tok.status, error: "Token failed", raw: tok.raw };

  return { ok: true, cookie, token: tok.access_token, token_type: tok.token_type };
}

// helper: POST padrão pra API do Gesprov (muitos endpoints exigem text/plain)
async function gesprovPost({ endpoint, auth, bodyObj, contentType = "text/plain" }) {
  const baseUrl = (GESPROV_URL || "").replace(/\/$/, "");
  const url = `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  const body =
    contentType === "application/json" ? JSON.stringify(bodyObj ?? {}) : JSON.stringify(bodyObj ?? {});

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      Authorization: `Bearer ${auth.token}`,
      Cookie: auth.cookie,
      "User-Agent": "railway-proxy",
      Accept: "application/json, text/plain, */*"
    },
    body
  });

  const text = await r.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {}

  return { r, text, payload };
}

// ================= ROUTES =================

app.get("/health", (_req, res) => res.json({ ok: true }));

// apenas para teste: retorna cookie e token
app.post("/gesprov/auth", async (req, res) => {
  if (!requireKey(req, res)) return;

  const auth = await authCycle();
  if (!auth.ok) return res.status(auth.status || 500).json(auth);

  res.json({ ok: true, cookie: auth.cookie, token: auth.token, token_type: auth.token_type });
});

// consultar cliente: identificacao-cliente
app.post("/gesprov/cliente", async (req, res) => {
  if (!requireKey(req, res)) return;

  const { cpf_cnpj, enviar_contratos = "Todos", enviar_servicos = "Todos" } = req.body || {};
  if (!cpf_cnpj) return res.status(400).json({ error: "cpf_cnpj obrigatório" });

  const auth = await authCycle();
  if (!auth.ok) return res.status(auth.status || 500).json(auth);

  const bodyObj = {
    cpf_cnpj: String(cpf_cnpj).replace(/\D/g, ""),
    enviar_contratos,
    enviar_servicos
  };

  const { r, text, payload } = await gesprovPost({
    endpoint: "/ges-api/v1/identificacao-cliente",
    auth,
    bodyObj,
    contentType: "text/plain" // ✅ exigência do Gesprov (mantido)
  });

  if (payload?.erro) {
    const status = payload.erro === "usuario_invalido" ? 401 : 400;
    return res.status(status).json(payload);
  }

  if (!r.ok) {
    return res.status(502).json({ error: `Gesprov error ${r.status}`, raw: (text || "").slice(0, 1200) });
  }

  return res.json(payload ?? { raw: text });
});

// ✅ NOVA ROTA: faturas / títulos
// IMPORTANTÍSSIMO: você só precisa ajustar o endpoint real do Gesprov abaixo
// (ex.: /ges-api/v1/lista-titulos, /ges-api/v1/faturas, /ges-api/v1/titulos, etc.)
app.post("/gesprov/faturas", async (req, res) => {
  if (!requireKey(req, res)) return;

  try {
    const { cpf_cnpj, situacao_titulo, ...rest } = req.body || {};
    if (!cpf_cnpj) return res.status(400).json({ error: "cpf_cnpj obrigatório" });

    const auth = await authCycle();
    if (!auth.ok) return res.status(auth.status || 500).json(auth);

    // 🔧 AJUSTE AQUI: endpoint real do Gesprov que retorna faturas/títulos
    const ENDPOINT_FATURAS = "/ges-api/v1/faturas"; // <-- troque para o endpoint correto do seu Gesprov

    const bodyObj = {
      cpf_cnpj: String(cpf_cnpj).replace(/\D/g, ""),
      situacao_titulo, // pode ser "Aberto", "Pago", "Vencido", etc (conforme Gesprov)
      ...rest // permite enviar outros filtros sem mexer no código
    };

    // Muitos endpoints do Gesprov também exigem text/plain.
    // Se o SEU endpoint exigir JSON de verdade, troque contentType para "application/json".
    const { r, text, payload } = await gesprovPost({
      endpoint: ENDPOINT_FATURAS,
      auth,
      bodyObj,
      contentType: "text/plain"
    });

    if (payload?.erro) {
      const status = payload.erro === "usuario_invalido" ? 401 : 400;
      return res.status(status).json(payload);
    }

    if (!r.ok) {
      return res.status(r.status).json({
        error: "Erro ao buscar faturas no Gesprov.",
        details: payload ?? { raw: (text || "").slice(0, 1200) }
      });
    }

    // Retorno padronizado para o seu app
    return res.status(200).json({
      success: true,
      faturas: payload?.titulos || payload?.faturas || payload?.data || payload
    });
  } catch (error) {
    console.error("Erro no proxy /gesprov/faturas:", error);
    return res.status(500).json({ error: "Erro interno no proxy ao buscar faturas." });
  }
});

app.listen(PORT, () => console.log("Proxy running on port", PORT));
