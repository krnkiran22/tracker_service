require('dotenv').config()

const {
  Client, GatewayIntentBits, Events,
  REST, Routes,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
} = require('discord.js')

const CLIENT_ID  = process.env.CLIENT_ID  || '1497976137345667173'
const BACKEND    = process.env.BACKEND_URL || 'https://trackerservice-production.up.railway.app'
const TRACKER_URL = 'https://sd-tracker.vercel.app'

// In-memory: reply messageId → { packetId, type: 'arrival' | 'repack' }
const photoPending = new Map()

// ── API helper ────────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
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

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

// ── Slash command definitions ─────────────────────────────────────────────────
const COMMANDS = [
  {
    name: 'arrival',
    description: '📦 Log a new SD card packet arrival',
  },
  {
    name: 'list',
    description: '📋 List all packets pending Count & Repack',
  },
  {
    name: 'count',
    description: '✅ Count and repack a packet',
    options: [{
      name: 'id',
      description: 'Packet ID (from /list)',
      type: 4,      // INTEGER
      required: true,
    }],
  },
  {
    name: 'ready',
    description: '🚀 Show all packets ready to ingest',
  },
  {
    name: 'collect',
    description: '📤 Collect a packet for ingestion',
    options: [{
      name: 'id',
      description: 'Packet ID (from /ready)',
      type: 4,
      required: true,
    }],
  },
]

