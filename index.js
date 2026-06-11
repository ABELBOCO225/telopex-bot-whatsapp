require('dotenv').config()

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')

const GEMINI_KEY = process.env.GEMINI_KEY || ''
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_KEY}`

const SYSTEM_PROMPT = `Tu es l'assistant virtuel de Telopex, une agence digitale basée à Abidjan, Côte d'Ivoire.
Tu réponds en français, de façon naturelle et professionnelle. Maximum 3 phrases.
Services : bots IA multi-canaux, automation, développement web, formations.
Contact : contact@telopex.online | WhatsApp : +225 89 15 67 54 | Site : telopex.online
Règles : Ne pas inventer de prix. Pour les devis, orienter vers contact@telopex.online.`

const userHistories = {}

async function askGemini(userId, text) {
  if (!userHistories[userId]) userHistories[userId] = []
  const history = userHistories[userId]

  const contents = [
    { role: 'user',  parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Compris ! Je suis l\'assistant Telopex.' }] },
    ...history.slice(-8).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    })),
    { role: 'user', parts: [{ text }] }
  ]

  const res  = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      generationConfig: { maxOutputTokens: 300, temperature: 0.7 }
    })
  })

  const data  = await res.json()
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
    || 'Désolé, je n\'ai pas pu répondre. Contactez contact@telopex.online'

  history.push({ role: 'user',      content: text })
  history.push({ role: 'assistant', content: reply })
  if (history.length > 20) userHistories[userId] = history.slice(-20)

  return reply
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (connection === 'close') {
      const shouldReconnect = new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut
      console.log('Connexion fermée. Reconnexion :', shouldReconnect)
      if (shouldReconnect) startBot()
    } else if (connection === 'open') {
      console.log('✅ Telopex Bot WhatsApp connecté !')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const from    = msg.key.remoteJid
      const text    = msg.message.conversation
        || msg.message.extendedTextMessage?.text
        || ''

      if (!text) continue

      console.log(`[${from}] ${text}`)

      if (text === '/start' || text.toLowerCase() === 'bonjour') {
        await sock.sendMessage(from, {
          text: '👋 Bonjour ! Je suis l\'assistant *Telopex*. ⚡\n\nComment puis-je vous aider aujourd\'hui ?'
        })
        continue
      }

      if (text === '/reset') {
        userHistories[from] = []
        await sock.sendMessage(from, { text: '🔄 Conversation réinitialisée !' })
        continue
      }

      try {
        const reply = await askGemini(from, text)
        await sock.sendMessage(from, { text: reply })
        console.log(`[Telopex] ${reply}`)
      } catch (err) {
        console.error('Erreur:', err)
        await sock.sendMessage(from, {
          text: 'Désolé, une erreur est survenue. Contactez contact@telopex.online'
        })
      }
    }
  })
}

startBot().catch(console.error)
