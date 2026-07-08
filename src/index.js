import { VALID_BENTUK, syncBatch } from './sync.js';

export default {
  /** Trigger API dan Dashboard UI */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Dashboard UI
    if (url.pathname === '/' || url.pathname === '') {
      try {
        // Ambil status dari D1
        const { results } = await env.DB.prepare(
          'SELECT bentuk_aktif, offset_terakhir, waktu_selesai_terakhir FROM status_sinkronisasi WHERE id = 1'
        ).all();
        
        let row = results?.[0] || { bentuk_aktif: 'tk', offset_terakhir: 0 };
        
        const bentukBerikutnya = row.bentuk_aktif;
        const offsetBerikutnya = row.offset_terakhir;
        
        const currentIndex = VALID_BENTUK.indexOf(bentukBerikutnya);
        const progressPercent = Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));
        const selesai = bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && row.waktu_selesai_terakhir !== null && progressPercent === 0;

        const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sekolah Sync Dashboard (D1)</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', sans-serif;
      background: radial-gradient(circle at top left, #12131a, #0b0c10);
      color: #e5e7eb;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0; padding: 16px;
    }
    .card {
      background: rgba(255, 255, 255, 0.03); backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 24px;
      padding: 40px; width: 100%; max-width: 450px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5); text-align: center; margin: auto;
    }
    h1 {
      margin-top: 0; font-size: 24px;
      background: linear-gradient(135deg, #6366f1, #a855f7);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .status-badge {
      display: inline-block; padding: 6px 16px; border-radius: 9999px;
      font-size: 14px; font-weight: 600;
      background: rgba(99, 102, 241, 0.15); color: #818cf8; margin-bottom: 24px;
    }
    .status-badge.finished {
      background: rgba(34, 197, 94, 0.15); color: #4ade80;
    }
    .progress-bar {
      height: 6px; background: rgba(255, 255, 255, 0.05);
      border-radius: 9999px; overflow: hidden; margin-top: 24px;
    }
    .progress-fill {
      height: 100%; background: linear-gradient(90deg, #6366f1, #a855f7);
      width: ${selesai ? 100 : progressPercent}%; transition: width 0.3s;
    }
    .loader {
      width: 48px; height: 48px; border: 5px solid #fff;
      border-bottom-color: transparent; border-radius: 50%;
      display: inline-block; box-sizing: border-box;
      animation: rotation 1s linear infinite; margin-bottom: 20px;
    }
    @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
  </style>
  <meta http-equiv="refresh" content="5">
</head>
<body>
  <div class="card">
    <div id="loader-icon" class="loader" style="${selesai ? 'display: none;' : ''}"></div>
    <div id="status" class="status-badge ${selesai ? 'finished' : ''}">
      ${selesai ? 'Selesai 100%' : 'Menyinkronkan Data...'}
    </div>
    <h1>Sekolah Sync Dashboard</h1>
    <div style="font-size: 15px; color: #d1d5db;">
      Bentuk Aktif: <strong style="color: #818cf8; text-transform: uppercase;">${bentukBerikutnya}</strong><br>
      Offset Saat Ini: <strong>${offsetBerikutnya}</strong>
    </div>
    
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    <div style="font-size: 12px; color: #6b7280; margin-top: 24px;">Halaman akan refresh tiap 5 detik otomatis</div>
  </div>
</body>
</html>`;
        return new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      } catch (err) {
        return new Response('Database error: ' + err.message, { status: 500 });
      }
    }

    // Endpoint untuk menerima data dari GitHub Actions
    if (url.pathname === '/sync-batch' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const body = await request.json();
        const { dataList, bentukAktif, offset, isFinished } = body;

        // Pastikan tabel ada (Opsional, karena user bilang data sudah migrasi)
        // Tapi kita pastikan status_sinkronisasi tetap diupdate.
        
        let stats = { baru: 0, diperbarui: 0, tidakBerubah: 0 };
        
        if (dataList && dataList.length > 0) {
          stats = await syncBatch(env.DB, dataList);
        }

        if (isFinished) {
          await env.DB.prepare(`
            UPDATE status_sinkronisasi 
            SET bentuk_aktif = 'tk', offset_terakhir = 0, waktu_selesai_terakhir = CURRENT_TIMESTAMP 
            WHERE id = 1
          `).run();
        } else {
          await env.DB.prepare(`
            UPDATE status_sinkronisasi 
            SET bentuk_aktif = ?, offset_terakhir = ? 
            WHERE id = 1
          `).bind(bentukAktif, offset).run();
        }

        return Response.json({ ok: true, stats });
      } catch (err) {
        return Response.json(
          { ok: false, error: err.message },
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
      }
    }
    
    // Endpoint check state (optional, dipanggil GH Action sebelum start)
    if (url.pathname === '/state' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT bentuk_aktif, offset_terakhir FROM status_sinkronisasi WHERE id = 1').all();
      return Response.json(results?.[0] || { bentuk_aktif: 'tk', offset_terakhir: 0 });
    }

    return new Response('Not found', { status: 404 });
  },
};
