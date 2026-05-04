// =============================================================================
// CARUSO'S CONSTRUCTION — BACKEND SERVICE
// =============================================================================
// One small Node.js/Express service that does three things:
//
//   1. POST /extract-plans  — Architectural PDF → structured JSON via Claude vision.
//                             Used by the internal job cost calculator when staff
//                             upload plan sets.
//
//   2. POST /lead            — Public estimator (homeowner-facing) submits a lead.
//                             Forwards to email + Google Sheet + memory store.
//
//   3. GET  /leads           — Internal app fetches recent leads (token-protected).
//
//   4. GET  /health          — Liveness check, also useful for connecting the
//                             frontend (returns endpoints + delivery config status).
//
// REQUIRED ENV VARS
//   ANTHROPIC_API_KEY        — Anthropic API key (sk-ant-api03-...)
//   ALLOWED_ORIGIN           — Comma-separated CORS origins, or "*" for any.
//
// OPTIONAL ENV VARS — pick whichever lead-delivery channels you want
//   RESEND_API_KEY           — Resend.com API key (sends each lead as an email)
//   LEAD_EMAIL_TO            — Email recipient (default: office@carusos.construction)
//   LEAD_EMAIL_FROM          — Verified sender email in your Resend account
//   GOOGLE_SHEET_WEBHOOK     — Google Apps Script web app URL (appends to sheet)
//   LEADS_API_TOKEN          — Required Bearer token to call GET /leads
//
// SYSTEM DEPS
//   poppler-utils (pdftoppm, pdfinfo) — already installed by the included Dockerfile
//
// DEPLOY
//   Easiest: Railway. See README.md in this folder.
// =============================================================================

import express from "express";
import multer from "multer";
import cors from "cors";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

const app = express();
const PORT = process.env.PORT || 3001;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const LEAD_EMAIL_TO = process.env.LEAD_EMAIL_TO || "office@carusos.construction";
const LEAD_EMAIL_FROM = process.env.LEAD_EMAIL_FROM;
const GOOGLE_SHEET_WEBHOOK = process.env.GOOGLE_SHEET_WEBHOOK;
const LEADS_API_TOKEN = process.env.LEADS_API_TOKEN;

if (!ANTHROPIC_API_KEY) {
  console.error("FATAL: ANTHROPIC_API_KEY environment variable is not set.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ----- Middleware -----
app.use(cors({
  origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN.split(",").map(s => s.trim()),
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json({ limit: "1mb" }));

// PDF upload — held in memory, max 200MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
});

// In-memory recent leads store (resets on container restart).
// Email + Google Sheet are the durable record. This is just for the
// internal app to display recent leads conveniently.
const recentLeads = [];
const MAX_RECENT_LEADS = 200;

// =============================================================================
// /health
// =============================================================================
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "carusos-backend",
    model: "claude-opus-4-7",
    endpoints: ["/health", "/extract-plans", "/lead", "/leads"],
    leadDelivery: {
      email: !!RESEND_API_KEY && !!LEAD_EMAIL_FROM,
      googleSheet: !!GOOGLE_SHEET_WEBHOOK,
      memory: true,
    },
    timestamp: new Date().toISOString(),
  });
});

