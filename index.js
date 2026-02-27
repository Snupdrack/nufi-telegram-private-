/**
 * index.js — NUFI + Telegram + Webhook + Créditos + Admin + PDF fallback
 * Node 18+
 * package.json debe tener: "type": "module"
 */

import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import fs from "fs";
import { readFile, writeFile } from "fs/promises";
import PDFDocument from "pdfkit";

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

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!NUFI_API_KEY) throw new Error("Falta NUFI_API_KEY");
if (!PUBLIC_BASE_URL) throw new Error("Falta PUBLIC_BASE_URL");
if (!ALLOWED_IDS.length) throw new Error("Falta ALLOWED_IDS");
if (!ADMIN_ID) throw new Error("Falta ADMIN_ID");

// ====== APP ======
const app = express();
app.use(express.json({ limit: "10mb" }));
const bot = new Telegraf(BOT_TOKEN);
const PUBLIC_WEBHOOK = `${PUBLIC_BASE_URL}/webhook/${WEBHOOK_SECRET}`;
const pendingByUuid = new Map();

// ====== DB ======
let db = { allowed: {}, credits: {} };

async function loadDB() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    db = JSON.parse(raw);
  } catch {
    db = { allowed: {}, credits: {} };
    for (const id of ALLOWED_IDS) db.allowed[id] = true;
    await saveDB();
  }
}
async function saveDB() {
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}
await loadDB();

function isAdmin(ctx) {
  return String(ctx.chat?.id) === ADMIN_ID;
}
function isAllowed(ctx) {
  return db.allowed?.[String(ctx.chat?.id)] === true;
}
function getCredits(id) {
  return Number(db.credits?.[String(id)] || 0);
}
async function addCredits(id, n) {
  db.credits[String(id)] = getCredits(id) + n;
  await saveDB();
}
async function consumeCredits(id, cost) {
  const cur = getCredits(id);
  if (cur < cost) return false;
  db.credits[String(id)] = cur - cost;
  await saveDB();
  return true;
}

// ====== PDF FALLBACK ======
function safe(v) {
  if (!v) return "";
  return String(v);
}

function pickBase64(body) {
  return (
    body?.data?.base64_semanas_cotizadas_nss ||
    body?.data?.base64_historial_laboral ||
    body?.data?.base64_pdf ||
    ""
  );
}

async function createFallbackPdf(body) {
  const ocr = body?.data?.ocr?.datos || {};
  const empleos = body?.data?.empleos || [];

  const doc = new PDFDocument({ margin: 40 });
  const chunks = [];
  doc.on("data", (c) => chunks.push(c));
  const done = new Promise((res) => doc.on("end", res));

  doc.fontSize(16).text("Resultado NUFI", { underline: true });
  doc.moveDown();
  doc.fontSize(11);
  doc.text(`Nombre: ${safe(ocr.nombre)}`);
  doc.text(`CURP: ${safe(ocr.curp)}`);
  doc.text(`NSS: ${safe(ocr.nss)}`);
  doc.text(`Fecha emisión: ${safe(ocr.fecha_emision)}`);
  doc.text(`Semanas cotizadas: ${safe(ocr.semanas_cotizadas)}`);
  doc.moveDown();

  doc.fontSize(13).text("Empleos", { underline: true });
  doc.moveDown(0.5);

  empleos.forEach((e, i) => {
    doc.fontSize(11).text(`${i + 1}) ${safe(e.patron)}`);
    doc.text(`Registro: ${safe(e.registro_patronal)}`);
    doc.text(`Entidad: ${safe(e.entidad_federativa)}`);
    doc.text(`Alta: ${safe(e.fecha_alta)}  Baja: ${safe(e.fecha_baja)}`);
    doc.text(`Salario: ${safe(e.salario_base)}`);
    doc.moveDown();
  });

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

// ====== WEBHOOK ======
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    const uuid =
      body?.data?.UUID ||
      body?.data?.uuid ||
      body?.data?.id ||
      body?.uuid;

    const chatId = pendingByUuid.get(uuid) || ALLOWED_IDS[0];

    // Enviar JSON
    await bot.telegram.sendMessage(
      chatId,
      "✅ Resultado recibido:\n\n```json\n" +
        JSON.stringify(body, null, 2).slice(0, 3500) +
        "\n```",
      { parse_mode: "Markdown" }
    );

    const base64 = pickBase64(body);

    if (base64 && base64.length > 200) {
      const buffer = Buffer.from(base64, "base64");
      await bot.telegram.sendDocument(chatId, {
        source: buffer,
        filename: "Constancia_Semanas_Cotizadas.pdf",
      });
    } else {
      const fallback = await createFallbackPdf(body);
      await bot.telegram.sendDocument(chatId, {
        source: fallback,
        filename: "NUFI_resultado_generado.pdf",
      });
      await bot.telegram.sendMessage(
        chatId,
        "⚠️ NUFI no envió PDF en base64. Se generó uno automáticamente."
      );
    }

    pendingByUuid.delete(uuid);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ====== TELEGRAM ======
bot.command("historial", async (ctx) => {
  const chatId = String(ctx.chat.id);
  if (!isAllowed(ctx)) return ctx.reply("⛔ Acceso denegado.");

  if (!isAdmin(ctx)) {
    const ok = await consumeCredits(chatId, COST_PER_HISTORIAL);
    if (!ok)
      return ctx.reply(
        `⛔ Sin créditos.\nTienes: ${getCredits(chatId)}`
      );
  }

  const parts = ctx.message.text.split(" ");
  const curp = parts[1];
  const nss = parts[2];
  if (!curp || !nss)
    return ctx.reply("Uso: /historial CURP NSS");

  await ctx.reply("⏳ Enviando consulta...");

  const resp = await fetch(
    "https://nufi.azure-api.net/numero_seguridad_social/v2/consultar_historial",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "NUFI-API-KEY": NUFI_API_KEY,
      },
      body: JSON.stringify({
        curp,
        nss,
        webhook: PUBLIC_WEBHOOK,
      }),
    }
  );

  const data = await resp.json();
  const uuid =
    data?.data?.UUID ||
    data?.data?.uuid ||
    data?.UUID;

  if (!resp.ok || !uuid)
    return ctx.reply("❌ Error NUFI.");

  pendingByUuid.set(uuid, chatId);
  await ctx.reply("✅ Solicitud enviada.\nUUID:\n" + uuid);
});

// ====== START ======
app.listen(PORT, () =>
  console.log(`Servidor en puerto ${PORT}`)
);
bot.launch();