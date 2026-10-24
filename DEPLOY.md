# JARVIS-X — Deploy & Access

Ye app **bina kisi API key, bina login, bina credit card** ke chalta hai.
Guest mode mein Supabase ki zarurat nahi — poori cheez ephemeral session mein chalti hai.

---

## 1. Sabse aasan tareeka — Vercel par 1-click deploy

Repo public hai, Next.js 14 hai, koi env var required nahi.

### Steps (2 minute)

1. Neeche wale link par click kijiye — **Deploy with Vercel**
2. GitHub se sign in kariye (aapka account already hai)
3. Kuch bhi configure mat kijiye — koi environment variable nahi chahiye
4. **Deploy** dabaiye
5. ~2 minute mein aapko ek URL milega jaise:
   `https://jarvis-x-yourname.vercel.app`

**Wahi URL aapke phone par hamesha khulega.**

Deploy links:

```
https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fng273499-svg%2FMy-2
```

Branch select karne ke liye (agar default branch purani hai):

```
https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fng273499-svg%2FMy-2&repository-name=jarvis-x&ref=arena%2Fac3be879-my-2
```

---

## 2. Apne computer par chalana

```bash
git clone https://github.com/ng273499-svg/My-2.git
cd My-2
npm install
npm run build
npm start
```

Phir browser mein kholiye:

```
http://localhost:3000
```

---

## Routes

| Route | Kya hai |
|---|---|
| `/` | JARVIS chat (landing page) |
| `/chat` | Same chat surface (alias) |
| `/dashboard` | Full command HUD (runtime telemetry, specialists, research, engineering) |

---

## Environment variables — sab optional hain

App **in sab ke bina** chalta hai. Sirf tab dijiye jab aapko wo feature chahiye.

| Variable | Bina iske kya hota hai |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PROJECT_REF` | Ephemeral in-memory session. Login nahi, data persist nahi. **App phir bhi chalta hai.** |
| `SPEECH_STT_PROVIDER_URL`, `SPEECH_TTS_PROVIDER_URL` | Voice features UNCONFIGURED — chat text par kaam karta hai |
| `VISION_PROVIDER_MODEL` | Vision UNCONFIGURED |
| `JARVIS_STEP_UP_PASSCODE` | Owner-only privileged actions locked |

> `.env.local` **kabhi commit mat kariye** — `.gitignore` mein already covered hai.

---

## Abhi kaun sa model chal raha hai?

Default mein **`jarvis-foundation`** — ek deterministic, zero-cost, local engine
(`Foundation Deterministic Core v0.4`). Ye koi external AI API nahi call karta.

OpenAI / Anthropic / Gemini providers code mein registered hain lekin
**UNCONFIGURED** hain — jab tak aap unki key nahi dete, app saaf-saaf
batata hai ki wo available nahi hain. Koi fake capability claim nahi hota.

---

## Deploy ke baad check kariye

- `/` par chat screen khule
- Kuch type karke Enter dabaiye
- Jawab ke neeche `Foundation Deterministic Core v0.4` aur `verified` dikhe