// =============================================================================
// /extract-plans — main extraction endpoint
// =============================================================================
app.post("/extract-plans", upload.single("plans"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded. Send the PDF as multipart/form-data field 'plans'." });
  }

  const reqId = randomUUID().slice(0, 8);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `plans-${reqId}-`));
  const pdfPath = path.join(tmpDir, "plans.pdf");

  console.log(`[${reqId}] Extraction request: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

  try {
    fs.writeFileSync(pdfPath, req.file.buffer);

    // Page count
    let pageCount;
    try {
      const info = execSync(`pdfinfo "${pdfPath}"`, { encoding: "utf8" });
      const m = info.match(/Pages:\s+(\d+)/);
      pageCount = m ? parseInt(m[1], 10) : 0;
    } catch (e) {
      throw new Error(`pdfinfo failed — is poppler-utils installed? ${e.message}`);
    }
    if (pageCount === 0) throw new Error("PDF has no pages or could not be read");

    console.log(`[${reqId}] PDF has ${pageCount} pages`);

    // Sample ~15 representative pages spread across the document.
    const samplePages = pickSamplePages(pageCount, 15);
    console.log(`[${reqId}] Sampling pages: ${samplePages.join(", ")}`);

    // Rasterize each sample page to PNG at 100 DPI
    const pageImages = [];
    for (const pageNum of samplePages) {
      const outPrefix = path.join(tmpDir, `page-${pageNum}`);
      try {
        execSync(
          `pdftoppm -f ${pageNum} -l ${pageNum} -r 100 -png "${pdfPath}" "${outPrefix}"`,
          { stdio: "pipe" }
        );
        const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(`page-${pageNum}-`) && f.endsWith(".png"));
        if (files.length === 0) {
          console.warn(`[${reqId}] No PNG generated for page ${pageNum}`);
          continue;
        }
        const imgPath = path.join(tmpDir, files[0]);
        const imgData = fs.readFileSync(imgPath).toString("base64");
        pageImages.push({ page: pageNum, base64: imgData });
      } catch (e) {
        console.warn(`[${reqId}] Failed to rasterize page ${pageNum}: ${e.message}`);
      }
    }

    if (pageImages.length === 0) throw new Error("Could not rasterize any pages from this PDF");
    console.log(`[${reqId}] Rasterized ${pageImages.length} pages, calling Claude...`);

    const content = [
      {
        type: "text",
        text: EXTRACTION_PROMPT.replace("{{PAGE_LIST}}", samplePages.join(", ")).replace("{{TOTAL_PAGES}}", String(pageCount)),
      },
      ...pageImages.map(img => ({
        type: "image",
        source: { type: "base64", media_type: "image/png", data: img.base64 },
      })),
    ];

    const response = await anthropic.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 8000,
      messages: [{ role: "user", content }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/) || text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[${reqId}] Could not parse JSON from Claude. First 500 chars:`, text.slice(0, 500));
      throw new Error("Claude did not return valid JSON. Check server logs.");
    }
    const jsonText = jsonMatch[1] || jsonMatch[0];
    let extracted;
    try {
      extracted = JSON.parse(jsonText);
    } catch (e) {
      throw new Error(`Could not parse JSON from Claude: ${e.message}`);
    }

    extracted._meta = {
      extracted_from: req.file.originalname,
      extraction_date: new Date().toISOString().slice(0, 10),
      pages_analyzed: samplePages,
      total_pages: pageCount,
      tokens_used: response.usage,
      request_id: reqId,
    };

    console.log(`[${reqId}] Extraction OK. Tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out.`);
    res.json(extracted);

  } catch (e) {
    console.error(`[${reqId}] Extraction failed:`, e);
    res.status(500).json({ error: e.message, request_id: reqId });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// =============================================================================
// /lead — public estimator submits a lead
// Body: {
//   name, email, phone, message,
//   projectType, livableSF, bedrooms, bathrooms, hasGarage,
//   hasArchitect, finishTier, finishTierLabel,
//   estimateLow, estimateMid, estimateHigh,
// }
// =============================================================================
app.post("/lead", async (req, res) => {
  const lead = req.body || {};
  const reqId = randomUUID().slice(0, 8);

  if (!lead.name || !lead.email || !lead.phone) {
    return res.status(400).json({ error: "name, email, and phone are required" });
  }

  const enriched = {
    ...lead,
    id: reqId,
    receivedAt: new Date().toISOString(),
    sourceIP: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"] || "unknown",
  };

  console.log(`[${reqId}] New lead from ${enriched.email}: ${enriched.projectType || "unknown project"}`);

  recentLeads.unshift(enriched);
  if (recentLeads.length > MAX_RECENT_LEADS) recentLeads.length = MAX_RECENT_LEADS;

  // Fan out to email + sheet — don't fail the request if either fails
  const [emailResult, sheetResult] = await Promise.allSettled([
    sendLeadEmail(enriched),
    sendLeadToGoogleSheet(enriched),
  ]);

  res.json({
    ok: true,
    leadId: reqId,
    delivery: {
      email: emailResult.status === "fulfilled" ? emailResult.value : { error: emailResult.reason?.message || "failed" },
      googleSheet: sheetResult.status === "fulfilled" ? sheetResult.value : { error: sheetResult.reason?.message || "failed" },
    },
  });
});

// =============================================================================
// /leads — internal app fetches recent leads
// =============================================================================
app.get("/leads", (req, res) => {
  if (LEADS_API_TOKEN) {
    const auth = req.headers.authorization || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== LEADS_API_TOKEN) {
      return res.status(401).json({ error: "Unauthorized. Set Authorization: Bearer <token> header." });
    }
  }
  res.json({
    leads: recentLeads,
    count: recentLeads.length,
    note: "In-memory store. Permanent records are in your email and Google Sheet.",
  });
});

