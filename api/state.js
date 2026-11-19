// Função do Vercel: guarda o estado da pelada num Redis (Upstash) e confere a senha.
// Variáveis de ambiente usadas:
//   KV_REST_API_URL e KV_REST_API_TOKEN  (criadas pelo Vercel ao conectar o Upstash Redis)
//   EDIT_PASSWORD                        (a senha para editar, definida por você)

const crypto = require("crypto");

const CHAVE = "pelada:estado";
const LIMITE = 400000; // bytes

function config() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
  };
}

async function redis(comando) {
  const { url, token } = config();
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(comando),
  });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || "redis " + r.status);
  return j.result;
}

// true = senha certa, false = senha errada, null = senha não configurada no servidor
function conferirSenha(req) {
  const esperada = process.env.EDIT_PASSWORD;
  if (!esperada) return null;
  const dada = String(req.headers["x-senha"] || "").trim().toLowerCase();
  const certa = String(esperada).trim().toLowerCase();
  const a = Buffer.from(dada);
  const b = Buffer.from(certa);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lerCorpo(req) {
  let b = req.body;
  if (typeof b === "string") {
    try { b = JSON.parse(b); } catch (e) { b = null; }
  }
  return b && typeof b === "object" ? b : {};
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const { url, token } = config();
    if (!url || !token) {
      return res.status(500).json({ erro: "banco de dados não conectado" });
    }

    // Leitura: qualquer pessoa pode ver
    if (req.method === "GET") {
      const bruto = await redis(["GET", CHAVE]);
      if (!bruto) return res.status(200).json({ data: null, versao: 0 });
      const estado = JSON.parse(bruto);
      const v = Number((req.query && req.query.v) || 0);
      if (v && v === estado.versao) return res.status(200).json({ mudou: false, versao: estado.versao });
      return res.status(200).json({ data: estado.data, versao: estado.versao });
    }

    // Conferir a senha (login)
    if (req.method === "POST") {
      const ok = conferirSenha(req);
      if (ok === null) return res.status(500).json({ erro: "senha não configurada no servidor" });
      if (!ok) await esperar(500);
      return res.status(200).json({ ok });
    }

    // Gravar: só com a senha certa
    if (req.method === "PUT") {
      const ok = conferirSenha(req);
      if (ok === null) return res.status(500).json({ erro: "senha não configurada no servidor" });
      if (!ok) {
        await esperar(500);
        return res.status(401).json({ erro: "senha incorreta" });
      }
      const corpo = lerCorpo(req);
      const data = corpo.data;
      if (!data || typeof data !== "object" || !Array.isArray(data.jogos)) {
        return res.status(400).json({ erro: "dados inválidos" });
      }
      const texto = JSON.stringify(data);
      if (texto.length > LIMITE) return res.status(413).json({ erro: "dados grandes demais" });

      let anterior = 0;
      const bruto = await redis(["GET", CHAVE]);
      if (bruto) {
        try { anterior = JSON.parse(bruto).versao || 0; } catch (e) { anterior = 0; }
      }
      const versao = Math.max(Date.now(), anterior + 1);
      await redis(["SET", CHAVE, JSON.stringify({ versao, data })]);
      return res.status(200).json({ ok: true, versao });
    }

    res.setHeader("Allow", "GET, POST, PUT");
    return res.status(405).json({ erro: "método não permitido" });
  } catch (e) {
    return res.status(500).json({ erro: "falha no servidor" });
  }
};
