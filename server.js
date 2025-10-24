cat > server.js <<'JS'
import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

// --- Config ---
const HOLD_SECONDS = parseInt(process.env.HOLD_SECONDS || "5400", 10); // default 90m
const RELAY_SECRET = process.env.RELAY_SECRET || ""; // shared-secret (recommended)
const GHL_WEBHOOK = process.env.GHL_WEBHOOK;

// --- Simple persistence (data.json) ---
const DATA_FILE = "./data.json";
let store = new Map(); // phoneDigits -> { payload, ts }

function loadStore() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      store = new Map(raw.map(([k, v]) => [k, v]));
    }
  } catch (e) {
    console.error("Failed to load data.json:", e);
  }
}
function saveStore() {
  try {
    const arr = [...store.entries()];
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr));
  } catch (e) {
    console.error("Failed to save data.json:", e);
  }
}
loadStore();

function cleanup() {
  const cutoff = Date.now() - HOLD_SECONDS * 1000;
  let changed = false;
  for (const [k, v] of store.entries()) {
    if ((v?.ts || 0) < cutoff) { store.delete(k); changed = true; }
  }
  if (changed) saveStore();
}
setInterval(cleanup, 10 * 60 * 1000); // every 10 min

function digitsOnly(s = "") { return (s || "").toString().replace(/\D+/g, ""); }

// --- Optional auth middleware for inbound requests ---
function requireSecret(req, res, next) {
  if (!RELAY_SECRET) return next(); // not enforced if unset
  const got = req.headers["x-relay-secret"];
  if (got && got === RELAY_SECRET) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// Health
app.get("/", (_, res) => res.send("DNI relay alive"));

// Route 1 — click collector (from your site / GTM)
app.post("/click", requireSecret, (req, res) => {
  const payload = req.body || {};
  const key = digitsOnly(payload.displayed_number);
  if (!key) return res.status(400).send("missing displayed_number");
  store.set(key, { payload, ts: Date.now() });
  saveStore();
  res.json({ ok: true });
});

// Route 2 — Exotel receiver (configure Exotel to POST here)
app.post("/exotel", requireSecret, async (req, res) => {
  const call = req.body || {};
  const digits = digitsOnly(call.CalledNumber || call.called_number || call.To || call.to);
  if (!digits) return res.status(400).send("missing called number");

  const match = store.get(digits);
  if (!match) return res.status(404).send("no match");

  const merged = { ...match.payload, exotel: call, matched_number: digits, matched_at: new Date().toISOString() };
  if (!GHL_WEBHOOK) return res.status(500).send("GHL_WEBHOOK missing");

  try {
    const r = await fetch(GHL_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged)
    });
    const ok = r.ok;
    const text = await r.text();
    res.status(ok ? 200 : 502).json({ ok, forward_status: r.status, forward_body: text.slice(0, 500) });
  } catch (e) {
    console.error("forward error", e);
    res.status(500).send("forward error");
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`DNI relay listening on :${port}`));
JS