// =============================================================================
// HELPERS
// =============================================================================

async function sendLeadEmail(lead) {
  if (!RESEND_API_KEY) return { skipped: "RESEND_API_KEY not configured" };
  if (!LEAD_EMAIL_FROM) return { skipped: "LEAD_EMAIL_FROM not configured" };

  const subject = `New Lead — ${lead.name} — ${lead.projectType || "Project"}`;
  const html = buildLeadEmailHTML(lead);

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: LEAD_EMAIL_FROM,
      to: [LEAD_EMAIL_TO],
      reply_to: lead.email,
      subject,
      html,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Resend ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { sent: true, messageId: data.id };
}

async function sendLeadToGoogleSheet(lead) {
  if (!GOOGLE_SHEET_WEBHOOK) return { skipped: "GOOGLE_SHEET_WEBHOOK not configured" };

  const resp = await fetch(GOOGLE_SHEET_WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lead),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google Sheet webhook ${resp.status}: ${errText.slice(0, 200)}`);
  }
  return { appended: true };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function buildLeadEmailHTML(lead) {
  const fmtMoney = n => (typeof n === "number" ? "$" + Math.round(n).toLocaleString() : "—");
  const projectTypeLabels = {
    new_construction: "Build a New Home",
    whole_home: "Whole Home Remodel",
    adu: "ADU / Addition",
    kitchen: "Kitchen Remodel",
    bathroom: "Bathroom Remodel",
  };
  const projType = projectTypeLabels[lead.projectType] || lead.projectType || "Unknown";

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;max-width:600px;margin:0 auto">
  <div style="background:#1c1917;color:white;padding:20px;border-bottom:4px solid #ea580c">
    <h1 style="margin:0;font-size:22px;font-weight:600">New Lead — Caruso's Public Estimator</h1>
    <p style="margin:6px 0 0 0;color:#d6d3d1;font-size:12px">Submitted ${new Date(lead.receivedAt).toLocaleString("en-US",{timeZone:"America/Los_Angeles"})} PT</p>
  </div>

  <div style="background:#fafaf9;padding:20px">
    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;margin:0 0 10px 0">Contact Information</h2>
    <table style="width:100%;font-size:15px;border-collapse:collapse">
      <tr><td style="padding:5px 0;color:#57534e;width:120px">Name:</td><td><strong>${escapeHtml(lead.name)}</strong></td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Email:</td><td><a href="mailto:${escapeHtml(lead.email)}" style="color:#ea580c">${escapeHtml(lead.email)}</a></td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Phone:</td><td><a href="tel:${escapeHtml(lead.phone)}" style="color:#ea580c">${escapeHtml(lead.phone)}</a></td></tr>
    </table>
  </div>

  <div style="background:white;padding:20px;border-top:1px solid #e7e5e4">
    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;margin:0 0 10px 0">Project Details</h2>
    <table style="width:100%;font-size:15px;border-collapse:collapse">
      <tr><td style="padding:5px 0;color:#57534e;width:160px">Project Type:</td><td><strong>${escapeHtml(projType)}</strong></td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Square Footage:</td><td>${(lead.livableSF || 0).toLocaleString()} sf</td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Bedrooms:</td><td>${lead.bedrooms ?? "—"}</td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Bathrooms:</td><td>${lead.bathrooms ?? "—"}</td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Garage:</td><td>${lead.hasGarage ? "Yes" : "No"}</td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Architect:</td><td><strong>${escapeHtml(lead.hasArchitect || "—")}</strong></td></tr>
      <tr><td style="padding:5px 0;color:#57534e">Finish Tier:</td><td>Tier ${lead.finishTier || "?"} — ${escapeHtml(lead.finishTierLabel || "")}</td></tr>
    </table>
  </div>

  <div style="background:#fef3c7;padding:20px;border-top:1px solid #fde68a">
    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#92400e;margin:0 0 8px 0">Their Estimate</h2>
    <p style="font-size:28px;font-weight:700;margin:0;color:#92400e">${fmtMoney(lead.estimateLow)} – ${fmtMoney(lead.estimateHigh)}</p>
    <p style="font-size:11px;color:#78716c;margin:6px 0 0 0">Mid-range: ${fmtMoney(lead.estimateMid)}</p>
  </div>

  ${lead.message ? `
  <div style="background:white;padding:20px;border-top:1px solid #e7e5e4">
    <h2 style="font-size:14px;text-transform:uppercase;letter-spacing:0.05em;color:#78716c;margin:0 0 10px 0">Their Message</h2>
    <p style="font-size:15px;line-height:1.5;margin:0;white-space:pre-wrap">${escapeHtml(lead.message)}</p>
  </div>` : ""}

  <div style="background:#1c1917;color:#a8a29e;padding:14px;font-size:11px;text-align:center;font-family:monospace">
    Lead ID: ${lead.id} · IP: ${escapeHtml(lead.sourceIP)}
  </div>
</div>`;
}

