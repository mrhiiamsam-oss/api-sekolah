import { runSync, VALID_BENTUK } from './sync.js';

/** Sabtu 16:00 UTC = Minggu 00:00 WITA — scan penuh dari offset 0 */
function isJadwalMingguanUtc() {
  const now = new Date();
  return now.getUTCDay() === 6 && now.getUTCHours() === 16 && now.getUTCMinutes() === 0;
}

export default {
  /** Dipanggil otomatis oleh Cloudflare Cron Triggers */
  async scheduled(event, env, ctx) {
    const now = new Date();
    // Kasus jika mingguan (atau harian) bertabrakan dengan tanggal 1 (jadwal bulanan GH Actions)
    if (now.getUTCDate() === 1) {
      console.log('Tanggal 1: Mengutamakan sinkronisasi bulanan dari GitHub Actions. CF Worker rehat.');
      return;
    }

    const mulaiDariAwal = isJadwalMingguanUtc();
    ctx.waitUntil(
      runSync(env, { mulaiDariAwal, maxDurationMs: 28000 }).then((result) => {
        console.log(JSON.stringify(result));
      })
    );
  },

  /** Trigger manual: GET /sync?secret=...&awal=1 */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(
        'Sinkron sekolah → Neon.\n' +
          'Manual Only: GET /sync?secret=CRON_SECRET&awal=0|1\n',
        { headers: { 'content-type': 'text/plain; charset=utf-8' } }
      );
    }

    if (url.pathname !== '/sync') {
      return new Response('Not found', { status: 404 });
    }

    const secret =
      url.searchParams.get('secret') || request.headers.get('x-cron-secret');
    if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    const mulaiDariAwal =
      url.searchParams.get('awal') === '1' ||
      url.searchParams.get('awal') === 'true';

    const wantJson =
      url.searchParams.get('format') === 'json' ||
      (request.headers.get('accept') || '').includes('application/json');

    try {
      const result = await runSync(env, { mulaiDariAwal, maxDurationMs: 22000 });

      if (wantJson) {
        return Response.json(result, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      }

      // Hitung progress percent
      const currentIndex = VALID_BENTUK.indexOf(result.bentukBerikutnya);
      const progressPercent = Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));

      const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sekolah Sync Dashboard</title>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      font-family: 'Inter', sans-serif;
      background: radial-gradient(circle at top left, #12131a, #0b0c10);
      color: #e5e7eb;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
    }
    .card {
      background: rgba(255, 255, 255, 0.03);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 24px;
      padding: 40px;
      width: 100%;
      max-width: 450px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
      text-align: center;
      margin: auto;
    }
    h1 {
      margin-top: 0;
      font-size: 24px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .status-badge {
      display: inline-block;
      padding: 6px 16px;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 600;
      background: rgba(99, 102, 241, 0.15);
      color: #818cf8;
      margin-bottom: 24px;
    }
    .status-badge.finished {
      background: rgba(34, 197, 94, 0.15);
      color: #4ade80;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-top: 24px;
    }
    .stat-box {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.03);
      border-radius: 16px;
      padding: 16px;
    }
    .stat-val {
      font-size: 20px;
      font-weight: 700;
      color: #fff;
    }
    .stat-label {
      font-size: 12px;
      color: #9ca3af;
      margin-top: 4px;
    }
    .progress-bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 9999px;
      overflow: hidden;
      margin-top: 24px;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #6366f1, #a855f7);
      width: ${progressPercent}%;
      transition: width 0.3s;
    }
    .loader {
      width: 48px;
      height: 48px;
      border: 5px solid #fff;
      border-bottom-color: transparent;
      border-radius: 50%;
      display: inline-block;
      box-sizing: border-box;
      animation: rotation 1s linear infinite;
      margin-bottom: 20px;
    }
    @keyframes rotation {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .countdown {
      font-size: 12px;
      color: #6b7280;
      margin-top: 24px;
    }
    @media (max-width: 480px) {
      .card {
        padding: 24px 16px;
        border-radius: 16px;
      }
      h1 {
        font-size: 20px;
      }
      .stat-val {
        font-size: 18px;
      }
      .grid {
        gap: 12px;
        margin-top: 16px;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    <div id="loader-icon" class="loader"></div>
    <div id="status" class="status-badge">Menyinkronkan Data...</div>
    <h1 id="title">Sekolah Sync Dashboard</h1>
    <div id="details" style="font-size: 15px; color: #d1d5db;">
      Bentuk Aktif: <strong style="color: #818cf8; text-transform: uppercase;">${result.bentukBerikutnya}</strong><br>
      Offset Berikutnya: <strong>${result.offsetBerikutnya}</strong>
    </div>
    
    <div class="grid">
      <div class="stat-box">
        <div class="stat-val" style="color: #4ade80;">${result.totalBaru}</div>
        <div class="stat-label">Baru</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color: #60a5fa;">${result.totalDiperbarui}</div>
        <div class="stat-label">Diperbarui</div>
      </div>
      <div class="stat-box" style="grid-column: span 2;">
        <div class="stat-val">${result.totalTidakBerubah}</div>
        <div class="stat-label">Tidak Berubah (Total Halaman Ini)</div>
      </div>
    </div>
    
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    
    <div id="countdown-text" class="countdown">Memuat ulang halaman untuk sinkronisasi berikutnya dalam 1 detik...</div>
  </div>

  <script>
    const selesai = ${result.selesai};
    if (!selesai) {
      setTimeout(() => {
        const nextUrl = new URL(window.location.href);
        nextUrl.searchParams.set('awal', 'false');
        window.location.href = nextUrl.toString();
      }, 1000);
    } else {
      document.getElementById('loader-icon').style.display = 'none';
      document.getElementById('status').className = 'status-badge finished';
      document.getElementById('status').innerText = 'Selesai 100%';
      document.getElementById('countdown-text').innerText = 'Sinkronisasi telah selesai sepenuhnya!';
      document.getElementById('countdown-text').style.color = '#4ade80';
    }
  </script>
</body>
</html>`;

      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: err.message },
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  },
};
