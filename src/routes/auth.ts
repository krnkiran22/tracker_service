import { Router, Request, Response } from 'express'
import {
  getUserByEmail, createUser, verifyUser,
  createOtp, verifyOtp,
} from '../db'
import type { UserRole } from '../db'
import { sendOtpEmail } from '../email'

const ALLOWED_SIGNUP_ROLES: UserRole[] = ['logistics', 'ingestion']

const router = Router()

// ── POST /api/auth/signup ─────────────────────────────────────────────────────
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, email, role } = req.body as { name?: string; email?: string; role?: string }

    if (!name?.trim())  { res.status(400).json({ error: 'Name is required.' }); return }
    if (!email?.trim()) { res.status(400).json({ error: 'Email is required.' }); return }
    if (!role || !ALLOWED_SIGNUP_ROLES.includes(role as UserRole)) {
      res.status(400).json({ error: 'Role must be "logistics" or "ingestion".' }); return
    }

    const existing = await getUserByEmail(email.trim().toLowerCase())
    if (existing) {
      res.status(409).json({ error: 'This email is already registered. Please log in instead.' }); return
    }

    await createUser(name.trim(), email.trim().toLowerCase(), role as UserRole)
    const otp = await createOtp(email.trim().toLowerCase())

    sendOtpEmail(email.trim().toLowerCase(), otp, name.trim(), 'signup').catch(err =>
      console.error('sendOtpEmail (signup) failed:', err)
    )

    res.json({ success: true, message: 'Verification code sent to your email.' })
  } catch (err) {
    console.error('POST /api/auth/signup error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email } = req.body as { email?: string }
    if (!email?.trim()) { res.status(400).json({ error: 'Email is required.' }); return }

    const lower = email.trim().toLowerCase()
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
router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { email, otp } = req.body as { email?: string; otp?: string }
    if (!email?.trim() || !otp?.trim()) {
      res.status(400).json({ error: 'Email and OTP are required.' }); return
    }

    const valid = await verifyOtp(email.trim().toLowerCase(), otp.trim())
    if (!valid) {
      res.status(400).json({ error: 'Invalid or expired code. Please try again.' }); return
    }

    const user = await getUserByEmail(email.trim().toLowerCase())
    if (!user) { res.status(404).json({ error: 'User not found.' }); return }

    if (!user.is_verified) await verifyUser(email.trim().toLowerCase())

    res.json({
      user: { email: user.email, role: user.role, name: user.name },
    })
  } catch (err) {
    console.error('POST /api/auth/verify-otp error:', err)
    res.status(500).json({ error: String(err) })
  }
})

export default router
