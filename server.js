import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

const app = express();
app.use(bodyParser.json({ limit: "1mb" }));

const HOLD_SECONDS = parseInt(process.env.HOLD_SECONDS || "5400", 10);
const RELAY_SECRET = process.env.RELAY_SECRET || "";
const GHL_WEBHOOK = process.env.GHL_WEBHOOK;

const DATA_FILE = "./data.json";
let store = new Map();
function loadStore(){ try{ if(fs.existsSync(DATA_FILE)){ store=new Map(JSON.parse(fs.readFileSync(DATA_FILE,"utf8"))); } }catch(e){ console.error(e); } }
function saveStore(){ try{ fs.writeFileSync(DATA_FILE, JSON.stringify([...store.entries()])); }catch(e){ console.error(e); } }
loadStore();

function cleanup(){ const cutoff=Date.now()-HOLD_SECONDS*1000; let changed=false; for(const [k,v] of store.entries()){ if((v?.ts||0)<cutoff){ store.delete(k); changed=true; } } if(changed) saveStore(); }
setInterval(cleanup, 10*60*1000);

const digits = s => (s||"").toString().replace(/\D+/g,"");
const requireSecret = (req,res,next)=>{ if(!RELAY_SECRET) return next(); if(req.headers["x-relay-secret"]===RELAY_SECRET) return next(); res.status(401).json({ok:false,error:"unauthorized"}); };

app.get("/", (_,res)=>res.send("DNI relay alive"));

app.post("/click", requireSecret, (req,res)=>{
  const key = digits(req.body?.displayed_number);
  if(!key) return res.status(400).send("missing displayed_number");
  store.set(key, { payload:req.body||{}, ts:Date.now() });
  saveStore();
  res.json({ ok:true });
});

app.post("/exotel", requireSecret, async (req,res)=>{
  const called = digits(req.body?.CalledNumber || req.body?.called_number || req.body?.To || req.body?.to);
  if(!called) return res.status(400).send("missing called number");
  const match = store.get(called);
  if(!match) return res.status(404).send("no match");
  if(!GHL_WEBHOOK) return res.status(500).send("GHL_WEBHOOK missing");
  const merged = { ...match.payload, exotel:req.body, matched_number:called, matched_at:new Date().toISOString() };
  try{
    const r = await fetch(GHL_WEBHOOK,{ method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(merged) });
    const body = await r.text();
    res.status(r.ok?200:502).json({ ok:r.ok, forward_status:r.status, forward_body:body.slice(0,500) });
  }catch(e){ console.error(e); res.status(500).send("forward error"); }
});

app.listen(process.env.PORT||8080, ()=>console.log("DNI relay listening"));
