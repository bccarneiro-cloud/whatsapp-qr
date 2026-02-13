// supabase/functions/send-quote/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL")!;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function fmtDate(dateStr?: string | null) {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("pt-PT");
  } catch {
    return String(dateStr);
  }
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function makePdf(payload: {
  customer_name?: string | null;
  customer_email?: string | null;
  event_type: string;
  event_date?: string | null;
  location?: string | null;
  guests?: number | null;
  details?: string | null;
  final_price: number;
  admin_notes?: string | null;
}) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let y = 790;
  const x = 50;

  const draw = (text: string, f = font, size = 12) => {
    page.drawText(text, { x, y, size, font: f });
    y -= size + 8;
  };

  draw("LITTLE THINGS", bold, 20);
  draw("Orcamento", bold, 16);
  y -= 6;

  draw(`Cliente: ${payload.customer_name ?? "—"}`, font, 12);
  draw(`Email: ${payload.customer_email ?? "—"}`, font, 12);
  draw(`Tipo de evento: ${payload.event_type}`, font, 12);
  draw(`Data do evento: ${fmtDate(payload.event_date ?? null)}`, font, 12);
  draw(`Local: ${payload.location ?? "—"}`, font, 12);
  draw(`Convidados: ${payload.guests ?? "—"}`, font, 12);

  y -= 10;
  draw("Detalhes:", bold, 12);

  const details = (payload.details ?? "—").toString();
  const maxChars = 90;
  for (let i = 0; i < details.length; i += maxChars) {
    draw(details.slice(i, i + maxChars), font, 11);
  }

  y -= 10;
  draw(`Preco final: ${Number(payload.final_price).toFixed(2)} EUR`, bold, 14);

  if (payload.admin_notes) {
    y -= 8;
    draw("Condicoes/Notas:", bold, 12);
    const notes = payload.admin_notes.toString();
    for (let i = 0; i < notes.length; i += maxChars) {
      draw(notes.slice(i, i + maxChars), font, 11);
    }
  }

  y -= 14;
  draw("Obrigada!", bold, 12);

  return await pdf.save();
}

async function sendEmailWithResend(
  to: string,
  subject: string,
  html: string,
  pdfBytes: Uint8Array
) {
  const pdfBase64 = toBase64(pdfBytes);

  const payload = {
    from: FROM_EMAIL,
    to: [to],
    subject,
    html,
    attachments: [
      { filename: "orcamento-littlethings.pdf", content: pdfBase64 },
    ],
  };

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();

  if (!res.ok) {
    console.error("RESEND_FAIL", res.status, text);
    throw new Error(`Resend error (${res.status}): ${text}`);
  }

  console.log("RESEND_OK", text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") {
      return new Response(JSON.stringify({ ok: false, error: "Use POST." }), {
        status: 405,
        headers: corsHeaders,
      });
    }

    // Manual auth (deploy com --no-verify-jwt)
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ ok: false, error: "Missing Bearer token." }), {
        status: 401,
        headers: corsHeaders,
      });
    }
    const token = authHeader.slice("Bearer ".length);

    const sbAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: u, error: uErr } = await sbAuth.auth.getUser();
    if (uErr || !u?.user) {
      return new Response(JSON.stringify({ ok: false, error: "Invalid session." }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const sbService = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: prof, error: pErr } = await sbService
      .from("profiles")
      .select("role")
      .eq("id", u.user.id)
      .single();

    if (pErr || prof?.role !== "admin") {
      return new Response(JSON.stringify({ ok: false, error: "Forbidden (admin only)." }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = await req.json().catch(() => ({}));
    const quote_request_id = body?.quote_request_id as string | undefined;

    if (!quote_request_id) {
      return new Response(JSON.stringify({ ok: false, error: "quote_request_id em falta." }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    const { data: qr, error: qrErr } = await sbService
      .from("quote_requests")
      .select("id, user_id, event_type, event_date, location, guests, details, final_price, admin_notes")
      .eq("id", quote_request_id)
      .single();

    if (qrErr) throw new Error(`DB quote_requests: ${qrErr.message}`);
    if (!qr) throw new Error("Pedido nao encontrado.");
    if (qr.final_price == null) throw new Error("final_price em falta.");

    const { data: userData, error: userErr } = await sbService.auth.admin.getUserById(qr.user_id);
    if (userErr) throw new Error(`Auth getUserById: ${userErr.message}`);

    const customer_email = userData.user?.email;
    if (!customer_email) throw new Error("Email do cliente nao encontrado.");

    const { data: custProf } = await sbService
      .from("profiles")
      .select("name")
      .eq("id", qr.user_id)
      .single();

    const payload = {
      customer_email,
      customer_name: custProf?.name ?? null,
      event_type: qr.event_type,
      event_date: qr.event_date ?? null,
      location: qr.location ?? null,
      guests: qr.guests ?? null,
      details: qr.details ?? null,
      final_price: Number(qr.final_price),
      admin_notes: qr.admin_notes ?? null,
    };

    const pdfBytes = await makePdf(payload);

    const subject = `Orcamento - ${qr.event_type}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.45">
        <p>Ola${payload.customer_name ? " " + payload.customer_name : ""},</p>
        <p>Segue em anexo o teu orcamento para <b>${qr.event_type}</b>.</p>
        <p><b>Preco final:</b> ${payload.final_price.toFixed(2)} EUR</p>
        ${payload.admin_notes ? `<p><b>Notas:</b> ${payload.admin_notes}</p>` : ""}
        <p>Obrigada!<br/>Little Things</p>
      </div>
    `;

    await sendEmailWithResend(customer_email, subject, html, pdfBytes);

    return new Response(JSON.stringify({ ok: true }), { headers: corsHeaders });
  } catch (e) {
    console.error("SEND_QUOTE_ERROR", e);
    return new Response(
      JSON.stringify({ ok: false, error: String((e as any)?.message ?? e) }),
      { status: 400, headers: corsHeaders }
    );
  }
});
