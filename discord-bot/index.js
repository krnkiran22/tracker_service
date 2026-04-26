require('dotenv').config()

const {
  Client, GatewayIntentBits, Events,
  REST, Routes,
} = require('discord.js')

const CLIENT_ID   = process.env.CLIENT_ID  || '1497976137345667173'
const BACKEND     = process.env.BACKEND_URL || 'https://trackerservice-production.up.railway.app'
const TRACKER_URL = 'https://sd-tracker.vercel.app'

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res  = await fetch(`${BACKEND}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'API error')
  return data
}

// Download a Discord attachment → base64 data URL
async function toBase64(att) {
  const res  = await fetch(att.url)
  const buf  = await res.arrayBuffer()
  const b64  = Buffer.from(buf).toString('base64')
  const mime = att.contentType || 'image/jpeg'
  return `data:${mime};base64,${b64}`
}

// Extract image attachments from a message → base64 list
async function extractPhotos(msg) {
  const images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
  if (!images.length) return []
  return Promise.all(images.map(toBase64))
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Parse "Key: Value" lines into an object
function parseKV(lines) {
  const out = {}
  for (const line of lines) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim().toLowerCase().replace(/\s+/g, '_')
    const val = line.slice(idx + 1).trim()
    if (val) out[key] = val
  }
  return out
}

// ── Slash command definitions — read-only only ────────────────────────────────
const COMMANDS = [
  {
    name: 'list',
    description: '📋 List all packets pending Count & Repack',
  },
  {
    name: 'ready',
    description: '🚀 Show all packets ready to ingest',
  },
]

async function registerCommands(client) {
  const rest   = new REST().setToken(process.env.DISCORD_TOKEN)
  const guilds = client.guilds.cache.map(g => g.id)
  for (const guildId of guilds) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMMANDS })
    console.log(`✅ Slash commands registered in guild ${guildId}`)
  }
  if (!guilds.length) {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: COMMANDS })
    console.log('✅ Slash commands registered globally')
  }
}

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Bot online as ${c.user.tag}`)
  await registerCommands(c)
})

