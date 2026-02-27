/**
 * index.js (ESM) — NUFI + Telegram + Webhook + Créditos + Admin + PDF fallback
 * Requisitos:
 * - Node 18+ (mejor 20+)
 * - package.json: { "type": "module" }
 *
 * .env esperado:
 * BOT_TOKEN=xxxx
 * NUFI_API_KEY=xxxx
 * ALLOWED_IDS=8071178317,otro_id
 * ADMIN_ID=8071178317
 * WEBHOOK_SECRET=snupdrack_2026_api
 * PUBLIC_BASE_URL=https://tu-servicio.onrender.com  (o ngrok)
 * PORT=3000  (Render la pone sola)
 *
 * Opcional:
 * COST_PER_HISTORIAL=1
 * DATA_FILE=./data.json
 */

import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import { readFile, writeFile } from "fs/promises";
import PDFDocument from "pdfkit";

// ================= ENV =================
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

// ================= APP / BOT =================
const app = express();
app.use(express.json({ limit: "20mb" }));

const bot = new Telegraf(BOT_TOKEN);

// URL donde NUFI pegará el resultado
const PUBLIC_WEBHOOK = `${PUBLIC_BASE_URL}/webhook/${WEBHOOK_SECRET}`;

// Guardamos qué chat pidió cada UUID (memoria)
const pendingByUuid = new Map();

