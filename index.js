require('dotenv').config()

const http = require('http')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')

const PHONE_NUMBER = process.env.PHONE_NUMBER || ''
const PORT = process.env.PORT || 3000

// Si un volume Railway est monté, on y stocke la session pour qu'elle survive aux redéploiements
const AUTH_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? `${process.env.RAILWAY_VOLUME_MOUNT_PATH}/auth_info`
  : (process.env.AUTH_DIR || 'auth_info')

let botStatus = 'starting'
let lastPairingCode = null

// Petit serveur HTTP pour le healthcheck Railway et le suivi du statut
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    bot: 'Telopex WhatsApp Bot',
    status: botStatus,
    pairingCode: botStatus === 'pairing' ? lastPairingCode : undefined,
  }))
}).listen(PORT, () => console.log(`🌐 Healthcheck sur le port ${PORT}`))

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

async function requestPairingCodeWithRetry(sock, phoneNumber, attempt = 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000))
  try {
    const code = await sock.requestPairingCode(phoneNumber)
    botStatus = 'pairing'
    lastPairingCode = code
    console.log(`🔑 Code de pairage : ${code}`)
    console.log('➡️  Sur votre téléphone : WhatsApp > Paramètres > Appareils connectés > Connecter un appareil > Connecter avec un numéro de téléphone, puis entrez ce code dans les ~60 secondes.')
  } catch (err) {
    if (attempt < 6) {
      console.log(`⏳ Connexion en cours... nouvelle tentative (${attempt}/5)`)
      await requestPairingCodeWithRetry(sock, phoneNumber, attempt + 1)
    } else {
      console.error('❌ Impossible d\'obtenir le code de pairage :', err.message || err)
    }
  }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)

  let phoneNumber = null
  if (!state.creds.registered) {
    if (!PHONE_NUMBER) {
      console.error('❌ Aucune session existante et la variable d\'environnement PHONE_NUMBER n\'est pas définie.')
      console.error('   Définis PHONE_NUMBER (ex: 2250102030405, sans + ni espaces) pour générer un code de pairage.')
      return
    }
    phoneNumber = PHONE_NUMBER.trim()
  }

  const { version } = await fetchLatestBaileysVersion()
  console.log(`📦 Version Baileys/WA utilisée : ${version.join('.')}`)

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
  })

  sock.ev.on('creds.update', saveCreds)

  if (phoneNumber) {
    requestPairingCodeWithRetry(sock, phoneNumber)
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      const isLoggedOut = statusCode === DisconnectReason.loggedOut
      // Pendant le pairing, un "loggedOut" (401) signifie juste que le code a expiré :
      // on relance pour en générer un nouveau, tant que le compte n'a jamais été lié.
      const wasNeverPaired = !state.creds.registered
      const shouldReconnect = !isLoggedOut || wasNeverPaired

      if (isLoggedOut && wasNeverPaired) {
        botStatus = 'pairing'
        console.log('⏳ Code de pairage expiré, génération d\'un nouveau code...')
      } else {
        botStatus = shouldReconnect ? 'reconnecting' : 'logged_out'
        console.log('Connexion fermée. Reconnexion :', shouldReconnect)
      }

      if (shouldReconnect) setTimeout(() => startBot(), 2000)
    } else if (connection === 'open') {
      botStatus = 'connected'
      lastPairingCode = null
      console.log('✅ Telopex Bot WhatsApp connecté !')
    } else if (connection === 'connecting') {
      botStatus = 'connecting'
    }
  })

  const startTimestamp = Math.floor(Date.now() / 1000)

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue
      if (!msg.message) continue

      const ts = Number(msg.messageTimestamp?.toNumber?.() ?? msg.messageTimestamp ?? 0)
      // Ignore les messages reçus plus d'1 minute avant le démarrage du bot (évite de répondre à tout l'historique)
      if (ts < startTimestamp - 60) continue

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