// ── Slash command handler — /list and /ready ──────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return

  // ── /list ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'list') {
    await interaction.deferReply()
    try {
      const packets = await api('/api/packets?status=received_at_hq')
      if (!packets.length) {
        await interaction.editReply('✅ No packets pending Count & Repack.')
        return
      }
      const lines = packets.map(p =>
        `**#${p.id}** · **${p.team_name}** · received ${fmtDate(p.date_received)}${p.entered_by ? ` · by ${p.entered_by}` : ''}`
      ).join('\n')
      await interaction.editReply(
        `📋 **Packets Pending Count & Repack** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Send a message starting with \`/count 42\` to count a packet`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ── /ready ────────────────────────────────────────────────────────────────
  if (interaction.commandName === 'ready') {
    await interaction.deferReply()
    try {
      const packets = await api('/api/packets?status=counted_and_repacked')
      if (!packets.length) {
        await interaction.editReply('✅ No packets ready to ingest yet.')
        return
      }
      const lines = packets.map(p => {
        let entries = []
        try { entries = JSON.parse(p.factory_entries || '[]') } catch {}
        const info = entries.length
          ? entries.map(e => `${e.factory_name}: ${e.count} cards${e.missing > 0 ? ` (⚠️ ${e.missing} missing)` : ''}`).join(', ')
          : `${p.sd_card_count} cards`
        return `**#${p.id}** · **${p.team_name}** · ${info} · 📦 ${p.num_packages || 1} pkg`
      }).join('\n')
      await interaction.editReply(
        `🚀 **Packets Ready to Ingest** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Send \`/collect 42\` to collect a packet`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }
})

// ── Channel name config ───────────────────────────────────────────────────────
const CH_ARRIVAL  = 'arrival'         // only /arrival allowed here
const CH_COUNT    = 'count_repack'    // only /count allowed here
const CH_COLLECT  = 'ready_to_ingest' // only /collect allowed here

// ── Message command handler ───────────────────────────────────────────────────
// Handles: /arrival, /count <id>, /collect <id>
// Photos can be attached to the SAME message — no need to reply separately.
// Also handles reply-with-photos as a fallback (photoPending map).
const photoPending = new Map() // replyMsgId → { packetId, type }

client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return

  const text  = msg.content.trim()
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return

  const first = lines[0]

  // ══════════════════════════════════════════════════════════════════════════
  // /arrival
  // Template:
  //   /arrival
  //   Team: Dukaan
  //   Received by: Naresh
  //   Phone: 9876543210        (optional)
  //   Date: 2026-04-25         (optional, defaults to today)
  // ══════════════════════════════════════════════════════════════════════════
  if (first.toLowerCase() === '/arrival') {
    if (msg.channel.name !== CH_ARRIVAL) {
      await msg.reply(`❌ Use \`/arrival\` only in the **#${CH_ARRIVAL}** channel.`)
      return
    }
    const kv          = parseKV(lines.slice(1))
    const team_name   = kv['team'] || kv['team_name']
    const received_by = kv['received_by'] || kv['received by'] || kv['by']
    const phone       = kv['phone'] || kv['whatsapp'] || ''
    const date_raw    = kv['date'] || kv['received_date'] || kv['date_received'] || ''
    const date        = date_raw || today()

    if (!team_name || !received_by) {
      await msg.reply(
        `❌ Missing required fields.\n\n**Format:**\n\`\`\`\n/arrival\nTeam: Dukaan\nReceived by: Naresh\nPhone: 9876543210\nDate: 2026-04-25\n\`\`\`\n_(Phone and Date are optional)_`
      )
      return
    }

    try {
      // Download attached photos immediately (if any)
      const photos = await extractPhotos(msg)

      const packet = await api('/api/packets', {
        method: 'POST',
        body: JSON.stringify({
          team_name,
          received_date: date,
          entered_by:    received_by,
          poc_phones:    phone,
          photo_urls:    photos.length ? JSON.stringify(photos) : null,
        }),
      })

      const photoNote = photos.length
        ? `📸 ${photos.length} photo(s) saved.`
        : `📸 Reply to this message with photos to attach them.`

      const reply = await msg.reply(
        `✅ **Packet #${packet.id} logged!**\n` +
        `📦 Team: **${team_name}** · Received by: **${received_by}**` +
        (phone ? ` · 📱 ${phone}` : '') +
        ` · 📅 ${fmtDate(date)}\n\n` +
        photoNote + `\n\n` +
        `▶️ Use \`/list\` to see all pending packets`
      )

      if (!photos.length) {
        photoPending.set(reply.id, { packetId: packet.id, type: 'arrival' })
        setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
      }
    } catch (err) {
      await msg.reply(`❌ Failed to log arrival: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /count <id>
  // Template:
  //   /count 42
  //   Dyna Fashion | 2026-04-25 | 192 | 3 | 2
  //   Attire       | 2026-04-25 | 37  | 0 | 1
  //   (any number of factory lines...)
  //   Counted by: Naresh
  //   Notes: optional condition notes
  // ══════════════════════════════════════════════════════════════════════════
  const countMatch = first.match(/^\/count\s+(\d+)/i)
  if (countMatch) {
    if (msg.channel.name !== CH_COUNT) {
      await msg.reply(`❌ Use \`/count\` only in the **#${CH_COUNT}** channel.`)
      return
    }
    const packetId       = Number(countMatch[1])
    const factory_entries = []
    const parseErrors     = []
    let counted_by        = ''
    let notes             = ''

    for (const line of lines.slice(1)) {
      if (line.toLowerCase().startsWith('counted by:') || line.toLowerCase().startsWith('counted_by:')) {
        counted_by = line.split(':').slice(1).join(':').trim()
        continue
      }
      if (line.toLowerCase().startsWith('notes:') || line.toLowerCase().startsWith('note:')) {
        notes = line.split(':').slice(1).join(':').trim()
        continue
      }
      if (!line.includes(',')) continue // skip non-factory lines

      const parts          = line.split(',').map(s => s.trim())
      const [factory_name, deployment_date, rawSd, rawMissing, rawPkg] = parts
      const count          = Number(rawSd)      || 0
      const missing        = Number(rawMissing) || 0
      const num_packages   = Number(rawPkg)     || 1

      if (!factory_name || !deployment_date || count <= 0) {
        parseErrors.push(`⚠️ Skipped: \`${line}\``)
        continue
      }
      factory_entries.push({ factory_name, deployment_date, count, missing, num_packages })
    }

    if (!factory_entries.length) {
      await msg.reply(
        `❌ No valid factory lines found.\n\n**Format:**\n\`\`\`\n/count 42\nDyna Fashion, 2026-04-25, 192, 3, 2\nAttire, 2026-04-25, 37, 0, 1\nCounted by: Naresh\nNotes: optional\n\`\`\`\n_Format per factory line: \`Name, YYYY-MM-DD, SD Count, Missing, Packages\`_`
      )
      return
    }

    if (!counted_by) {
      await msg.reply(`❌ Missing **Counted by:** line.\n\nAdd a line like:\`Counted by: Naresh\``)
      return
    }

    const total_sd   = factory_entries.reduce((s, f) => s + f.count, 0)
    const total_pkgs = factory_entries.reduce((s, f) => s + f.num_packages, 0)

    try {
      // Download attached photos immediately (if any)
      const photos = await extractPhotos(msg)

      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'counted_and_repacked',
          event_data: {
            sd_card_count:     total_sd,
            num_packages:      total_pkgs,
            factory_entries,
            condition_notes:   notes || null,
            counted_by,
            repack_photo_urls: photos.length ? photos : [],
          },
        }),
      })

      const factoryLines = factory_entries.map(f =>
        `  🏭 **${f.factory_name}** · 📅 ${f.deployment_date} · 💾 ${f.count} SD` +
        (f.missing > 0 ? ` · ⚠️ ${f.missing} missing` : '') +
        ` · 📦 ${f.num_packages} pkg`
      ).join('\n')

      const photoNote = photos.length
        ? `📸 ${photos.length} photo(s) saved.`
        : `📸 Reply to this message with photos to attach them.`

      const warnBlock = parseErrors.length ? `\n\n${parseErrors.join('\n')}` : ''

      const reply = await msg.reply(
        `✅ **Packet #${packetId} counted & repacked!**\n` +
        `👤 Counted by **${counted_by}** · ${factory_entries.length} factor${factory_entries.length === 1 ? 'y' : 'ies'}\n\n` +
        `${factoryLines}\n\n` +
        `**Total:** 💾 ${total_sd} SD cards · 📦 ${total_pkgs} pkg` +
        warnBlock + `\n\n` +
        photoNote
      )

      if (!photos.length) {
        photoPending.set(reply.id, { packetId, type: 'repack' })
        setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
      }
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // /collect <id>
  // Template:
  //   /collect 42
  //   Assigned to: Aslam
  //   Collected by: Naresh
  // ══════════════════════════════════════════════════════════════════════════
  const collectMatch = first.match(/^\/collect\s+(\d+)/i)
  if (collectMatch) {
    if (msg.channel.name !== CH_COLLECT) {
      await msg.reply(`❌ Use \`/collect\` only in the **#${CH_COLLECT}** channel.`)
      return
    }
    const packetId   = Number(collectMatch[1])
    const kv         = parseKV(lines.slice(1))
    const assigned_to  = kv['assigned_to']  || kv['assigned to']  || kv['assign_to'] || kv['assign to']
    const collected_by = kv['collected_by'] || kv['collected by'] || kv['by']

    if (!assigned_to || !collected_by) {
      await msg.reply(
        `❌ Missing fields.\n\n**Format:**\n\`\`\`\n/collect 42\nAssigned to: Aslam\nCollected by: Naresh\n\`\`\``
      )
      return
    }

    try {
      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'collected_for_ingestion',
          event_data: { collected_by, assigned_to },
        }),
      })

      await msg.reply(
        `✅ **Packet #${packetId} collected!**\n` +
        `👤 Collected by **${collected_by}** · Assigned to **${assigned_to}**\n\n` +
        `🔗 ${TRACKER_URL}`
      )
    } catch (err) {
      await msg.reply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Photo reply fallback — reply to a bot confirmation with images attached
  // ══════════════════════════════════════════════════════════════════════════
  if (msg.reference?.messageId) {
    const pending = photoPending.get(msg.reference.messageId)
    if (!pending) return

    const images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
    if (!images.length) return

    try {
      const statusMsg  = await msg.reply(`⏳ Saving ${images.length} photo(s)…`)
      const base64List = await Promise.all(images.map(toBase64))
      const { packetId, type } = pending

      await api(`/api/packets/${packetId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'update_photos',
          ...(type === 'repack'
            ? { repack_photo_urls: JSON.stringify(base64List) }
            : { photo_urls: JSON.stringify(base64List) }
          ),
        }),
      })

      photoPending.delete(msg.reference.messageId)
      await statusMsg.edit(`✅ ${images.length} photo(s) saved to packet #${packetId}!`)
    } catch (err) {
      await msg.reply(`❌ Failed to save photos: ${err.message}`)
    }
  }
})

client.login(process.env.DISCORD_TOKEN)