// ================= DATA (autorización / créditos) =================
/**
 * Estructura:
 * {
 *   "allowed": { "8071178317": true },
 *   "credits": { "8071178317": 10 }
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
  return Number(db.credits?.[String(chatId)] || 0);
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

// Cargar DB al iniciar
await loadDB();

// ================= HELPERS (PDF) =================
function extractUuid(anyBody) {
  return (
    anyBody?.data?.UUID ||
    anyBody?.data?.uuid ||
    anyBody?.data?.id ||
    anyBody?.datos?.UUID ||
    anyBody?.datos?.uuid ||
    anyBody?.datos?.id ||
    anyBody?.UUID ||
    anyBody?.uuid ||
    anyBody?.id
  );
}

function findBase64Pdf(anyBody) {
  // Busca varios nombres posibles
  return (
    anyBody?.data?.base64_semanas_cotizadas_nss ||
    anyBody?.data?.base64_historial_laboral ||
    anyBody?.data?.base64_pdf ||
    anyBody?.data?.base64 ||
    anyBody?.datos?.base64_semanas_cotizadas_nss ||
    anyBody?.datos?.base64_historial_laboral ||
    anyBody?.datos?.base64_pdf ||
    anyBody?.datos?.base64 ||
    anyBody?.base64_semanas_cotizadas_nss ||
    anyBody?.base64_historial_laboral ||
    anyBody?.base64_pdf ||
    anyBody?.base64
  );
}

function pickResultData(anyBody) {
  // Donde normalmente viene el resultado “bonito”
  return anyBody?.data || anyBody?.datos || anyBody;
}

async function generatePdfFromData(resultData) {
  // PDF simple y estable (fallback)
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", () => resolve(Buffer.concat(chunks)));

      doc.fontSize(18).text("NUFI - Resultado Generado", { align: "center" });
      doc.moveDown(1);

      const nombre =
        resultData?.ocr?.datos?.nombre ||
        resultData?.ocr?.nombre ||
        resultData?.nombre ||
        "N/D";
      const curp =
        resultData?.ocr?.datos?.curp || resultData?.ocr?.curp || resultData?.curp || "N/D";
      const nss =
        resultData?.ocr?.datos?.nss || resultData?.ocr?.nss || resultData?.nss || "N/D";
      const fecha =
        resultData?.ocr?.datos?.fecha_emision ||
        resultData?.fecha_emision ||
        new Date().toLocaleDateString();

      doc.fontSize(12);
      doc.text(`Nombre: ${String(nombre)}`);
      doc.text(`CURP: ${String(curp)}`);
      doc.text(`NSS: ${String(nss)}`);
      doc.text(`Fecha emisión: ${String(fecha)}`);
      doc.moveDown(1);

      const semanas =
        resultData?.ocr?.datos?.semanas_cotizadas ?? resultData?.semanas_cotizadas ?? "N/D";
      const descontadas =
        resultData?.ocr?.datos?.semanas_descontadas ?? resultData?.semanas_descontadas ?? "N/D";
      const reintegradas =
        resultData?.ocr?.datos?.semanas_reintegradas ?? resultData?.semanas_reintegradas ?? "N/D";

      doc.text(`Semanas cotizadas: ${String(semanas)}`);
      doc.text(`Semanas descontadas: ${String(descontadas)}`);
      doc.text(`Semanas reintegradas: ${String(reintegradas)}`);
      doc.moveDown(1);

      const empleos = Array.isArray(resultData?.empleos) ? resultData.empleos : [];
      doc.fontSize(14).text("Empleos:", { underline: true });
      doc.moveDown(0.5);

      if (!empleos.length) {
        doc.fontSize(12).text("Sin empleos listados en la respuesta.");
      } else {
        doc.fontSize(12);
        for (const e of empleos.slice(0, 30)) {
          doc.text(`• Patrón: ${e?.patron ?? "N/D"}`);
          doc.text(`  Registro patronal: ${e?.registro_patronal ?? "N/D"}`);
          doc.text(`  Entidad: ${e?.entidad_federativa ?? "N/D"}`);
          doc.text(`  Alta: ${e?.fecha_alta ?? "N/D"}   Baja: ${e?.fecha_baja ?? "N/D"}`);
          doc.text(`  Salario base: ${e?.salario_base ?? "N/D"}`);
          doc.moveDown(0.5);
        }
        if (empleos.length > 30) doc.text("... (más empleos omitidos)");
      }

      doc.moveDown(1);
      doc.fontSize(9).fillColor("gray").text("Documento generado automáticamente (fallback).");

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

// ================= ENDPOINTS HTTP =================
app.get("/health", (req, res) => res.json({ ok: true }));

app.get(`/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.status(405).send("Webhook listo ✅ (usa POST, no GET)");
});

// Webhook receptor: NUFI -> tu server
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    console.log("📩 Webhook recibido:", JSON.stringify(body).slice(0, 2000));

    const uuid = extractUuid(body);
    const chatId = pendingByUuid.get(uuid) || ALLOWED_IDS[0];

    // 1) Mandar JSON SIEMPRE (recortado)
    const jsonText = JSON.stringify(body, null, 2);
    await bot.telegram.sendMessage(
      chatId,
      "✅ Resultado recibido de NUFI (JSON):\n\n```json\n" + jsonText.slice(0, 3500) + "\n```",
      { parse_mode: "Markdown" }
    );

    // 2) PDF base64 si existe
    const base64Pdf = findBase64Pdf(body);

    if (base64Pdf && typeof base64Pdf === "string" && base64Pdf.length > 200) {
      const pdfBuffer = Buffer.from(base64Pdf, "base64");
      await bot.telegram.sendDocument(chatId, {
        source: pdfBuffer,
        filename: "NUFI_resultado.pdf",
      });
    } else {
      // 3) Si NO viene base64, generar PDF fallback
      const resultData = pickResultData(body);
      const pdfFallback = await generatePdfFromData(resultData);

      await bot.telegram.sendDocument(chatId, {
        source: pdfFallback,
        filename: "NUFI_resultado_generado.pdf",
      });

      await bot.telegram.sendMessage(
        chatId,
        "⚠️ NUFI no envió PDF en base64. Se generó uno automáticamente."
      );
    }

    if (uuid) pendingByUuid.delete(uuid);
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Error en webhook:", err);
    return res.sendStatus(500);
  }
});

// ================= TELEGRAM =================
bot.start(async (ctx) => {
  await ctx.reply(
    "👋 Bot activo.\n\n" +
      "Para ver tu Chat ID usa: /id\n" +
      (isAllowed(ctx)
        ? "\n✅ Ya estás autorizado.\nUsa: /historial CURP NSS"
        : "\n⛔ Aún no estás autorizado.")
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

// ===== ADMIN =====
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

// ===== COMANDO PRINCIPAL =====
bot.command("historial", async (ctx) => {
  try {
    const chatId = String(ctx.chat?.id ?? "");

    if (!isAllowed(ctx)) return ctx.reply(denyMessage());

    // Cobro (admin NO paga)
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

    const resp = await fetch(
      "https://nufi.azure-api.net/numero_seguridad_social/v2/consultar_historial",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "NUFI-API-KEY": NUFI_API_KEY,
        },
        body: JSON.stringify(payload),
      }
    );

    const data = await resp.json().catch(() => ({}));
    const uuid = extractUuid(data);

    if (!resp.ok) {
      // reembolso si no es admin
      if (!isAdmin(ctx)) await addCredits(chatId, COST_PER_HISTORIAL);

      return ctx.reply("❌ Error NUFI:\n\n```json\n" + JSON.stringify(data, null, 2) + "\n```", {
        parse_mode: "Markdown",
      });
    }

    if (!uuid) {
      // reembolso si no es admin
      if (!isAdmin(ctx)) await addCredits(chatId, COST_PER_HISTORIAL);

      return ctx.reply(
        "⚠️ Solicitud enviada, pero NUFI no regresó UUID.\n\n```json\n" +
          JSON.stringify(data, null, 2) +
          "\n```",
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

// ================= INICIO =================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Servidor corriendo en 0.0.0.0:${PORT}`);
  console.log(`🌍 Webhook público: ${PUBLIC_WEBHOOK}`);
});

bot.launch().then(() => console.log("✅ Bot iniciado"));

// Cierre limpio
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));