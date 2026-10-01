// =============================================================================
// Eluneya — e-mailmelding bij een nieuwe online afspraak (OPTIONEEL)
//
// Zonder deze functie komen boekingen gewoon in Supabase (Table Editor → bookings),
// maar krijgt Aida geen melding. Met deze functie ontvangt Aida bij elke nieuwe
// afspraak een e-mail, en krijgt de klant een bevestiging.
//
// Installatie (eenmalig):
//   1. Maak een gratis account op https://resend.com en verifieer het domein
//      waarvan je mailt (bv. eluneya.be).
//   2. Supabase-dashboard → Edge Functions → Deploy new function → naam
//      "booking-notify" → plak deze code.
//   3. Edge Functions → Secrets, voeg toe:
//        RESEND_API_KEY   = re_...
//        NOTIFY_TO        = e-mailadres van Aida
//        MAIL_FROM        = bv. "Eluneya <afspraken@eluneya.be>"   (geverifieerd domein)
//        WEBHOOK_SECRET   = een lange willekeurige tekst
//        SEND_CLIENT_COPY = "true" of "false"
//   4. Database → Webhooks → Create: tabel public.bookings, event INSERT,
//      type "Supabase Edge Functions" → booking-notify, en voeg een HTTP-header
//      toe:  x-webhook-secret = (dezelfde waarde als WEBHOOK_SECRET).
// =============================================================================

type Booking = {
  id: string;
  service_name: string;
  price_eur: number;
  booking_date: string;   // YYYY-MM-DD
  start_time: string;     // HH:MM:SS
  end_time: string;
  client_name: string;
  client_email: string;
  client_phone: string | null;
  notes: string | null;
};

const env = (k: string) => Deno.env.get(k) ?? "";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

function when(b: Booking) {
  const [y, m, d] = b.booking_date.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("nl-BE", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
  return `${date} om ${b.start_time.slice(0, 5)} (tot ${b.end_time.slice(0, 5)})`;
}

async function send(to: string, subject: string, html: string, replyTo?: string) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("MAIL_FROM"), to: [to], subject, html, reply_to: replyTo }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env("WEBHOOK_SECRET") || req.headers.get("x-webhook-secret") !== env("WEBHOOK_SECRET")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const payload = await req.json().catch(() => null);
  const b: Booking | undefined = payload?.record;
  if (payload?.type !== "INSERT" || !b) return new Response("Ignored", { status: 200 });

  const moment = when(b);
  const rows = [
    ["Behandeling", b.service_name],
    ["Wanneer", moment],
    ["Naam", b.client_name],
    ["E-mail", b.client_email],
    ["Telefoon", b.client_phone ?? "—"],
    ["Opmerking", b.notes ?? "—"],
  ].map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#6e655b">${k}</td><td>${esc(String(v))}</td></tr>`).join("");

  try {
    await send(env("NOTIFY_TO"), `Nieuwe afspraak: ${b.service_name} — ${moment}`,
      `<p>Er is een nieuwe online afspraak:</p><table>${rows}</table>`, b.client_email);

    if (env("SEND_CLIENT_COPY") === "true") {
      await send(b.client_email, "Je afspraak bij Eluneya",
        `<p>Dag ${esc(b.client_name)},</p>
         <p>Je afspraak is ingepland: <strong>${esc(b.service_name)}</strong> op ${esc(moment)}.</p>
         <p>Adres: Jan Breydelstraat 1, 8560 Wevelgem.</p>
         <p>Iets wijzigen? Stuur gerust een bericht via WhatsApp.</p>
         <p>Tot dan,<br>Aida — Eluneya</p>`, env("NOTIFY_TO"));
    }
  } catch (e) {
    console.error(e);
    return new Response("Mail failed", { status: 500 });
  }
  return new Response("OK", { status: 200 });
});
