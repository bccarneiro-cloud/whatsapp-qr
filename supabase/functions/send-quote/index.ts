// Supabase Edge Function (Deno)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { PDFDocument, StandardFonts } from "https://esm.sh/pdf-lib@1.17.1";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL")!; // ex: "Little Things <orcamentos@littlethings.events>"

function fmtDate(dateStr?: string | null) {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("pt-PT");
}

async function makePdf(payload: any) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]); // A4
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let y = 790;
  const left = 50;

  const draw = (text: string, f = font, size = 12) => {
    page.drawText(text, { x: left, y, size, font: f });
    y -= size + 8;
  };

  draw("LITTLE THINGS", bold, 20);
  draw("Orçamento", bold, 16);
  y -= 6;

  draw(`Cliente: ${payload.customer_name ?? "—"}`, font, 12);
  draw(`Email: ${payload.customer_email ?? "—"}`, font, 12);
  draw(`Tipo de evento: ${payload.event_type}`, font, 12);
  draw(`Data do evento: ${fmtDate(payload.event_date)}`, font, 12);
  draw(`Local: ${payload.location ?? "—"}`, font, 12);
  draw(`Convidados: ${payload.guests ?? "—"}`, font, 12);

  y -= 10;
  draw("Detalhes:", bold, 12);
  const details = (payload.details ?? "—").toString();
  // simples wrap
  const maxChars = 85;
  for (let i = 0; i < details.length; i += maxChars) {
    draw(details.slice(i, i + maxChars), font, 11);
  }

  y -= 10;
  draw(`Preço final: ${Number(payload.final_price).toFixed(2)} €`, bold, 14);

  if (payload.admin_notes) {
    y -= 8;
    draw("Condições/Notas:", bold, 12);
    const notes = payload.admin_notes.toString();
    for (let i = 0; i < notes.length; i += maxChars) {
      draw(notes.slice(i, i + maxChars), font, 11);
    }
  }

  y -= 14;
  draw("Obrigada! ✨", bold, 12);

  const bytes = await pdf.save();
  return bytes;
}

async function sendEmailWithResend(to: string, subject: string, html: string, pdfBytes: Uint8Array) {
  const pdfBase64 = btoa(String.fromCharCode(...pdfBytes));
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      subject,
      html,
      attachments: [
        {
          filename: "orcamento-littlethings.pdf",
          content: pdfBase64,
        },
      ],
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend error: ${t}`);
  }
}

Deno.serve(async (req) => {
  try {
    const { quote_request_id } = await req.json();

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Buscar pedido
    const { data: qr, error: qrErr } = await supabase
      .from("quote_requests")
      .select("id, user_id, event_type, event_date, location, guests, details, final_price, admin_notes, status")
      .eq("id", quote_request_id)
      .single();

    if (qrErr) throw new Error(qrErr.message);
    if (!qr.final_price) throw new Error("final_price em falta.");

    // Buscar email do utilizador (auth)
    const { data: userData, error: userErr } = await supabase.auth.admin.getUserById(qr.user_id);
    if (userErr) throw new Error(userErr.message);

    const customer_email = userData.user.email!;
    // Buscar perfil p/ nome/telefone (opcional)
    const { data: prof } = await supabase.from("profiles").select("name, phone").eq("id", qr.user_id).single();

    const payload = {
      ...qr,
      customer_email,
      customer_name: prof?.name ?? null
    };

    const pdfBytes = await makePdf(payload);

    const subject = `Orçamento — ${qr.event_type}`;
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.45">
        <p>Olá${payload.customer_name ? " " + payload.customer_name : ""}, 😊</p>
        <p>Segue em anexo o teu orçamento para <b>${qr.event_type}</b>.</p>
        <p><b>Preço final:</b> ${Number(qr.final_price).toFixed(2)} €</p>
        ${qr.admin_notes ? `<p><b>Notas:</b> ${qr.admin_notes}</p>` : ""}
        <p>Obrigada!<br/>Little Things ✨</p>
      </div>
    `;

    await sendEmailWithResend(customer_email, subject, html, pdfBytes);

    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e.message ?? e) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
});
