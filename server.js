import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(bodyParser.json());

const store = new Map(); // phone -> {payload, ts}
const HOLD_SECONDS = 5400; // 90 min

function cleanup() {
  const cutoff = Date.now() - HOLD_SECONDS * 1000;
  for (const [k, v] of store.entries()) if (v.ts < cutoff) store.delete(k);
}
setInterval(cleanup, 10 * 60 * 1000); // every 10 min

// Route 1 — click collector
app.post("/click", (req, res) => {
  const payload = req.body || {};
  const key = payload.displayed_number?.replace(/\D+/g, "");
  if (!key) return res.status(400).send("missing displayed_number");
  store.set(key, { payload, ts: Date.now() });
  res.json({ ok: true });
});

// Route 2 — exotel receiver
app.post("/exotel", async (req, res) => {
  const call = req.body || {};
  const digits = (call.CalledNumber || call.called_number || "").replace(/\D+/g, "");
  const match = store.get(digits);
  if (!match) return res.status(404).send("no match");

  const merged = { ...match.payload, exotel: call };
  try {
    await fetch(process.env.GHL_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(merged)
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).send("forward error");
  }
});

// health
app.get("/", (_, res) => res.send("DNI relay alive"));
app.listen(process.env.PORT || 8080);
