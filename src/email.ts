import nodemailer from 'nodemailer'
import type { SdPacket, IngestionRecord } from './db'

function getTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
}

function fmt(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

export async function sendPacketReceivedEmail(packet: SdPacket) {
  const to = packet.poc_emails.split(',').map(e => e.trim()).filter(Boolean)
  if (!to.length) return
  const t = getTransporter()
  await t.sendMail({
    from:    process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to:      to.join(', '),
    subject: `[SD Card Tracker] SD Cards Received — ${packet.team_name} (${packet.sd_card_count} cards)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:8px;">
        <div style="background:#1e293b;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0;">
          <h2 style="margin:0;font-size:16px;">📦 SD Cards Received by Logistics</h2>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;">
          <p>The logistics team has logged receipt of SD cards from your team.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;width:40%;">Team</td><td style="padding:8px 12px;">${packet.team_name}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Factory</td><td style="padding:8px 12px;">${packet.factory}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Date Received</td><td style="padding:8px 12px;">${fmt(packet.date_received)}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">SD Card Count</td><td style="padding:8px 12px;font-weight:700;font-size:16px;">${packet.sd_card_count}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Logged By</td><td style="padding:8px 12px;">${packet.entered_by}</td></tr>
            ${packet.notes ? `<tr><td style="padding:8px 12px;font-weight:600;">Notes</td><td style="padding:8px 12px;">${packet.notes}</td></tr>` : ''}
          </table>
          <div style="margin-top:16px;padding:12px;background:#fef9c3;border-left:4px solid #f59e0b;border-radius:4px;">
            <strong>Status: Received</strong> — Awaiting ingestion team acknowledgement.
          </div>
          <p style="margin-top:16px;font-size:12px;color:#94a3b8;">Automated message from SD Card Tracker.</p>
        </div>
      </div>`,
  })
}

export async function sendPacketAcknowledgedEmail(packet: SdPacket) {
  const to = packet.poc_emails.split(',').map(e => e.trim()).filter(Boolean)
  if (!to.length) return
  const t = getTransporter()
  await t.sendMail({
    from:    process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to:      to.join(', '),
    subject: `[SD Card Tracker] SD Cards In Queue for Ingestion — ${packet.team_name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:8px;">
        <div style="background:#1d4ed8;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0;">
          <h2 style="margin:0;font-size:16px;">⚙️ SD Cards In Ingestion Queue</h2>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;">
          <p>The ingestion team has acknowledged the SD card packet and is now processing it.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;width:40%;">Team</td><td style="padding:8px 12px;">${packet.team_name}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Factory</td><td style="padding:8px 12px;">${packet.factory}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Date Received</td><td style="padding:8px 12px;">${fmt(packet.date_received)}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">SD Cards</td><td style="padding:8px 12px;font-weight:700;">${packet.sd_card_count}</td></tr>
          </table>
          <div style="margin-top:16px;padding:12px;background:#dbeafe;border-left:4px solid #1d4ed8;border-radius:4px;">
            <strong>Status: Processing</strong> — You will receive another email once ingestion is complete.
          </div>
          <p style="margin-top:16px;font-size:12px;color:#94a3b8;">Automated message from SD Card Tracker.</p>
        </div>
      </div>`,
  })
}

export async function sendIngestionCompleteEmail(packet: SdPacket, record: IngestionRecord) {
  const to = packet.poc_emails.split(',').map(e => e.trim()).filter(Boolean)
  if (!to.length) return
  const t = getTransporter()
  await t.sendMail({
    from:    process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to:      to.join(', '),
    subject: `[SD Card Tracker] Ingestion Complete — ${packet.team_name} (${record.actual_count} cards)`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9fafb;padding:24px;border-radius:8px;">
        <div style="background:#15803d;color:#fff;padding:16px 20px;border-radius:6px 6px 0 0;">
          <h2 style="margin:0;font-size:16px;">✅ SD Card Ingestion Complete</h2>
        </div>
        <div style="background:#fff;padding:20px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 6px 6px;">
          <p>The ingestion process for your SD card packet has been completed.</p>
          <h3 style="font-size:13px;color:#64748b;text-transform:uppercase;">Packet Details</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:16px;">
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;width:40%;">Team</td><td style="padding:8px 12px;">${packet.team_name}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Factory</td><td style="padding:8px 12px;">${packet.factory}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Cards Submitted</td><td style="padding:8px 12px;">${packet.sd_card_count}</td></tr>
          </table>
          <h3 style="font-size:13px;color:#64748b;text-transform:uppercase;">Ingestion Summary</h3>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;width:40%;">Team</td><td style="padding:8px 12px;">${record.team_name}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Industry</td><td style="padding:8px 12px;">${record.industry}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Actual Count</td><td style="padding:8px 12px;color:#15803d;font-weight:700;font-size:16px;">${record.actual_count}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Missing Cards</td><td style="padding:8px 12px;color:${record.missing_count > 0 ? '#dc2626' : 'inherit'};font-weight:${record.missing_count > 0 ? 700 : 400};">${record.missing_count}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Extra Cards</td><td style="padding:8px 12px;">${record.extra_count}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Red Cards</td><td style="padding:8px 12px;color:${record.red_cards_count > 0 ? '#dc2626' : 'inherit'};font-weight:${record.red_cards_count > 0 ? 700 : 400};">${record.red_cards_count}</td></tr>
            <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Deployment Date</td><td style="padding:8px 12px;">${fmt(record.deployment_date)}</td></tr>
            <tr><td style="padding:8px 12px;font-weight:600;">Ingested By</td><td style="padding:8px 12px;">${record.ingested_by}</td></tr>
            ${record.notes ? `<tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Notes</td><td style="padding:8px 12px;">${record.notes}</td></tr>` : ''}
          </table>
          <div style="margin-top:16px;padding:12px;background:#dcfce7;border-left:4px solid #15803d;border-radius:4px;">
            <strong>Status: Completed</strong> — Ingestion successfully processed and recorded.
          </div>
          <p style="margin-top:16px;font-size:12px;color:#94a3b8;">Automated message from SD Card Tracker.</p>
        </div>
      </div>`,
  })
}
