import { Client, LocalAuth } from 'whatsapp-web.js'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import type { SdPacket, IngestionRecord } from './db'

let isReady = false
export let latestQR: string | null = null   // raw QR string, served via /qr endpoint
export function getIsReady() { return isReady }

// Dockerfile installs system Chromium via apt — PUPPETEER_EXECUTABLE_PATH
// is set to /usr/bin/chromium in the Dockerfile ENV.
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WHATSAPP_SESSION_PATH ?? '/app/.wwebjs_auth',
  }),
  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium',
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--single-process',
    ],
  },
})

client.on('qr', (qr: string) => {
  latestQR = qr
  console.log('📱 WhatsApp QR ready — open /qr in your browser to scan')
  qrcode.generate(qr, { small: true })
})

client.on('ready', () => {
  isReady = true
  latestQR = null
  console.log('✅ WhatsApp client is ready')
})

client.on('auth_failure', (msg: string) => {
  console.error('❌ WhatsApp auth failure:', msg)
})

client.on('disconnected', (reason: string) => {
  isReady = false
  console.warn('⚠️  WhatsApp disconnected:', reason, '— reconnecting…')
  client.initialize().catch(console.error)
})

// ── Phone normalisation ───────────────────────────────────────────────────────
// Accepts any of: "9876543210", "+919876543210", "919876543210", "09876543210"
// Always produces the numeric-only string used by whatsapp-web.js (e.g. "919876543210")
function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10)                              return '91' + digits          // bare 10-digit
  if (digits.length === 11 && digits.startsWith('0'))   return '91' + digits.slice(1) // 0XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith('91'))  return digits                 // already 91XXXXXXXXXX
  if (digits.length === 13 && digits.startsWith('091')) return digits.slice(1)        // 091XXXXXXXXXX
  return digits  // fallback — use as-is
}

// ── Core send ─────────────────────────────────────────────────────────────────
export async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  if (!isReady) {
    console.warn(`[WhatsApp] client not ready — skipping message to ${phone}`)
    return
  }
  try {
    const chatId = normalizePhone(phone) + '@c.us'
    await client.sendMessage(chatId, message)
    console.log(`[WhatsApp] ✅ sent to ${phone}`)
  } catch (err) {
    console.error(`[WhatsApp] ❌ failed to ${phone}:`, err)
  }
}

// ── Broadcast to comma-separated phone list ───────────────────────────────────
async function broadcast(phones: string, message: string) {
  const list = phones.split(',').map(p => p.trim()).filter(Boolean)
  await Promise.allSettled(list.map(p => sendWhatsAppMessage(p, message)))
}

function fmt(d: string) {
  return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'
}

// ── Event: received_at_hq ─────────────────────────────────────────────────────
export async function waSendReceivedAtHQ(packet: SdPacket & { poc_phones?: string | null }) {
  if (!packet.poc_phones) return
  const ts = new Date(packet.created_at).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const msg =
`📦 *SD Cards Received at HQ*

*Team:* ${packet.team_name}
*Date Received:* ${fmt(packet.date_received)}
*Logged At:* ${ts}

Your SD cards have arrived at HQ and will be counted shortly.`
  await broadcast(packet.poc_phones, msg)
}

// ── Event: counted_and_repacked ───────────────────────────────────────────────
export async function waSendCountedAndRepacked(
  packet: SdPacket & { poc_phones?: string | null },
  eventData: Record<string, unknown>,
) {
  if (!packet.poc_phones) return
  const ts = new Date().toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  })
  const notes = eventData.condition_notes ? `\n*Condition Notes:* ${eventData.condition_notes}` : ''
  const msg =
`🔢 *SD Cards Counted & Repacked*

*Team:* ${packet.team_name}
*SD Card Count:* ${eventData.sd_card_count}${notes}
*Repacked At:* ${ts}

Cards are packed and ready for ingestion team pickup.`
  await broadcast(packet.poc_phones, msg)
}

// ── Stage 1 — SD Cards Received ───────────────────────────────────────────────
export async function waSendPacketReceived(packet: SdPacket & { poc_phones?: string | null }) {
  if (!packet.poc_phones) return
  const msg =
`📦 *SD Cards Received*

*Team:* ${packet.team_name}
*Factory:* ${packet.factory}
*Date Received:* ${fmt(packet.date_received)}
*Card Count:* ${packet.sd_card_count}
*Logged By:* ${packet.entered_by}${packet.notes ? `\n*Notes:* ${packet.notes}` : ''}

_Status: Received — awaiting ingestion team._`
  await broadcast(packet.poc_phones, msg)
}

// ── Stage 2 — Ingestion Acknowledged ─────────────────────────────────────────
export async function waSendPacketAcknowledged(packet: SdPacket & { poc_phones?: string | null }) {
  if (!packet.poc_phones) return
  const msg =
`⏳ *SD Cards In Ingestion Queue*

*Team:* ${packet.team_name}
*Factory:* ${packet.factory}
*Card Count:* ${packet.sd_card_count}

Your packet has been acknowledged by the ingestion team and is now being processed.

_Status: Processing — you'll be notified when ingestion is complete._`
  await broadcast(packet.poc_phones, msg)
}

// ── Stage 3 — Ingestion Complete ─────────────────────────────────────────────
export async function waSendIngestionComplete(
  packet: SdPacket & { poc_phones?: string | null },
  record: IngestionRecord,
) {
  if (!packet.poc_phones) return
  const msg =
`✅ *Ingestion Complete*

*Team:* ${packet.team_name}
*Factory:* ${packet.factory}

*Ingestion Summary*
• Actual Count: ${record.actual_count}
• Missing Cards: ${record.missing_count}${record.missing_count > 0 ? ' ⚠️' : ''}
• Extra Cards: ${record.extra_count}
• Red Cards: ${record.red_cards_count}${record.red_cards_count > 0 ? ' 🔴' : ''}
• Industry: ${record.industry}
• Ingested By: ${record.ingested_by}
• Deployment Date: ${fmt(record.deployment_date)}${record.notes ? `\n• Notes: ${record.notes}` : ''}

_Status: Completed ✓_`
  await broadcast(packet.poc_phones, msg)
}

export function initWhatsApp() {
  console.log('🔄 Initialising WhatsApp client…')
  client.initialize().catch((err: unknown) => console.error('WhatsApp init error:', err))
}

export default client
