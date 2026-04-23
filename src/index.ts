import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { initDB } from './db'
import transactionsRouter from './routes/transactions'
import teamsRouter from './routes/teams'
import packetsRouter from './routes/packets'
import authRouter from './routes/auth'
import adminRouter from './routes/admin'
import { execSync as _execSync } from 'child_process'
import { initWhatsApp, getIsReady } from './whatsapp'
import * as WhatsAppModule from './whatsapp'
import QRCode from 'qrcode'

// ── Debug: confirm system Chromium is present (installed via Dockerfile apt) ──
try {
  const result = _execSync(
    'ls -la /usr/bin/chromium 2>/dev/null || echo "not found at /usr/bin/chromium"',
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString().trim()
  console.log('[Debug] System Chromium:', result)
} catch (e: unknown) {
  console.log('[Debug] Chromium check failed:', e instanceof Error ? e.message : e)
}

const app = express()
const PORT = Number(process.env.PORT ?? 4000)

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
  : ['*']

app.use(cors({
  origin: allowedOrigins.includes('*')
    ? '*'
    : (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) cb(null, true)
        else cb(new Error(`CORS: origin ${origin} not allowed`))
      },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-sync-secret'],
  credentials: true,
}))

app.use(express.json({ limit: '10mb' }))   // allow photo data-URLs

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// ── WhatsApp QR page — open in browser to scan ────────────────────────────────
app.get('/qr', async (_req, res) => {
  const qrString = WhatsAppModule.latestQR
  if (!qrString) {
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:60px">
      <h2>✅ WhatsApp Already Connected</h2>
      <p>No QR code available — the client is already authenticated.</p>
      <p>If you just deployed and haven't scanned yet, wait 10–15 seconds and refresh.</p>
    </body></html>`)
    return
  }
  try {
    const dataUrl = await QRCode.toDataURL(qrString, { width: 400, margin: 2 })
    res.send(`<!DOCTYPE html><html><head><title>WhatsApp QR — Build AI Tracker</title></head>
    <body style="font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5">
      <h2>📱 Scan with WhatsApp</h2>
      <p>Open WhatsApp → Linked Devices → Link a Device → scan this QR</p>
      <img src="${dataUrl}" style="border:4px solid #25D366;border-radius:12px;margin:20px auto;display:block"/>
      <p style="color:#888;font-size:13px">This page auto-refreshes every 20s. QR expires in ~60s.</p>
      <script>setTimeout(()=>location.reload(), 20000)</script>
    </body></html>`)
  } catch {
    res.status(500).send('Failed to generate QR image')
  }
})

// ── WhatsApp status + test ────────────────────────────────────────────────────
app.get('/wa-status', (_req, res) => {
  res.json({
    ready: getIsReady(),
    qr_pending: !!WhatsAppModule.latestQR,
    message: getIsReady()
      ? '✅ WhatsApp client is ready'
      : WhatsAppModule.latestQR
        ? '📱 QR pending — open /qr to scan'
        : '⏳ Initialising — wait 20–30 seconds and refresh',
  })
})

app.get('/test-wa', async (req, res) => {
  if (!getIsReady()) {
    res.status(503).json({
      ok: false,
      ready: false,
      qr_pending: !!WhatsAppModule.latestQR,
      message: WhatsAppModule.latestQR
        ? 'QR pending — open /qr to scan first'
        : 'Client still initialising — wait 20–30s and retry',
    })
    return
  }
  const phone = (req.query.phone as string) || '+919677514444'
  const text  = (req.query.msg  as string) || '👋 *Build AI Tracker*\n\nWhatsApp bot is live ✅\nHereafter you will receive SD card packet updates here instead of email.'
  try {
    await WhatsAppModule.sendWhatsAppMessage(phone, text)
    res.json({ ok: true, message: `WhatsApp message sent to ${phone}` })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
})

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',         authRouter)
app.use('/api/transactions', transactionsRouter)
app.use('/api/teams',        teamsRouter)
app.use('/api/packets',      packetsRouter)
app.use('/api/admin',        adminRouter)

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }))

// ── Self-ping — keeps Railway from sleeping (every 14 minutes) ────────────────
function startKeepAlive() {
  const selfUrl = process.env.SELF_URL ?? `https://trackerservice-production.up.railway.app`
  const INTERVAL_MS = 14 * 60 * 1000  // 14 minutes

  setInterval(async () => {
    try {
      const res = await fetch(`${selfUrl}/health`)
      console.log(`[keep-alive] /health → ${res.status}`)
    } catch (err) {
      console.warn(`[keep-alive] ping failed:`, err)
    }
  }, INTERVAL_MS)

  console.log(`✓ Keep-alive pinging ${selfUrl}/health every 14 min`)
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB()
    console.log('✓ Database initialised')
  } catch (err) {
    console.error('✗ Failed to initialise DB:', err)
    process.exit(1)
  }

  app.listen(PORT, () => {
    console.log(`✓ Build AI Tracker backend running on port ${PORT}`)
    startKeepAlive()
    initWhatsApp()
  })
}

start()
