import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 3000,
  GESPROV_URL,
  GESPROV_CLIENT_ID,
  GESPROV_CLIENT_SECRET,
  PROXY_API_KEY
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
    } catch {}
  }
  return null;
}

async function getToken(baseUrl, phpsessid) {
  const tokenUrl = `${baseUrl}/ges-api/v1/token`;
  const basic = base64(`${GESPROV_CLIENT_ID}:${GESPROV_CLIENT_SECRET}`);

  const r = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Cookie": phpsessid,
      "Content-Type": "application/json",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "railway-proxy"
    },
    body: JSON.stringify({})
  });

  const text = await r.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}

  if (!r.ok) return { ok: false, status: r.status, raw: text };
  if (payload?.erro) return { ok: false, status: 401, raw: payload };

  const access_token = payload?.data?.access_token || payload?.access_token || payload?.token_acesso;
  const token_type = payload?.data?.token_type || payload?.token_type || "Bearer";

  if (!access_token) return { ok: false, status: 502, raw: payload ?? text };

  return { ok: true, access_token, token_type };
}

async function authCycle() {
  const baseUrl = (GESPROV_URL || "").replace(/\/$/, "");
  if (!baseUrl) return { ok: false, status: 500, error: "GESPROV_URL not set" };

  const sid = await openSession(baseUrl);
  if (!sid) {
    // ✅ fallback: se você tiver um PHPSESSID fixo que funciona, coloque em env (opcional)
    const fixed = process.env.GESPROV_PHPSESSID ? `PHPSESSID=${process.env.GESPROV_PHPSESSID}` : null;
    if (!fixed) return { ok: false, status: 502, error: "Could not obtain PHPSESSID (session required)" };
    const tok = await getToken(baseUrl, fixed);
    if (!tok.ok) return { ok: false, status: tok.status, error: "Token failed", raw: tok.raw };
    return { ok: true, cookie: fixed, token: tok.access_token };
  }

  const tok = await getToken(baseUrl, sid);
  if (!tok.ok) return { ok: false, status: tok.status, error: "Token failed", raw: tok.raw };

  return { ok: true, cookie: sid, token: tok.access_token };
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// apenas para teste
app.post("/gesprov/auth", async (req, res) => {
  if (!requireKey(req, res)) return;

  const auth = await authCycle();
  if (!auth.ok) return res.status(auth.status || 500).json(auth);

  res.json({ ok: true, cookie: auth.cookie, token: auth.token });
});

// ✅ endpoint principal: consultar cliente
app.post("/gesprov/cliente", async (req, res) => {
  if (!requireKey(req, res)) return;

  const { cpf_cnpj, enviar_contratos = "Todos", enviar_servicos = "Todos" } = req.body || {};
  if (!cpf_cnpj) return res.status(400).json({ error: "cpf_cnpj obrigatório" });

  const auth = await authCycle();
  if (!auth.ok) return res.status(auth.status || 500).json(auth);

  const baseUrl = GESPROV_URL.replace(/\/$/, "");
  const url = `${baseUrl}/ges-api/v1/identificacao-cliente`;

  const body = JSON.stringify({
    cpf_cnpj: String(cpf_cnpj).replace(/\D/g, ""),
    enviar_contratos,
    enviar_servicos
  });

  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",                // ✅ exigência do Gesprov
      "Authorization": `Bearer ${auth.token}`,     // ✅ token
      "Cookie": auth.cookie,                       // ✅ PHPSESSID=...
      "User-Agent": "railway-proxy"
    },
    body
  });

  const text = await r.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch {}

  if (payload?.erro) {
    const status = payload.erro === "usuario_invalido" ? 401 : 400;
    return res.status(status).json(payload);
  }

  if (!r.ok) {
    return res.status(502).json({ error: `Gesprov error ${r.status}`, raw: text.slice(0, 800) });
  }

  return res.json(payload ?? { raw: text });
});

app.listen(PORT, () => console.log("Proxy running on port", PORT));
