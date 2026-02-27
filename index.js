/**
 * index.js (ESM) — NUFI + Telegram + Webhook + Créditos + Admin
 * Requisitos:
 * - Node 18+ (o 20+)
 * - package.json: { "type": "module" }
 *
 * .env esperado:
 * BOT_TOKEN=xxxx
 * NUFI_API_KEY=xxxx
 * ALLOWED_IDS=8071178317,otro_id_opcional
 * ADMIN_ID=8071178317
 * WEBHOOK_SECRET=snupdrack_2026_api
 * PUBLIC_BASE_URL=https://xxxxx.ngrok-free.dev
 * PORT=3000
 *
 * Opcional:
 * COST_PER_HISTORIAL=1
 * DATA_FILE=./data.json
 */

import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import { readFile, writeFile } from "fs/promises";

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const NUFI_API_KEY = process.env.NUFI_API_KEY;

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "webhook_secret";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const PORT = Number(process.env.PORT || 3000);

const ADMIN_ID = String(process.env.ADMIN_ID || "");
const COST_PER_HISTORIAL = Number(process.env.COST_PER_HISTORIAL || 1);
const DATA_FILE = process.env.DATA_FILE || "./data.json";

const ALLOWED_IDS = (process.env.ALLOWED_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Validaciones
if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN en .env");
if (!NUFI_API_KEY) throw new Error("Falta NUFI_API_KEY en .env");
if (!PUBLIC_BASE_URL) throw new Error("Falta PUBLIC_BASE_URL en .env");
if (!ALLOWED_IDS.length) throw new Error("Falta ALLOWED_IDS en .env (al menos 1 chat id)");
if (!ADMIN_ID) throw new Error("Falta ADMIN_ID en .env");

// ====== APP / BOT ======
const app = express();
app.use(express.json({ limit: "10mb" }));

const bot = new Telegraf(BOT_TOKEN);

// Donde NUFI pegará el resultado
const PUBLIC_WEBHOOK = `${PUBLIC_BASE_URL}/webhook/${WEBHOOK_SECRET}`;

// Guardamos qué chat pidió cada UUID para contestarle cuando llegue el webhook
const pendingByUuid = new Map();

// ===============================
//      DATA (autorización/créditos)
// ===============================
/**
 * Estructura:
 * {
 *   "allowed": { "8071178317": true, "otro": true },
 *   "credits": { "8071178317": 10, "otro": 0 }
 * }
 */
let db = { allowed: {}, credits: {} };

async function loadDB() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    db = JSON.parse(raw);
    if (!db.allowed) db.allowed = {};
    if (!db.credits) db.credits = {};
  } catch {
    // Si no existe, lo creamos con ALLOWED_IDS como permitidos
    db = { allowed: {}, credits: {} };
    for (const id of ALLOWED_IDS) db.allowed[id] = true;
    await saveDB();
  }
}

async function saveDB() {
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

function isAdmin(ctx) {
  return String(ctx.chat?.id ?? "") === String(ADMIN_ID);
}

function isAllowed(ctx) {
  const id = String(ctx.chat?.id ?? "");
  return db.allowed?.[id] === true;
}

function denyMessage() {
  return (
    "⛔ Acceso denegado.\n\n" +
    "✅ Solicita acceso con el administrador.\n" +
    "📩 Envía tu Chat ID con: /id"
  );
}

function getCredits(chatId) {
  const id = String(chatId);
  return Number(db.credits?.[id] || 0);
}

async function addCredits(chatId, amount) {
  const id = String(chatId);
  const cur = getCredits(id);
  db.credits[id] = Math.max(0, cur + Number(amount || 0));
  await saveDB();
  return db.credits[id];
}

async function setCredits(chatId, amount) {
  const id = String(chatId);
  db.credits[id] = Math.max(0, Number(amount || 0));
  await saveDB();
  return db.credits[id];
}

async function consumeCredits(chatId, cost) {
  const id = String(chatId);
  const cur = getCredits(id);
  if (cur < cost) return { ok: false, remaining: cur };
  db.credits[id] = cur - cost;
  await saveDB();
  return { ok: true, remaining: db.credits[id] };
}

async function grant(chatId) {
  db.allowed[String(chatId)] = true;
  await saveDB();
}

async function revoke(chatId) {
  delete db.allowed[String(chatId)];
  await saveDB();
}

// Llamar al inicio
await loadDB();

// ====== ENDPOINTS HTTP ======
app.get("/health", (req, res) => res.json({ ok: true }));

app.get(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.status(405).send("Webhook listo ✅ (usa POST, no GET)");
});

