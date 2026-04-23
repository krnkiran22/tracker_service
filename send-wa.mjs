// Quick local WhatsApp sender — run with: node send-wa.mjs
// Scans QR once, saves session locally, sends message, exits.

import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg

import qrcode from 'qrcode-terminal'

const PHONE   = '+919263834869'
const MESSAGE = `👋 *Build AI Tracker*

WhatsApp bot is live ✅
Hereafter you will receive SD card packet updates here — no more emails.`

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_local' }),
  puppeteer: {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
})

client.on('qr', (qr) => {
  console.log('\n📱 Scan this QR with WhatsApp → Linked Devices → Link a Device\n')
  qrcode.generate(qr, { small: true })
})

client.on('ready', async () => {
  console.log('✅ WhatsApp ready — sending message…')
  const chatId = PHONE.replace('+', '').replace(/\s/g, '') + '@c.us'
  await client.sendMessage(chatId, MESSAGE)
  console.log(`✅ Message sent to ${PHONE}`)
  await client.destroy()
  process.exit(0)
})

client.on('auth_failure', () => {
  console.error('❌ Auth failed')
  process.exit(1)
})

client.initialize()
