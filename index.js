/**
 * SISEC 2.0 — Producción con Webhook real
 * Node 18+
 * package.json debe tener:  "type": "module"
 */

import "dotenv/config";
import express from "express";
import { Telegraf } from "telegraf";
import { readFile, writeFile } from "fs/promises";
import PDFDocument from "pdfkit";

// ================= ENV =================
const {
  BOT_TOKEN,
  NUFI_API_KEY,
  PUBLIC_BASE_URL,
  WEBHOOK_SECRET,
  ADMIN_ID,
  PORT = 10000,
  DATA_FILE = "./data.json",
  COST_PER_HISTORIAL = 1,
} = process.env;

if (!BOT_TOKEN) throw new Error("Falta BOT_TOKEN");
if (!NUFI_API_KEY) throw new Error("Falta NUFI_API_KEY");
if (!PUBLIC_BASE_URL) throw new Error("Falta PUBLIC_BASE_URL");
if (!WEBHOOK_SECRET) throw new Error("Falta WEBHOOK_SECRET");
if (!ADMIN_ID) throw new Error("Falta ADMIN_ID");

// ================= APP =================
const app = express();
app.use(express.json({ limit: "10mb" }));

const bot = new Telegraf(BOT_TOKEN);

const TELEGRAM_PATH = `/telegram/${WEBHOOK_SECRET}`;
const NUFI_PATH = `/webhook/${WEBHOOK_SECRET}`;

const pendingByUuid = new Map();

// ================= DB =================
let db = { allowed: {}, credits: {} };

async function loadDB() {
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    db = JSON.parse(raw);
  } catch {
    db = { allowed: {}, credits: {} };
    await saveDB();
  }
}
async function saveDB() {
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2));
}

function isAdmin(ctx) {
  return String(ctx.chat.id) === String(ADMIN_ID);
}
function isAllowed(ctx) {
  return db.allowed[String(ctx.chat.id)] === true;
}
function getCredits(id) {
  return Number(db.credits[String(id)] || 0);
}
async function addCredits(id, amount) {
  const cur = getCredits(id);
  db.credits[String(id)] = cur + Number(amount);
  await saveDB();
}
async function consumeCredits(id, cost) {
  const cur = getCredits(id);
  if (cur < cost) return false;
  db.credits[String(id)] = cur - cost;
  await saveDB();
  return true;
}

await loadDB();

// ================= TELEGRAM COMMANDS =================

bot.start((ctx) =>
  ctx.reply("🔐 SISEC 2.0 activo.\n\nUsa /historial CURP NSS")
);

bot.command("id", (ctx) =>
  ctx.reply("🆔 Tu ID:\n" + ctx.chat.id)
);

bot.command("grant", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("⛔ Solo admin");
  const id = ctx.message.text.split(" ")[1];
  db.allowed[id] = true;
  await saveDB();
  ctx.reply("✅ Autorizado: " + id);
});

bot.command("saldo", (ctx) => {
  if (!isAllowed(ctx)) return ctx.reply("⛔ Acceso denegado");
  ctx.reply("💳 Créditos: " + getCredits(ctx.chat.id));
});

bot.command("historial", async (ctx) => {
  try {
    if (!isAllowed(ctx)) return ctx.reply("⛔ Acceso denegado");

    if (!isAdmin(ctx)) {
      const ok = await consumeCredits(ctx.chat.id, COST_PER_HISTORIAL);
      if (!ok) return ctx.reply("⛔ Sin créditos");
    }

    const [, curp, nss] = ctx.message.text.split(" ");
    if (!curp || !nss)
      return ctx.reply("Uso: /historial CURP NSS");

    await ctx.reply("⏳ Enviando a NUFI...");

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
          webhook: `${PUBLIC_BASE_URL}${NUFI_PATH}`,
        }),
      }
    );

    const data = await resp.json();
    const uuid =
      data?.datos?.UUID ||
      data?.data?.uuid ||
      data?.uuid;

    if (!uuid) return ctx.reply("❌ NUFI no devolvió UUID");

    pendingByUuid.set(uuid, ctx.chat.id);

    ctx.reply("✅ Solicitud enviada.\nUUID:\n" + uuid);
  } catch (err) {
    console.error(err);
    ctx.reply("❌ Error interno");
  }
});

// ================= NUFI WEBHOOK =================
app.post(NUFI_PATH, async (req, res) => {
  try {
    const body = req.body;
    const uuid =
      body?.data?.uuid ||
      body?.uuid;

    const chatId = pendingByUuid.get(uuid);
    if (!chatId) return res.sendStatus(200);

    await bot.telegram.sendMessage(
      chatId,
      "✅ Resultado recibido:\n\n```json\n" +
        JSON.stringify(body, null, 2).slice(0, 3500) +
        "\n```",
      { parse_mode: "Markdown" }
    );

    const base64 =
      body?.data?.base64_semanas_cotizadas_nss ||
      body?.base64_pdf;

    if (base64 && base64.length > 100) {
      const buffer = Buffer.from(base64, "base64");
      await bot.telegram.sendDocument(chatId, {
        source: buffer,
        filename: "NUFI.pdf",
      });
    } else {
      // Generar PDF automático
      const doc = new PDFDocument();
      const chunks = [];
      doc.on("data", (c) => chunks.push(c));
      doc.on("end", async () => {
        const pdf = Buffer.concat(chunks);
        await bot.telegram.sendDocument(chatId, {
          source: pdf,
          filename: "NUFI_generado.pdf",
        });
      });
      doc.fontSize(14).text("SISEC 2.0 — Resultado NUFI");
      doc.moveDown();
      doc.text(JSON.stringify(body, null, 2));
      doc.end();
    }

    pendingByUuid.delete(uuid);
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ================= TELEGRAM WEBHOOK =================
app.use(bot.webhookCallback(TELEGRAM_PATH));

await bot.telegram.setWebhook(
  `${PUBLIC_BASE_URL}${TELEGRAM_PATH}`
);

console.log("✅ Telegram webhook configurado");

// ================= SERVER =================
app.listen(PORT, () => {
  console.log("🚀 Servidor activo en puerto " + PORT);
});