// Webhook receptor (NUFI -> tu server)
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    console.log("📩 Webhook recibido:", JSON.stringify(body).slice(0, 2000));

    const uuid =
      body?.data?.UUID ||
      body?.data?.uuid ||
      body?.data?.id ||
      body?.UUID ||
      body?.uuid ||
      body?.id;

    const chatId = pendingByUuid.get(uuid) || ALLOWED_IDS[0];

    // 1) Mandar primero el JSON (resumen bonito) SIEMPRE
    const safePreview = JSON.stringify(body, null, 2);
    await bot.telegram.sendMessage(
      chatId,
      "✅ Resultado recibido de NUFI (JSON):\n\n```json\n" + safePreview.slice(0, 3500) + "\n```",
      { parse_mode: "Markdown" }
    );

    // 2) Buscar base64 del PDF (si viene)
    const base64Pdf =
      body?.data?.base64_semanas_cotizadas_nss ||
      body?.data?.base64_historial_laboral ||
      body?.data?.base64_pdf ||
      body?.base64_semanas_cotizadas_nss ||
      body?.base64_historial_laboral ||
      body?.base64_pdf;

    if (base64Pdf && typeof base64Pdf === "string" && base64Pdf.length > 200) {
      const pdfBuffer = Buffer.from(base64Pdf, "base64");
      await bot.telegram.sendDocument(chatId, {
        source: pdfBuffer,
        filename: "Constancia_Semanas_Cotizadas.pdf",
      });
    } else {
      // Si no viene base64, avisar
      await bot.telegram.sendMessage(
        chatId,
        "⚠️ No llegó PDF en base64 (el campo viene vacío o no existe)."
      );
    }

    if (uuid) pendingByUuid.delete(uuid);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error en webhook:", err);
    return res.sendStatus(500);
  }
});

// ====== TELEGRAM ======
bot.start(async (ctx) => {
  // Permite a cualquiera pedir /id
  await ctx.reply(
    "👋 Bot activo.\n\n" +
      "Para ver tu Chat ID usa: /id\n" +
      (isAllowed(ctx) ? "\n✅ Ya estás autorizado. Usa: /historial CURP NSS" : "\n⛔ Aún no estás autorizado.")
  );
});

bot.command("id", async (ctx) => {
  const id = String(ctx.chat?.id ?? "");
  await ctx.reply("🆔 Tu Chat ID es:\n" + id);
});

bot.command("saldo", async (ctx) => {
  const chatId = String(ctx.chat?.id ?? "");
  if (!isAllowed(ctx)) return ctx.reply(denyMessage());
  const c = getCredits(chatId);
  await ctx.reply(`💳 Tus créditos: ${c}\nCosto por consulta: ${COST_PER_HISTORIAL}`);
});

// ====== ADMIN COMMANDS ======
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  await ctx.reply(
    "🛠️ Admin comandos:\n\n" +
      "/grant CHAT_ID  → autoriza\n" +
      "/revoke CHAT_ID → revoca\n" +
      "/addcredits CHAT_ID MONTO → suma\n" +
      "/setcredits CHAT_ID MONTO → fija\n" +
      "/credits CHAT_ID → ver\n" +
      "/users → lista autorizados\n"
  );
});

bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const target = parts[1];
  if (!target) return ctx.reply("Uso: /grant CHAT_ID");
  await grant(target);
  await ctx.reply(`✅ Autorizado: ${target}`);
});

bot.command("revoke", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const target = parts[1];
  if (!target) return ctx.reply("Uso: /revoke CHAT_ID");
  await revoke(target);
  await ctx.reply(`✅ Revocado: ${target}`);
});

