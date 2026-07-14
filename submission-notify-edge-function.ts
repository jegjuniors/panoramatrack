// PanoramaTrack — Submission notification Edge Function
//
// DEPLOY: Supabase Dashboard → Edge Functions → New Function → name it "submission-notify"
// → paste this entire file as the function body → Deploy.
//
// SECRET REQUIRED: add RESEND_API_KEY under this function's Secrets (or Project Settings →
// Edge Functions → Secrets, which applies to all functions). Never hardcode the key here —
// this file may end up in GitHub, secrets should not.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically into every Edge
// Function by Supabase — nothing to configure for those two.
//
// Called from app.js via sb.functions.invoke('submission-notify', { body: {...} }) after a
// supervisor successfully sends timecards to the office (never called for admin overrides).
// Expected request body:
//   {
//     supervisorName: string,
//     periodLabel: string,      // e.g. "Jul 7 – Jul 20, 2026"
//     items: [ { employeeName: string, jobsite: string }, ... ]
//   }
// One call = one email, whatever it contains (batch or single). Reads submit_notify_enabled
// and submit_notify_emails from pt_settings on every call, so toggling in the Settings screen
// takes effect immediately with no redeploy needed.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface NotifyItem { employeeName: string; jobsite: string; }
interface NotifyPayload { supervisorName?: string; periodLabel?: string; items?: NotifyItem[]; }
interface SettingsRow { submit_notify_enabled?: boolean; submit_notify_emails?: string; }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(s).replace(/[&<>"']/g, c => map[c]);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let payload: NotifyPayload;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, 400);
  }

  const items: NotifyItem[] = Array.isArray(payload.items)
    ? payload.items.filter(i => i && i.employeeName && i.jobsite)
    : [];
  if (!items.length) return json({ ok: true, sent: false, reason: 'No items in payload' });

  const supervisorName = payload.supervisorName || 'A supervisor';
  const periodLabel = payload.periodLabel || '';

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: 'Missing Supabase env vars' }, 500);
  if (!RESEND_API_KEY) return json({ ok: false, error: 'Missing RESEND_API_KEY secret' }, 500);

  // Read notification settings straight from pt_settings (id=1) via the REST API, using the
  // service role key — bypasses RLS, safe since this only ever runs server-side.
  let settingsRow: SettingsRow = {};
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/pt_settings?id=eq.1&select=submit_notify_enabled,submit_notify_emails`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    );
    if (!res.ok) throw new Error(`pt_settings fetch failed: ${res.status}`);
    const rows = await res.json();
    settingsRow = rows[0] || {};
  } catch (err) {
    console.error('Failed to read pt_settings:', err);
    return json({ ok: false, error: 'Could not read settings' }, 500);
  }

  if (!settingsRow.submit_notify_enabled) {
    return json({ ok: true, sent: false, reason: 'Notifications disabled' });
  }

  const recipients = (settingsRow.submit_notify_emails || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return json({ ok: true, sent: false, reason: 'No recipients configured' });

  // Group items by jobsite for a readable email body.
  const byJobsite = new Map<string, string[]>();
  for (const it of items) {
    if (!byJobsite.has(it.jobsite)) byJobsite.set(it.jobsite, []);
    byJobsite.get(it.jobsite)!.push(it.employeeName);
  }
  const jobsites = [...byJobsite.keys()];

  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const subject = jobsites.length === 1
    ? `Timecards submitted to office — ${jobsites[0]} — ${dateStr}`
    : `Timecards submitted to office — ${jobsites[0]} (+${jobsites.length - 1} more) — ${dateStr}`;

  const sectionsHtml = jobsites.map(js => {
    const names = byJobsite.get(js)!;
    return `<p style="margin:0 0 4px;"><strong>${escapeHtml(js)}</strong></p>
      <ul style="margin:0 0 16px;padding-left:20px;">${names.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.5;">
      <p>${escapeHtml(supervisorName)} submitted ${items.length} timecard${items.length !== 1 ? 's' : ''}${periodLabel ? ` for ${escapeHtml(periodLabel)}` : ''} to head office:</p>
      ${sectionsHtml}
      <p style="color:#888;font-size:12px;">Sent automatically by PanoramaTrack.</p>
    </div>`;

  try {
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'PanoramaTrack <alerts@notify.panoramabuildingsystems.ca>',
        to: recipients,
        subject,
        html,
      }),
    });
    const sendData = await sendRes.json();
    if (!sendRes.ok) {
      console.error('Resend API error:', sendData);
      return json({ ok: false, error: sendData?.message || 'Resend API error' }, 502);
    }
    return json({ ok: true, sent: true, id: sendData?.id });
  } catch (err) {
    console.error('Failed to call Resend:', err);
    return json({ ok: false, error: 'Failed to send email' }, 500);
  }
});
