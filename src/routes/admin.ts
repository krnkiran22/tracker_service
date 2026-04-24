import { Router, Request, Response } from 'express'
import {
  getIngestionRecords, updateIngestionRecord, deleteIngestionRecord,
  getUsers, deleteUser, updateUserRole,
} from '../db'
import type { UserRole } from '../db'

const router = Router()

// ── Ingestion Records ─────────────────────────────────────────────────────────

// GET /api/admin/ingestion-records
router.get('/ingestion-records', async (_req: Request, res: Response) => {
  try {
    const records = await getIngestionRecords()
    res.json(records)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/admin/ingestion-records/:id
router.put('/ingestion-records/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const updated = await updateIngestionRecord(id, req.body)
    if (!updated) { res.status(404).json({ error: 'Not found' }); return }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/admin/ingestion-records/:id
router.delete('/ingestion-records/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const ok = await deleteIngestionRecord(id)
    if (!ok) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users
router.get('/users', async (_req: Request, res: Response) => {
  try {
    const users = await getUsers()
    res.json(users)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/admin/users/:id — change role
router.put('/users/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const { role } = req.body as { role?: string }
    const allowed: UserRole[] = ['admin', 'logistics', 'ingestion', 'ingestion_lead', 'user']
    if (!role || !allowed.includes(role as UserRole)) {
      res.status(400).json({ error: 'Invalid role' }); return
    }
    const updated = await updateUserRole(id, role as UserRole)
    if (!updated) { res.status(404).json({ error: 'User not found' }); return }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/admin/users/:id
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const ok = await deleteUser(id)
    if (!ok) { res.status(404).json({ error: 'User not found' }); return }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