async function registerCommands(client) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN)
  // Register to every guild the bot is in — takes effect instantly
  const guilds = client.guilds.cache.map(g => g.id)
  for (const guildId of guilds) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, guildId), { body: COMMANDS })
    console.log(`✅ Slash commands registered in guild ${guildId}`)
  }
  if (!guilds.length) {
    // Fallback to global if no guilds found
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

// ── Interaction handler ───────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  // ════════════════════════════════════════════════════════════
  // /arrival  →  show modal
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand() && interaction.commandName === 'arrival') {
    const modal = new ModalBuilder()
      .setCustomId('modal_arrival')
      .setTitle('📦 Log New SD Card Arrival')

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('team_name')
          .setLabel('Team Name *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Greybeez')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('received_by')
          .setLabel('Received By *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Naresh')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('phone')
          .setLabel('WhatsApp Number (10 digits)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 9876543210')
          .setRequired(false)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('received_date')
          .setLabel('Date Received (YYYY-MM-DD, blank=today)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(today())
          .setRequired(false)
      ),
    )

    await interaction.showModal(modal)
    return
  }

  // ════════════════════════════════════════════════════════════
  // modal_arrival  →  save packet
  // ════════════════════════════════════════════════════════════
  if (interaction.isModalSubmit() && interaction.customId === 'modal_arrival') {
    await interaction.deferReply()

    const team_name     = interaction.fields.getTextInputValue('team_name').trim()
    const received_by   = interaction.fields.getTextInputValue('received_by').trim()
    const phone         = interaction.fields.getTextInputValue('phone').trim()
    const date_raw      = interaction.fields.getTextInputValue('received_date').trim()
    const received_date = date_raw || today()

    try {
      const packet = await api('/api/packets', {
        method: 'POST',
        body: JSON.stringify({
          team_name,
          received_date,
          entered_by: received_by,
          poc_phones:  phone || '',
          photo_urls:  null,
        }),
      })

      const reply = await interaction.editReply(
        `✅ **Packet #${packet.id} logged!**\n` +
        `📦 **${team_name}** · received by **${received_by}**` +
        (phone ? ` · 📱 ${phone}` : '') + '\n\n' +
        `📸 **Reply to this message with photos** of the packet to attach them.\n` +
        `_(or skip if no photos)_`
      )

      photoPending.set(reply.id, { packetId: packet.id, type: 'arrival' })
      setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
    } catch (err) {
      await interaction.editReply(`❌ Failed to log arrival: ${err.message}`)
    }
    return
  }

  // ════════════════════════════════════════════════════════════
  // /list  →  show pending packets
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand() && interaction.commandName === 'list') {
    await interaction.deferReply()
    try {
      const packets = await api('/api/packets?status=received_at_hq')
      if (!packets.length) {
        await interaction.editReply('✅ No packets pending Count & Repack. All clear!')
        return
      }

      const lines = packets.map(p =>
        `**#${p.id}** · **${p.team_name}** · received ${fmtDate(p.date_received)}${p.entered_by ? ` · by ${p.entered_by}` : ''}`
      ).join('\n')

      await interaction.editReply(
        `📋 **Packets Pending Count & Repack** (${packets.length})\n\n${lines}\n\n` +
        `▶️ Use \`/count id:<ID>\` to count a packet`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ════════════════════════════════════════════════════════════
  // /count <id>  →  show modal
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand() && interaction.commandName === 'count') {
    const packetId = interaction.options.getInteger('id')

    const modal = new ModalBuilder()
      .setCustomId(`modal_count_${packetId}`)
      .setTitle(`✅ Count & Repack — Packet #${packetId}`)

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('factory')
          .setLabel('Factory Name *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Dyna Fashion')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('deploy_date')
          .setLabel('Deployment Date * (YYYY-MM-DD)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(today())
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('counts')
          .setLabel('SD Count / Missing / Packages (192|3|2)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('192 | 0 | 1')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('counted_by')
          .setLabel('Counted By *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Naresh')
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes')
          .setLabel('Condition Notes (optional)')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Any notes about card condition…')
          .setRequired(false)
      ),
    )

    await interaction.showModal(modal)
    return
  }

  // ════════════════════════════════════════════════════════════
  // modal_count submit  →  save event
  // ════════════════════════════════════════════════════════════
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_count_')) {
    await interaction.deferReply()
    const packetId    = Number(interaction.customId.replace('modal_count_', ''))
    const factory     = interaction.fields.getTextInputValue('factory').trim()
    const deploy_date = interaction.fields.getTextInputValue('deploy_date').trim()
    const counted_by  = interaction.fields.getTextInputValue('counted_by').trim()
    const notes       = interaction.fields.getTextInputValue('notes').trim()

    // Parse "192 | 3 | 2" → sd_count=192, missing=3, packages=2
    const parts      = interaction.fields.getTextInputValue('counts').split('|').map(s => Number(s.trim()) || 0)
    const sd_count   = parts[0] || 0
    const missing    = parts[1] || 0
    const num_pkgs   = parts[2] || 1

    if (!sd_count) {
      await interaction.editReply('❌ SD Card Count must be greater than 0.')
      return
    }

    try {
      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'counted_and_repacked',
          event_data: {
            sd_card_count:    sd_count,
            num_packages:     num_pkgs,
            factory_name:     factory,
            deployment_date:  deploy_date,
            factory_entries:  [{ factory_name: factory, deployment_date: deploy_date, count: sd_count, missing }],
            condition_notes:  notes || null,
            counted_by,
            repack_photo_urls: [],
          },
        }),
      })

      const reply = await interaction.editReply(
        `✅ **Packet #${packetId} counted & repacked!**\n` +
        `🏭 **${factory}** · 📅 ${deploy_date}\n` +
        `💾 **${sd_count}** SD cards` +
        (missing > 0 ? ` · ⚠️ ${missing} missing` : '') +
        ` · 📦 ${num_pkgs} package(s)\n` +
        `👤 Counted by **${counted_by}**\n\n` +
        `📸 **Reply with packed photos** to attach them.\n_(or skip if no photos)_`
      )

      photoPending.set(reply.id, { packetId, type: 'repack' })
      setTimeout(() => photoPending.delete(reply.id), 15 * 60 * 1000)
    } catch (err) {
      await interaction.editReply(`❌ Failed: ${err.message}`)
    }
    return
  }

  // ════════════════════════════════════════════════════════════
  // /ready  →  show counted packets
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand() && interaction.commandName === 'ready') {
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
        `▶️ Use \`/collect id:<ID>\` to collect a packet`
      )
    } catch (err) {
      await interaction.editReply(`❌ ${err.message}`)
    }
    return
  }

  // ════════════════════════════════════════════════════════════
  // /collect <id>  →  show modal with ingestion person list
  // ════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand() && interaction.commandName === 'collect') {
    const packetId = interaction.options.getInteger('id')

    // Fetch real ingestion users from DB
    let userHint = 'e.g. Naresh'
    try {
      const users = await api('/api/admin/users?roles=ingestion,ingestion_lead')
      if (users.length) userHint = users.map(u => u.name).join(', ')
    } catch {}

    const modal = new ModalBuilder()
      .setCustomId(`modal_collect_${packetId}`)
      .setTitle(`📤 Collect Packet #${packetId}`)

    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('assigned_to')
          .setLabel('Assign to Ingestion Person *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(userHint.slice(0, 100))
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('collected_by')
          .setLabel('Collected By (your name) *')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(interaction.member?.displayName || interaction.user.username)
          .setRequired(true)
      ),
    )

    await interaction.showModal(modal)
    return
  }

  // ════════════════════════════════════════════════════════════
  // modal_collect submit  →  save event
  // ════════════════════════════════════════════════════════════
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_collect_')) {
    await interaction.deferReply()
    const packetId    = Number(interaction.customId.replace('modal_collect_', ''))
    const assigned_to = interaction.fields.getTextInputValue('assigned_to').trim()
    const collected_by = interaction.fields.getTextInputValue('collected_by').trim()

    try {
      await api(`/api/packets/${packetId}/events`, {
        method: 'POST',
        body: JSON.stringify({
          event_type: 'collected_for_ingestion',
          event_data: { collected_by, assigned_to },
        }),
      })

      await interaction.editReply(
        `✅ **Packet #${packetId} collected!**\n` +
        `👤 Collected by **${collected_by}**\n` +
        `➡️ Assigned to **${assigned_to}**\n\n` +
        `🔗 ${TRACKER_URL}`
      )
    } catch (err) {
      await interaction.editReply(`❌ Failed: ${err.message}`)
    }
    return
  }
})

// ── Photo reply handler ───────────────────────────────────────────────────────
// When user replies to a bot confirmation message with photos attached
client.on(Events.MessageCreate, async (msg) => {
  if (msg.author.bot) return
  if (!msg.reference?.messageId) return

  const pending = photoPending.get(msg.reference.messageId)
  if (!pending) return

  const images = [...msg.attachments.values()].filter(a => a.contentType?.startsWith('image/'))
  if (!images.length) return

  try {
    const statusMsg = await msg.reply(`⏳ Saving ${images.length} photo(s)…`)
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
})

client.login(process.env.DISCORD_TOKEN)