bot.command("addcredits", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const target = parts[1];
  const amount = Number(parts[2]);
  if (!target || Number.isNaN(amount)) return ctx.reply("Uso: /addcredits CHAT_ID MONTO");
  const newBal = await addCredits(target, amount);
  await ctx.reply(`✅ Créditos actualizados para ${target}: ${newBal}`);
});

bot.command("setcredits", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const target = parts[1];
  const amount = Number(parts[2]);
  if (!target || Number.isNaN(amount)) return ctx.reply("Uso: /setcredits CHAT_ID MONTO");
  const newBal = await setCredits(target, amount);
  await ctx.reply(`✅ Créditos fijados para ${target}: ${newBal}`);
});

bot.command("credits", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const target = parts[1];
  if (!target) return ctx.reply("Uso: /credits CHAT_ID");
  await ctx.reply(`💳 Créditos de ${target}: ${getCredits(target)}`);
});

bot.command("users", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin.");
  const ids = Object.keys(db.allowed || {});
  if (!ids.length) return ctx.reply("No hay usuarios autorizados.");
  const lines = ids.map((id) => `- ${id} (créditos: ${getCredits(id)})`);
  await ctx.reply("✅ Autorizados:\n" + lines.join("\n"));
});

// ====== COMANDO PRINCIPAL ======
bot.command("historial", async (ctx) => {
  try {
    const chatId = String(ctx.chat?.id ?? "");

    // Acceso
    if (!isAllowed(ctx)) return ctx.reply(denyMessage());

    // Cobro créditos (admin NO paga)
    if (!isAdmin(ctx)) {
      const check = await consumeCredits(chatId, COST_PER_HISTORIAL);
      if (!check.ok) {
        return ctx.reply(
          `⛔ Sin créditos.\n\n` +
            `💳 Tienes: ${check.remaining}\n` +
            `Costo por consulta: ${COST_PER_HISTORIAL}\n\n` +
            `Solicita recarga al admin.`
        );
      }
      await ctx.reply(`💳 Crédito usado. Te quedan: ${check.remaining}`);
    }

    const parts = (ctx.message?.text || "").trim().split(/\s+/);
    const curp = parts[1];
    const nss = parts[2];

    if (!curp || !nss) {
      return ctx.reply("Uso: /historial CURP NSS\nEj: /historial RIGJ030913HOCSRLA1 50170318179");
    }

    await ctx.reply("⏳ Enviando consulta a NUFI...");

    const payload = {
      curp: String(curp),
      nss: String(nss),
      webhook: PUBLIC_WEBHOOK,
    };

    // ✅ Endpoint “consultar_historial” (el que tú estás usando)
    const resp = await fetch("https://nufi.azure-api.net/numero_seguridad_social/v2/consultar_historial", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "NUFI-API-KEY": NUFI_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const data = await resp.json().catch(() => ({}));

    const uuid =
      data?.datos?.UUID ||
      data?.datos?.uuid ||
      data?.datos?.id ||
      data?.data?.UUID ||
      data?.data?.uuid ||
      data?.data?.id ||
      data?.UUID ||
      data?.uuid ||
      data?.id;

    if (!resp.ok) {
      // Si falló NUFI, reembolsar crédito (excepto admin)
      if (!isAdmin(ctx)) await addCredits(chatId, COST_PER_HISTORIAL);

      return ctx.reply("❌ Error NUFI:\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```", {
        parse_mode: "Markdown",
      });
    }

    if (!uuid) {
      // Si no regresó UUID, reembolsar crédito (excepto admin)
      if (!isAdmin(ctx)) await addCredits(chatId, COST_PER_HISTORIAL);

      return ctx.reply(
        "⚠️ Solicitud enviada, pero NUFI no regresó UUID.\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```",
        { parse_mode: "Markdown" }
      );
    }

    pendingByUuid.set(uuid, chatId);

    await ctx.reply("✅ Solicitud enviada.\n\nUUID:\n" + uuid + "\n\n📩 Esperando webhook...");
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Error interno. Revisa consola.");
  }
});

// ====== INICIO ======
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en http://localhost:${PORT}`);
  console.log(`🌍 Webhook público: ${PUBLIC_WEBHOOK}`);
});

bot.launch().then(() => console.log("✅ Bot iniciado"));

// Cierre limpio
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));