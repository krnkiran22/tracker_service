import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { initDB } from './db'
import transactionsRouter from './routes/transactions'
import teamsRouter from './routes/teams'
import packetsRouter from './routes/packets'
import authRouter from './routes/auth'
import adminRouter from './routes/admin'
import eventsRouter from './routes/events'
import { execSync as _execSync, spawn, type ChildProcess } from 'child_process'
import path from 'path'
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

app.use(express.json({ limit: '50mb' }))   // allow multiple photo data-URLs from Discord bot

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

app.post('/send-wa', async (req, res) => {
  if (!getIsReady()) {
    res.status(503).json({
      ok: false,
      qr_pending: !!WhatsAppModule.latestQR,
      message: WhatsAppModule.latestQR
        ? 'QR pending — open /qr to scan first'
        : 'Client still initialising — wait 20–30s and retry',
    })
    return
  }
  const { phone, message } = req.body as { phone?: string; message?: string }
  if (!phone || !message) {
    res.status(400).json({ ok: false, error: 'phone and message are required' })
    return
  }
  try {
    await WhatsAppModule.sendWhatsAppMessage(phone, message)
    res.json({ ok: true, sent_to: phone })
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
app.use('/api/events',       eventsRouter)

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

// ── Discord bot — runs as a child process inside this same Railway service ───
// The bot is a plain CommonJS script at discord-bot/index.js. Spawning it as
// a subprocess lets us share the container (single Railway service for both
// backend API and bot) while isolating crashes — if the bot dies we restart
// it without taking down the API.
let discordBot: ChildProcess | null = null
let botRestartAttempts = 0

function startDiscordBot() {
  if (!process.env.DISCORD_TOKEN) {
    console.warn('⚠ DISCORD_TOKEN not set — skipping Discord bot startup')
    return
  }
  // dist/index.js lives at <root>/dist/ at runtime → the bot is at ../discord-bot
  const botPath = path.resolve(__dirname, '..', 'discord-bot', 'index.js')
  console.log(`▶ Starting Discord bot: ${botPath}`)

  discordBot = spawn(process.execPath, [botPath], {
    stdio: 'inherit',            // stream bot logs into Railway logs
    env: process.env as NodeJS.ProcessEnv,
    cwd: path.resolve(__dirname, '..'),
  })

  discordBot.on('spawn', () => {
    botRestartAttempts = 0
    console.log(`✓ Discord bot process spawned (pid=${discordBot?.pid})`)
  })

  discordBot.on('error', (err) => {
    console.error('✗ Discord bot spawn error:', err)
  })

  discordBot.on('exit', (code, signal) => {
    console.warn(`⚠ Discord bot exited (code=${code}, signal=${signal})`)
    discordBot = null
    // Back-off restart: 5s, 10s, 20s, 40s, max 60s, then steady
    botRestartAttempts++
    const delay = Math.min(5000 * Math.pow(2, Math.min(botRestartAttempts - 1, 5)), 60_000)
    console.log(`⟳ Restarting Discord bot in ${delay / 1000}s (attempt #${botRestartAttempts})`)
    setTimeout(startDiscordBot, delay)
  })
}

// Clean shutdown — kill the bot if the parent is shutting down
;['SIGINT', 'SIGTERM'].forEach(sig => {
  process.on(sig, () => {
    if (discordBot && !discordBot.killed) {
      console.log(`Received ${sig} — terminating Discord bot subprocess`)
      discordBot.kill('SIGTERM')
    }
    process.exit(0)
  })
})

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
    startDiscordBot()
  })
}

start()
