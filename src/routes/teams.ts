import { Router, Request, Response } from 'express'
import { getTeamsWithEmails, upsertTeam } from '../db'

const router = Router()

// GET /api/teams — returns [{ name, poc_emails }]
router.get('/', async (_req: Request, res: Response) => {
  try {
    const teams = await getTeamsWithEmails()
    res.json(teams)
  } catch (err) {
    console.error('GET /api/teams error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/teams
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, poc_emails } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return }
    await upsertTeam(String(name).trim(), poc_emails ?? '')
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
