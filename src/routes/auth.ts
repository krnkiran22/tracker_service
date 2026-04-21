import { Router, Request, Response } from 'express'
import {
  getUserByEmail, createUser, verifyUser,
  createOtp, verifyOtp,
} from '../db'
import type { UserRole } from '../db'
import { sendOtpEmail } from '../email'

// Hardcoded admin / fallback accounts (password-based, NOT stored in DB)
const HARDCODED_USERS: { email: string; password: string; role: UserRole; name: string }[] = [
  { email: 'ram@build.ai',   password: 'ram@build.ai', role: 'admin',     name: 'Ram (Admin)'    },
  { email: 'kiran@build.ai', password: 'user',         role: 'user',      name: 'Kiran (Viewer)' },
]

const ALLOWED_SIGNUP_ROLES: UserRole[] = ['logistics', 'ingestion']

const router = Router()

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
// Creates a new logistics/ingestion user and sends OTP
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, email, role } = req.body as { name?: string; email?: string; role?: string }

    if (!name?.trim())  { res.status(400).json({ error: 'Name is required.' }); return }
    if (!email?.trim()) { res.status(400).json({ error: 'Email is required.' }); return }
    if (!role || !ALLOWED_SIGNUP_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: 'Role must be "logistics" or "ingestion".' }); return
    }

    const existing = await getUserByEmail(email)
    if (existing) {
      res.status(409).json({ error: 'This email is already registered. Please log in instead.' }); return
    }

    // Check not a hardcoded account
    if (HARDCODED_USERS.find(u => u.email.toLowerCase() === email.toLowerCase().trim())) {
      res.status(409).json({ error: 'This email is reserved. Please log in using your password.' }); return
    }

    await createUser(name.trim(), email.trim(), role as UserRole)
    const otp = await createOtp(email.trim())

    sendOtpEmail(email.trim(), otp, name.trim(), 'signup').catch(err =>
      console.error('sendOtpEmail (signup) failed:', err)
    )

    res.json({ success: true, message: 'Verification code sent to your email.' })
  } catch (err) {
    console.error('POST /api/auth/signup error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
// For OTP users: sends OTP. Returns {type: 'otp' | 'password'} so frontend
// knows which input to show next.
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string }
    if (!email?.trim()) { res.status(400).json({ error: 'Email is required.' }); return }

    const lower = email.trim().toLowerCase()

    // Check hardcoded admin/user accounts first
    const hardcoded = HARDCODED_USERS.find(u => u.email.toLowerCase() === lower)
    if (hardcoded) {
      res.json({ type: 'password' })
      return
    }

    // Check DB user
    const user = await getUserByEmail(lower)
    if (!user) {
      res.status(404).json({ error: 'No account found with this email. Please sign up first.' }); return
    }

    const otp = await createOtp(lower)
    sendOtpEmail(lower, otp, user.name, 'login').catch(err =>
      console.error('sendOtpEmail (login) failed:', err)
    )

    res.json({ type: 'otp', message: 'Verification code sent to your email.' })
  } catch (err) {
    console.error('POST /api/auth/login error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
// Verifies the 6-digit OTP and returns the user object
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body as { email?: string; otp?: string }
    if (!email?.trim() || !otp?.trim()) {
      res.status(400).json({ error: 'Email and OTP are required.' }); return
    }

    const valid = await verifyOtp(email.trim(), otp.trim())
    if (!valid) {
      res.status(400).json({ error: 'Invalid or expired code. Please try again.' }); return
    }

    const user = await getUserByEmail(email.trim())
    if (!user) { res.status(404).json({ error: 'User not found.' }); return }

    // Mark as verified on first OTP success
    if (!user.is_verified) await verifyUser(email.trim())

    res.json({
      user: { email: user.email, role: user.role, name: user.name },
    })
  } catch (err) {
    console.error('POST /api/auth/verify-otp error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── POST /api/auth/verify-password ───────────────────────────────────────────
// Password check for hardcoded admin accounts only
router.post('/verify-password', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string }
    if (!email?.trim() || !password) {
      res.status(400).json({ error: 'Email and password are required.' }); return
    }

    const match = HARDCODED_USERS.find(
      u => u.email.toLowerCase() === email.trim().toLowerCase() && u.password === password
    )
    if (!match) {
      res.status(401).json({ error: 'Invalid email or password.' }); return
    }

    res.json({ user: { email: match.email, role: match.role, name: match.name } })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
