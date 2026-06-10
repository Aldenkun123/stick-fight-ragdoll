# 🥊 Stick Fight — Ragdoll Physics Arena

Game pertarungan stickman 2D berbasis fisika nyata, terinspirasi *Stick Fight: The Game*. Dibangun dengan **[Matter.js](https://brm.io/matter-js/)** — engine rigid-body 2D terbaik untuk web — dan dirender di `<canvas>` murni. Tanpa build step, 100% statis, siap di-deploy ke Vercel.

![engine](https://img.shields.io/badge/engine-Matter.js-ffd23f) ![type](https://img.shields.io/badge/100%25-static-blue) ![deploy](https://img.shields.io/badge/deploy-Vercel-black)

## 🎮 Cara Main

| Aksi | Player 1 (Kuning) | Player 2 (Merah) |
|------|------------------|------------------|
| Jalan | `A` / `D` | `←` / `→` |
| Lompat | `W` | `↑` |
| Turun / Ambil senjata | `S` | `↓` |
| Tembak / Pukul | `Space` | `Enter` |

- Pilih **1 Player** (lawan bot) atau **2 Players** di menu.
- Senjata (pistol, rifle, shotgun) berjatuhan dari langit — rebut dan gunakan.
- Jatuhkan lawan dari arena atau habiskan nyawanya. **First to 5** memenangkan match.
- `P` = pause, `R` = ulang ronde.

## 🔬 Simulasi Fisika

Semua poin di bawah disimulasikan oleh engine, bukan animasi palsu:

1. **Ragdoll Physics** — saat KO, tubuh stickman pecah menjadi 10 rigid-body (kepala, torso, lengan atas/bawah, paha/betis) yang terhubung lewat `Constraint`. Tiap anggota tubuh jatuh & bertumbukan secara independen.
2. **Gravitasi & Gerak Jatuh Bebas** — `engine.gravity` menarik semua benda; karakter & objek jatuh natural.
3. **Momentum & Impuls** — hit/tembakan memakai `Body.applyForce`, terpental sebanding gaya yang diterima.
4. **Tumbukan (Collision)** — collision filter & `restitution` membedakan tumbukan elastis vs tidak elastis antara karakter, peluru, senjata, dan platform.
5. **Gaya Reaksi (Newton III)** — menembak memberi *recoil* (impuls ke arah berlawanan) pada penembak.
6. **Torsi & Rotasi** — ragdoll menerima `angularVelocity` dan berputar di udara sesuai momen inersia.

## 📁 Struktur

```
.
├── index.html        # markup + menu/overlay
├── css/style.css     # tampilan & UI
├── js/game.js        # seluruh logika game + fisika (Matter.js)
├── vercel.json       # konfigurasi static hosting
└── package.json
```

Matter.js dimuat via CDN di `index.html`, jadi tidak perlu `npm install`.

## 🚀 Jalankan Lokal

Karena 100% statis, cukup buka `index.html` di browser. Atau jalankan server lokal:

```bash
npx serve .
# atau
python3 -m http.server 8000
```

## ☁️ Deploy ke Vercel

### Lewat dashboard (paling mudah)
1. Push repo ini ke GitHub.
2. Buka [vercel.com/new](https://vercel.com/new) → **Import** repo.
3. Framework Preset: **Other**. Build Command: kosongkan. Output Directory: `.` (root).
4. **Deploy** — selesai. ✨

### Lewat CLI
```bash
npm i -g vercel
vercel        # preview
vercel --prod # production
```

## 🛠 Push ke GitHub

```bash
git init
git add .
git commit -m "Stick Fight ragdoll physics arena"
git branch -M main
git remote add origin https://github.com/<username>/<repo>.git
git push -u origin main
```

## 📜 Lisensi

MIT — bebas dipakai & dimodifikasi.
