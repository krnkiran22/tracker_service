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

// ── Core send ─────────────────────────────────────────────────────────────────
export async function sendWhatsAppMessage(phone: string, message: string): Promise<void> {
  if (!isReady) {
    console.warn(`[WhatsApp] client not ready — skipping message to ${phone}`)
    return
  }
  try {
    const chatId = phone.replace('+', '').replace(/\s/g, '') + '@c.us'
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
