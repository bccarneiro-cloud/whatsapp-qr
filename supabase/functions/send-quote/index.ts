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
  draw("Orçamento", bold, 16);
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
    from: FROM_EMA_