function pickSamplePages(totalPages, maxSamples) {
  if (totalPages <= maxSamples) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const samples = new Set([1]);
  const step = Math.max(1, Math.floor(totalPages / (maxSamples - 1)));
  for (let i = step; i < totalPages && samples.size < maxSamples; i += step) samples.add(i);
  if (samples.size < maxSamples) samples.add(totalPages);
  return Array.from(samples).sort((a, b) => a - b);
}

// =============================================================================
// EXTRACTION PROMPT
// =============================================================================
const EXTRACTION_PROMPT = `You are an expert construction estimator analyzing architectural plans for Caruso's Construction Inc., a residential general contractor in Pacific Palisades, California.

I am sending you {{TOTAL_PAGES}} pages of an architectural plan set. To save tokens, I have selected {{PAGE_LIST}} representative pages spread across the document.

Analyze the pages and extract the following information into a single JSON object. Be precise — count fixtures and rooms by inspecting the floor plans carefully. If a value cannot be determined from the visible pages, use \`null\` (do not guess).

Return ONLY a JSON object in this exact shape (wrapped in \`\`\`json code fences):

{
  "project": {
    "address": "street address",
    "city": "city",
    "state": "state",
    "zip": "zip",
    "apn": "assessor parcel number if visible",
    "lot_area_sf": <number or null>,
    "zoning": "zoning code if shown",
    "construction_type": "e.g. V-B",
    "fire_severity_zone": <true/false based on notes>,
    "height_limit_ft": <number or null>,
    "proposed_height": "string e.g. 27'-9\\"",
    "stories": <number>,
    "scope_summary": "1-3 sentence description of the project",
    "previous": "any notes about pre-existing structure or fire damage"
  },
  "team": {
    "owner": { "name": "owner name from titleblock", "contact": "contact person", "email": "if visible", "phone": "if visible" },
    "architect": { "firm": "name", "contact": "name", "email": "if visible", "phone": "if visible" },
    "structural": { "firm": "name", "contact": "name", "phone": "if visible" },
    "title24": { "firm": "name", "contact": "name", "phone": "if visible" },
    "mep": { "firm": "name", "contact": "name", "phone": "if visible" }
  },
  "areas": {
    "main_house_first_floor_sf": <number>,
    "main_house_second_floor_sf": <number>,
    "main_house_total_sf": <number>,
    "adu_sf": <number or null>,
    "adu_covered_porch_sf": <number or null>,
    "adu_covered_patio_sf": <number or null>,
    "total_livable_sf": <number — sum of all conditioned space>,
    "existing_garage_sf": <number or null>
  },
  "rooms_main_first_floor": [<list of room names>],
  "rooms_main_second_floor": [<list of room names>],
  "rooms_adu": [<list of room names or empty array>],
  "counts": {
    "bedrooms_main": <number>, "bathrooms_main": <number, may be e.g. 3.5>,
    "bedrooms_adu": <number>, "bathrooms_adu": <number>,
    "showers": <number>, "tubs": <number>, "toilets": <number>, "lavatories": <number>,
    "interior_doors": <number>, "exterior_doors": <number>, "windows": <number>,
    "kitchens": <number>, "laundry_rooms": <number>,
    "smoke_co_detectors": <number>, "exhaust_fans_bath": <number>, "exhaust_fans_whole_home": <number>,
    "hvac_units": <number>, "tankless_water_heaters": <number>,
    "appliances_total": <number — count items in the appliance schedule>,
    "fireplaces": <number>, "hose_bibs": <number>,
    "canned_lights": <number — count from electrical/lighting schedule>,
    "interior_sconces": <number>, "exterior_sconces": <number>,
    "ceiling_fans": <number>, "pendant_boxes": <number>, "exterior_soffit_lights": <number>
  },
  "linear": {
    "kitchen_lower_cabinets_lf": <number>, "kitchen_upper_cabinets_lf": <number>,
    "laundry_uppers_lf": <number>, "fireplace_surround_lf": <number>,
    "foyer_built_in_bench_lf": <number>, "vanity_total_lf": <number>,
    "closet_total_lf": <number>, "exterior_balcony_guardrail_lf": <number>,
    "exterior_stair_guardrail_lf": <number>, "interior_stair_handrail_lf": <number>,
    "interior_stair_guardrail_lf": <number>, "led_cabinet_lighting_lf": <number>,
    "temp_fencing_lf": <number>, "baseboards_lf": <number>
  },
  "areas_calculated": {
    "stucco_sf": <number>, "siding_sf": <number>, "drywall_wall_sf": <number>,
    "roof_flat_sf": <number>, "roof_above_garage_sf": <number or 0>,
    "trex_decking_sf": <number>, "balcony_dexotex_sf": <number>,
    "engineered_hardwood_install_sf": <number>, "tile_install_sf": <number>,
    "garage_epoxy_sf": <number>, "insulation_sf": <number>,
    "countertop_sf": <number — kitchen + all bath vanities>
  },
  "structural": {
    "drilled_piles": <number>, "drilled_piles_diameter_in": <number>,
    "steel_strong_walls": <number>, "steel_strong_wall_model": "e.g. Simpson SSW24x10",
    "geotech": "geotech report reference if cited"
  },
  "deferred_submittals": [<list of deferred submittal items>]
}

CRITICAL:
- Be conservative with counts you cannot verify — use null rather than guessing.
- For areas, prefer values printed directly on the plans over calculated estimates.
- The total_livable_sf field is the most important — if you cannot determine it precisely, calculate it as the sum of conditioned floor areas you CAN see.
- Do NOT include any explanatory text outside the JSON object. The frontend parses JSON only.`;

// =============================================================================
// START
// =============================================================================
app.listen(PORT, () => {
  console.log(`Caruso's backend listening on port ${PORT}`);
  console.log(`Endpoints: /health, /extract-plans, /lead, /leads`);
  console.log(`CORS origin(s): ${ALLOWED_ORIGIN}`);
  console.log(`Lead email delivery: ${RESEND_API_KEY && LEAD_EMAIL_FROM ? "ENABLED" : "disabled (set RESEND_API_KEY + LEAD_EMAIL_FROM)"}`);
  console.log(`Lead Google Sheet delivery: ${GOOGLE_SHEET_WEBHOOK ? "ENABLED" : "disabled (set GOOGLE_SHEET_WEBHOOK)"}`);
  console.log(`/leads token-protected: ${LEADS_API_TOKEN ? "yes" : "NO — set LEADS_API_TOKEN"}`);
});
