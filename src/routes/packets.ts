import { Router, Request, Response } from 'express'
import {
  insertPacket, getPackets, getPacketsByStatuses, getPacketById,
  updatePacketStatus, updatePacket, deletePacket,
  insertIngestionRecord, getIngestionRecordByPacketId,
  insertSdEvent, getSdEventsByPacketId,
  insertTransaction, getCompletedPacketsWithRecords,
} from '../db'
import type { PacketStatus } from '../db'
import {
  sendPacketReceivedEmail,
  sendPacketAcknowledgedEmail,
  sendIngestionCompleteEmail,
} from '../email'
import {
  waSendPacketReceived,
  waSendPacketAcknowledged,
  waSendIngestionComplete,
  waSendReceivedAtHQ,
  waSendCountedAndRepacked,
} from '../whatsapp'

const router = Router()

// GET /api/packets/completed-with-records
// Single JOIN query — returns completed packets with their ingestion records embedded.
// Must be declared before /:id so Express doesn't treat "completed-with-records" as an id.
router.get('/completed-with-records', async (_req: Request, res: Response) => {
  try {
    const rows = await getCompletedPacketsWithRecords()
    res.json(rows)
  } catch (err) {
    console.error('GET /api/packets/completed-with-records error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets
// Supports ?status=single  OR  ?statuses=a,b,c  for multi-status filtering
router.get('/', async (req: Request, res: Response) => {
  try {
    const status   = req.query.status   as PacketStatus | undefined
    const statuses = req.query.statuses as string | undefined

    let packets
    if (statuses) {
      const list = statuses.split(',').map(s => s.trim()).filter(Boolean) as PacketStatus[]
      packets = await getPacketsByStatuses(list)
    } else {
      packets = await getPackets(status ? { status } : undefined)
    }
    res.json(packets)
  } catch (err) {
    console.error('GET /api/packets error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/packets
// Supports two flows:
//   New event-based flow:  { team_name, received_date, poc_phones, entered_by }
//   Legacy admin flow:     { team_name, factory, date_received, sd_card_count, ... }
router.post('/', async (req: Request, res: Response) => {
  try {
    const body = req.body

    // ── New event-based logistics flow (received_at_hq) ──────────────────────
    if (!body.factory && body.received_date) {
      const { team_name, received_date, poc_phones, entered_by, photo_urls } = body
      if (!team_name || !received_date) {
        res.status(400).json({ error: 'team_name and received_date are required' })
        return
      }

      const packet = await insertPacket({
        team_name,
        factory:        '',
        date_received:  received_date,
        sd_card_count:  0,
        notes:          null,
        photo_url:      null,
        photo_urls:     photo_urls || null,
        entered_by:     entered_by || 'Logistics',
        poc_emails:     '',
        poc_phones:     poc_phones || '',
        status:         'received_at_hq',
      } as any)

      // Log the event
      await insertSdEvent(packet.id, 'received_at_hq', {
        team_name,
        received_date,
        poc_phones:  poc_phones || '',
        entered_by:  entered_by || 'Logistics',
        photo_urls:  photo_urls || null,
      })

      waSendReceivedAtHQ(packet as any).catch(err =>
        console.error('waSendReceivedAtHQ failed:', err)
      )

      res.status(201).json(packet)
      return
    }

    // ── Legacy flow (admin / full form) ──────────────────────────────────────
    const { team_name, factory, date_received, sd_card_count, notes, photo_url, photo_urls, entered_by, poc_emails, poc_phones } = body

    if (!team_name || !factory || !date_received || !entered_by) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    const packet = await insertPacket({
      team_name,
      factory,
      date_received,
      sd_card_count: Number(sd_card_count) || 0,
      notes:         notes || null,
      photo_url:     photo_url || null,
      photo_urls:    photo_urls || null,
      entered_by,
      poc_emails:    poc_emails || '',
      poc_phones:    poc_phones || '',
    } as any)

    sendPacketReceivedEmail(packet).catch(err =>
      console.error('sendPacketReceivedEmail failed:', err)
    )
    waSendPacketReceived(packet as any).catch(err =>
      console.error('waSendPacketReceived failed:', err)
    )

    res.status(201).json(packet)
  } catch (err) {
    console.error('POST /api/packets error:', err)
    res.status(500).json({ error: String(err) })
  }
})

// POST /api/packets/:id/events — log a new event against an existing packet
router.post('/:id/events', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const { event_type, event_data } = req.body as {
      event_type: 'counted_and_repacked' | 'collected_for_ingestion'
      event_data: Record<string, unknown>
    }

    if (!event_type || !event_data) {
      res.status(400).json({ error: 'event_type and event_data are required' })
      return
    }

    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Packet not found' }); return }

    // Log the event
    const event = await insertSdEvent(id, event_type, event_data)

    // ── counted_and_repacked ─────────────────────────────────────────────────
    if (event_type === 'counted_and_repacked') {
      const sdCount      = Number(event_data.sd_card_count)  || 0
      const numPackages  = Number(event_data.num_packages)    || 0
      const factoryName  = String(event_data.factory_name   ?? packet.factory ?? '')
      const deployDate   = event_data.deployment_date ? String(event_data.deployment_date) : null
      const countedBy    = String(event_data.counted_by ?? 'Logistics')

      const repackPhotos = event_data.repack_photo_urls
        ? JSON.stringify(event_data.repack_photo_urls)
        : null

      // Multiple factory entries (each has factory_name + deployment_date)
      const factoryEntries = event_data.factory_entries
        ? JSON.stringify(event_data.factory_entries)
        : JSON.stringify([{ factory_name: factoryName, deployment_date: deployDate }])

      const updatedPacket = await updatePacket(id, {
        status:             'counted_and_repacked',
        sd_card_count:      sdCount,
        num_packages:       numPackages,
        factory:            factoryName,
        deployment_date:    deployDate ?? undefined,
        counted_by:         countedBy,
        repack_photo_urls:  repackPhotos ?? undefined,
        factory_entries:    factoryEntries,
      })

      // Auto-create a "received" transaction in the inventory tracker
      insertTransaction({
        team_name:       packet.team_name,
        type:            'received',
        date:            new Date().toISOString().slice(0, 10),
        devices:         0,
        sd_cards:        sdCount,
        hubs:            0,
        cables:          0,
        extension_boxes: 0,
        sd_card_readers: 0,
        other:           0,
        notes:           `Auto-logged from SD card count & repack (packet #${id})${event_data.condition_notes ? ' — ' + event_data.condition_notes : ''}`,
        entered_by:      countedBy,
      }).catch(err => console.error('auto-transaction insert failed:', err))

      waSendCountedAndRepacked(updatedPacket as any, event_data).catch(err =>
        console.error('waSendCountedAndRepacked failed:', err)
      )

      res.status(201).json({ packet: updatedPacket, event })
      return
    }

    // ── collected_for_ingestion ──────────────────────────────────────────────
    if (event_type === 'collected_for_ingestion') {
      const collectedBy = String(event_data.collected_by ?? 'Ingestion')
      const assignedTo  = event_data.assigned_to ? String(event_data.assigned_to) : null
      const updatedPacket = await updatePacket(id, {
        status:       'collected_for_ingestion',
        collected_by: collectedBy,
        ...(assignedTo ? { assigned_to: assignedTo } : {}),
      })
      res.status(201).json({ packet: updatedPacket, event })
      return
    }

    res.status(400).json({ error: `Unknown event_type: ${event_type}` })
  } catch (err) {
    console.error(`POST /api/packets/${req.params.id}/events error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// GET /api/packets/:id
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }
    const [ingestion, events] = await Promise.all([
      getIngestionRecordByPacketId(id),
      getSdEventsByPacketId(id),
    ])
    res.json({ packet, ingestion, events })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
})

// PATCH /api/packets/:id  — acknowledge | complete
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const { action, ...ingestionData } = req.body

    const packet = await getPacketById(id)
    if (!packet) { res.status(404).json({ error: 'Not found' }); return }

    if (action === 'acknowledge') {
      if (packet.status !== 'received') {
        res.status(400).json({ error: 'Packet is not in received state' })
        return
      }
      const updated = await updatePacketStatus(id, 'processing')
      sendPacketAcknowledgedEmail(updated!).catch(err =>
        console.error('sendPacketAcknowledgedEmail failed:', err)
      )
      waSendPacketAcknowledged(updated! as any).catch(err =>
        console.error('waSendPacketAcknowledged failed:', err)
      )
      res.json(updated)
      return
    }

    if (action === 'complete') {
      // Allow completion from both the old `processing` state and the new
      // logistics-pipeline `collected_for_ingestion` state
      const completableStatuses = ['processing', 'collected_for_ingestion']
      if (!completableStatuses.includes(packet.status)) {
        res.status(400).json({ error: 'Packet cannot be completed from its current state' })
        return
      }

      const {
        team_name, actual_count, missing_count, extra_count,
        red_cards_count, ingested_by, deployment_date, notes,
      } = ingestionData

      // industry is optional for the new logistics flow
      const industry = ingestionData.industry || packet.factory || 'General'

      if (!team_name || !ingested_by || !deployment_date) {
        res.status(400).json({ error: 'Missing ingestion fields' })
        return
      }

      const record = await insertIngestionRecord({
        packet_id:       id,
        team_name,
        industry,
        actual_count:    Number(actual_count)    || 0,
        missing_count:   Number(missing_count)   || 0,
        extra_count:     Number(extra_count)     || 0,
        red_cards_count: Number(red_cards_count) || 0,
        ingested_by,
        deployment_date,
        notes: notes || null,
      })

      const updatedPacket = await updatePacketStatus(id, 'completed')

      sendIngestionCompleteEmail(updatedPacket!, record).catch(err =>
        console.error('sendIngestionCompleteEmail failed:', err)
      )
      waSendIngestionComplete(updatedPacket! as any, record).catch(err =>
        console.error('waSendIngestionComplete failed:', err)
      )

      res.json({ packet: updatedPacket, ingestion: record })
      return
    }

    res.status(400).json({ error: 'Unknown action' })
  } catch (err) {
    console.error(`PATCH /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// PUT /api/packets/:id — admin full edit
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const updated = await updatePacket(id, req.body)
    if (!updated) { res.status(404).json({ error: 'Not found' }); return }
    res.json(updated)
  } catch (err) {
    console.error(`PUT /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

// DELETE /api/packets/:id — admin delete
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id)
    const ok = await deletePacket(id)
    if (!ok) { res.status(404).json({ error: 'Not found' }); return }
    res.json({ success: true })
  } catch (err) {
    console.error(`DELETE /api/packets/${req.params.id} error:`, err)
    res.status(500).json({ error: String(err) })
  }
})

export default router
