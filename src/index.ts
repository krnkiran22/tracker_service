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
import { initWhatsApp } from './whatsapp'

// ── Debug: show exactly which Chromium binaries exist on this container ────────
try {
  const result = _execSync(
    'which chromium; which chromium-browser; find /usr -name "chrom*" -type f 2>/dev/null; find /nix/store -name "chromium" -type f 2>/dev/null | head -3',
    { stdio: ['pipe', 'pipe', 'pipe'] }
  ).toString().trim()
  console.log('[Debug] Chromium search:\n' + result)
} catch (e) {
  console.log('[Debug] Chromium search — nothing found in standard paths')
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
