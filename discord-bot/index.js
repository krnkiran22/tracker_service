require('dotenv').config()

const { Client, GatewayIntentBits, Events } = require('discord.js')

const BACKEND_URL = process.env.BACKEND_URL || 'https://trackerservice-production.up.railway.app'

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
})

// ── Ready ──────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, (c) => {
  console.log(`✅ Bot online as ${c.user.tag}`)
})

// ── Message handler ────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async (msg) => {
  // Ignore messages from bots
  if (msg.author.bot) return

  // Only respond when bot is mentioned
  if (!msg.mentions.has(client.user)) return

  const displayName = msg.member?.displayName || msg.author.username
  const content = msg.content
    .replace(`<@${client.user.id}>`, '')  // strip the @mention
    .replace(`<@!${client.user.id}>`, '') // strip alternate mention format
    .trim()
    .toLowerCase()

  // ── Hi / Hello test ───────────────────────────────────────────────────────
  if (content === 'hi' || content === 'hello' || content === 'hey') {
    await msg.reply(`👋 Hi **${displayName}**! SD Tracker bot is online and ready.`)
    return
  }

  // ── Help ──────────────────────────────────────────────────────────────────
  if (content === 'help' || content === '') {
    await msg.reply(
      `**SD Tracker Bot Commands** (always tag me first)\n\n` +
      `👋 \`@bot hi\` — test if bot is online\n` +
      `📦 \`@bot arrival TeamName | ReceivedBy | PhoneNumber\` — log a new SD card arrival\n\n` +
      `**Arrival example:**\n` +
      `\`@bot arrival Greybeez | Naresh | 9876543210\`\n` +
      `Phone number is optional.`
    )
    return
  }

  // ── Arrival log ───────────────────────────────────────────────────────────
  if (content.startsWith('arrival')) {
    const rest = content.replace('arrival', '').trim()
    const parts = rest.split('|').map(s => s.trim())
    const [team_name, received_by, phone] = parts

    if (!team_name || !received_by) {
      await msg.reply(
        `❌ Wrong format. Use:\n` +
        `\`@bot arrival TeamName | ReceivedBy | PhoneNumber\`\n\n` +
        `Example: \`@bot arrival Greybeez | Naresh | 9876543210\`\n` +
        `You can also attach photos directly to the message.`
      )
      return
    }

    // ── Download attachments and convert to base64 ──────────────────────────
    const attachments = [...msg.attachments.values()].filter(a =>
      a.contentType?.startsWith('image/')
    )

    let photoBase64List = []
    if (attachments.length > 0) {
      const processingMsg = await msg.reply(`⏳ Downloading ${attachments.length} photo(s)…`)
      try {
        photoBase64List = await Promise.all(
          attachments.map(async (att) => {
            const res = await fetch(att.url)
            const buffer = await res.arrayBuffer()
            const base64 = Buffer.from(buffer).toString('base64')
            const mime = att.contentType || 'image/jpeg'
            return `data:${mime};base64,${base64}`
          })
        )
        await processingMsg.delete().catch(() => {})
      } catch (err) {
        await processingMsg.edit(`⚠️ Failed to download photos: ${err.message}. Logging without photos.`)
        photoBase64List = []
      }
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/packets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_name,
          received_date: new Date().toISOString().slice(0, 10),
          entered_by: received_by,
          poc_phones: phone || '',
          photo_urls: photoBase64List.length > 0 ? JSON.stringify(photoBase64List) : null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Unknown error')

      await msg.reply(
        `✅ **Arrival logged!**\n` +
        `📦 Packet **#${data.id}** — **${team_name}**\n` +
        `👤 Received by **${received_by}**` +
        (phone ? `\n📱 ${phone}` : '') +
        (photoBase64List.length > 0 ? `\n🖼️ ${photoBase64List.length} photo(s) saved` : '\n📷 No photos attached') +
        `\n\n🔗 https://sd-tracker.vercel.app/logistics/log-arrival`
      )
    } catch (err) {
      await msg.reply(`❌ Failed to log arrival: ${err.message}`)
    }
    return
  }

  // ── Unknown command ───────────────────────────────────────────────────────
  await msg.reply(
    `I didn't understand that. Tag me with \`@bot help\` to see available commands.`
  )
})

client.login(process.env.DISCORD_TOKEN)
