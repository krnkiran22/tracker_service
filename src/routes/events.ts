import { Router, Request, Response } from 'express'
import { getRecentEvents } from '../db'

const router = Router()

// GET /api/events — recent activity log, newest first
// Used by the Logs page (admin, ingestion_lead, logistics_lead)
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 300), 1000)
    const events = await getRecentEvents(limit)
    res.json(events)
  } catch (err) {
    console.error('GET /api/events error:', err)
    res.status(500).json({ error: String(err) })
  }
})

export default router
