import { Router, Request, Response } from 'express'
import { getTeamsWithEmails, upsertTeam, updateTeam, deleteTeam } from '../db'

const router = Router()

// GET /api/teams
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
    const { name, poc_emails, poc_phones } = req.body
    if (!name?.trim()) { res.status(400).json({ error: 'name required' }); return }
    await upsertTeam(String(name).trim(), poc_emails ?? '', poc_phones ?? '')
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/teams/:name — admin edit
router.put('/:name', async (req: Request, res: Response) => {
  try {
    const oldName = decodeURIComponent(req.params.name)
    const { name, poc_emails, poc_phones } = req.body
    const updated = await updateTeam(oldName, { name, poc_emails, poc_phones })
    if (!updated) { res.status(404).json({ error: 'Team not found' }); return }
    res.json(updated)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/teams/:name — admin delete
router.delete('/:name', async (req: Request, res: Response) => {
  try {
    const name = decodeURIComponent(req.params.name)
    const ok = await deleteTeam(name)
    if (!ok) { res.status(404).json({ error: 'Team not found' }); return }
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

export default router
