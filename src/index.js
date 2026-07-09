import { VALID_BENTUK, syncBatch } from './sync.js';

export default {
  /** Trigger API dan Dashboard UI */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Dashboard UI
    if (url.pathname === '/' || url.pathname === '') {
      try {
        // Ambil status dari D1
        const { results } = await env.DB.prepare(`
          SELECT 
            id,
            bentuk_aktif, 
            offset_terakhir, 
            waktu_selesai_terakhir, 
            updated_at,
            total_baru,
            total_diperbarui,
            total_tidak_berubah,
            total_dihapus
          FROM status_sinkronisasi WHERE id IN (1, 2)
        `).all();
        
        let row1 = results?.find(r => r.id === 1) || { bentuk_aktif: 'tk', offset_terakhir: 0 };
        let row2 = results?.find(r => r.id === 2);
        
        let activeRow = row1;
        let isCustom = false;
        
        if (row2 && row2.updated_at && row1.updated_at) {
          const t1 = new Date(row1.updated_at.replace(' ', 'T') + '+07:00').getTime();
          const t2 = new Date(row2.updated_at.replace(' ', 'T') + '+07:00').getTime();
          if (t2 > t1) {
            activeRow = row2;
            isCustom = true;
          }
        } else if (row2 && !row1.updated_at) {
          activeRow = row2;
          isCustom = true;
        }
        
        const bentukBerikutnya = activeRow.bentuk_aktif || 'tk';
        const offsetBerikutnya = activeRow.offset_terakhir || 0;
        
        const currentIndex = VALID_BENTUK.indexOf(bentukBerikutnya);
        const progressPercent = isCustom ? 100 : Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));
        
        const selesai = isCustom ? (bentukBerikutnya === 'Selesai') : (bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && activeRow.waktu_selesai_terakhir !== null && progressPercent === 0);

        let isRunning = false;
        if (activeRow.updated_at && !selesai) {
          // Ganti spasi dengan T agar formatnya valid ISO 8601, tambahkan +07:00 karena waktu sekarang WIB
          const safeDateStr = activeRow.updated_at.replace(' ', 'T') + '+07:00';
          const lastUpdated = new Date(safeDateStr);
          const now = new Date();
          const diffMs = now - lastUpdated;
          if (diffMs < 30 * 1000) { // 30 detik
            isRunning = true;
          }
        }

        const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sekolah Sync Dashboard (D1)</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🔄</text></svg>">
  <style>
    :root {
      --bg: #0b0c10; --card: rgba(255, 255, 255, 0.03); --border: rgba(255, 255, 255, 0.05);
      --text: #e5e7eb; --text-muted: #9ca3af; --primary: #6366f1; --primary-light: #818cf8;
      --success: #4ade80; --info: #60a5fa; --danger: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: radial-gradient(circle at top left, #12131a, var(--bg));
      color: var(--text);
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0; padding: 16px;
    }
    .card {
      background: var(--card); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border); border-radius: 24px;
      padding: 32px 24px; width: 100%; max-width: 450px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5); text-align: center; margin: auto;
    }
    h1 {
      margin-top: 0; font-size: 24px;
      background: linear-gradient(135deg, var(--primary), #a855f7);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .status-badge {
      display: inline-block; padding: 6px 16px; border-radius: 9999px;
      font-size: 14px; font-weight: 600;
      background: rgba(99, 102, 241, 0.15); color: var(--primary-light); margin-bottom: 24px;
    }
    .status-badge.finished { background: rgba(34, 197, 94, 0.15); color: var(--success); }
    .status-badge.stopped { background: rgba(248, 113, 113, 0.15); color: var(--danger); }
    
    .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-top: 24px; }
    .stat-box { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
    .stat-val { font-size: 20px; font-weight: 700; color: #fff; }
    .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    
    .progress-bar { height: 6px; background: var(--border); border-radius: 9999px; overflow: hidden; margin-top: 24px; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), #a855f7); width: ${selesai ? 100 : progressPercent}%; transition: width 0.3s; }
    
    .loader {
      width: 48px; height: 48px; border: 5px solid #fff; border-bottom-color: transparent;
      border-radius: 50%; display: block; box-sizing: border-box;
      animation: rotation 1s linear infinite; margin: 0 auto 20px auto;
    }
    @keyframes rotation { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
    
    .btn {
      display: inline-block; margin-top: 24px; padding: 12px 24px;
      background: linear-gradient(135deg, var(--primary), #a855f7);
      color: #fff; font-weight: 600; text-decoration: none;
      border-radius: 12px; transition: transform 0.2s, box-shadow 0.2s;
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 10px 20px rgba(99, 102, 241, 0.3);
    }
    
    @media (max-width: 480px) {
      .card { padding: 24px 16px; border-radius: 16px; }
      h1 { font-size: 20px; }
      .grid { gap: 10px; }
      .stat-box { padding: 12px; }
    }
  </style>
  <meta http-equiv="refresh" content="5">
</head>
<body>
  <div class="card">
    <div id="loader-icon" class="loader" style="${!isRunning && !selesai ? 'display: none;' : ''} ${selesai ? 'display: none;' : ''}"></div>
    
    <div id="status" class="status-badge ${selesai ? 'finished' : (!isRunning ? 'stopped' : '')}">
      ${selesai ? 'Sinkronisasi Selesai' : (isRunning ? 'Sedang Menyinkronkan...' : 'Menunggu / Terhenti')}
    </div>
    
    <h1>Sekolah Sync Dashboard ${isCustom ? '<span style="color: #f59e0b; font-size: 14px; vertical-align: middle; background: rgba(245, 158, 11, 0.15); padding: 4px 10px; border-radius: 20px;">Custom</span>' : '<span style="color: var(--primary-light); font-size: 14px; vertical-align: middle; background: rgba(99, 102, 241, 0.15); padding: 4px 10px; border-radius: 20px;">Full</span>'}</h1>
    <div style="font-size: 15px; color: #d1d5db; line-height: 1.5;">
      Bentuk Aktif: <strong style="color: var(--primary-light); text-transform: uppercase;">${bentukBerikutnya}</strong><br>
      Offset Saat Ini: <strong>${offsetBerikutnya}</strong><br>
      Update Terakhir: <strong style="color: #fff;">${activeRow.updated_at || '-'} WIB</strong>
    </div>

    <div class="grid">
      <div class="stat-box">
        <div class="stat-val" style="color: var(--success);">${activeRow.total_baru || 0}</div>
        <div class="stat-label">Baru Ditambahkan</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color: var(--info);">${activeRow.total_diperbarui || 0}</div>
        <div class="stat-label">Diperbarui</div>
      </div>
      <div class="stat-box">
        <div class="stat-val" style="color: var(--danger);">${activeRow.total_dihapus || 0}</div>
        <div class="stat-label">Dihapus (Nonaktif)</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${activeRow.total_tidak_berubah || 0}</div>
        <div class="stat-label">Tidak Berubah</div>
      </div>
    </div>
    
    <div class="progress-bar">
      <div class="progress-fill"></div>
    </div>
    
    <a href="https://api-sekolah-kita.pages.dev/" class="btn" target="_blank" rel="noopener noreferrer">
      Kunjungi Website Utama
    </a>
    
    <div style="font-size: 12px; color: var(--text-muted); margin-top: 20px;">Halaman refresh setiap 5 detik otomatis</div>
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

        let stats = { baru: 0, diperbarui: 0, tidakBerubah: 0, dihapus: 0 };
        
        if (dataList && dataList.length > 0) {
          stats = await syncBatch(env.DB, dataList);
        }

        // Jika mulai dari awal (tk, offset 0), kita reset statistiknya
        let resetStats = "";
        if (bentukAktif === 'tk' && offset === 0) {
          resetStats = ", total_baru = 0, total_diperbarui = 0, total_tidak_berubah = 0, total_dihapus = 0";
        }

        if (isFinished) {
          if (body.customSync) {
            // Gunakan LOWER(bentuk_pendidikan) karena database mungkin menyimpannya sebagai huruf besar (misal 'TK', 'SD'),
            // sedangkan body.bentukList berisi huruf kecil (misal 'tk', 'sd').
            const placeholders = body.bentukList.map(() => '?').join(',');
            let query = `DELETE FROM sekolah WHERE LOWER(bentuk_pendidikan) IN (${placeholders}) AND migrated_at < ?`;
            let params = [...body.bentukList, body.waktuMulai];

            if (body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
               query = `DELETE FROM sekolah WHERE LOWER(bentuk_pendidikan) IN (${placeholders}) AND nama_provinsi LIKE ? AND migrated_at < ?`;
               params = [...body.bentukList, `%${body.namaProvinsi}%`, body.waktuMulai];
            }

            const delRes = await env.DB.prepare(query).bind(...params).run();
            stats.dihapus = delRes.meta.changes;
            // Update status_sinkronisasi untuk id = 2 (Custom Sync)
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET total_dihapus = total_dihapus + ?, bentuk_aktif = 'Selesai', waktu_selesai_terakhir = datetime('now', '+7 hours'), updated_at = datetime('now', '+7 hours')
              WHERE id = 2
            `).bind(stats.dihapus).run();
          } else {
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET bentuk_aktif = 'tk', offset_terakhir = 0, waktu_selesai_terakhir = datetime('now', '+7 hours'), updated_at = datetime('now', '+7 hours')
              WHERE id = 1
            `).run();

            // Hapus sekolah yang tidak ada di API lagi (migrated_at lebih lama dari 2 hari yang lalu)
            const delRes = await env.DB.prepare(`
              DELETE FROM sekolah WHERE migrated_at < datetime('now', '+7 hours', '-2 days')
            `).run();
            
            stats.dihapus = delRes.meta.changes;
            
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET total_dihapus = total_dihapus + ? 
              WHERE id = 1
            `).bind(stats.dihapus).run();
          }
          
          await env.DB.prepare(`
            UPDATE status_sinkronisasi 
            SET total_dihapus = total_dihapus + ? 
            WHERE id = 1
          `).bind(stats.dihapus).run();
          
        } else {
          // Hanya update status untuk Full Sync
          if (!body.customSync) {
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET bentuk_aktif = ?, offset_terakhir = ?, updated_at = datetime('now', '+7 hours')
              ${resetStats ? resetStats : ', total_baru = total_baru + ?, total_diperbarui = total_diperbarui + ?, total_tidak_berubah = total_tidak_berubah + ?'}
              WHERE id = 1
            `).bind(
              ...(resetStats ? [bentukAktif, offset] : [bentukAktif, offset, stats.baru, stats.diperbarui, stats.tidakBerubah])
            ).run();
          } else {
            const displayBentuk = body.namaProvinsi && body.namaProvinsi !== 'SEMUA' ? `${bentukAktif.toUpperCase()} (${body.namaProvinsi})` : bentukAktif.toUpperCase();
            let resetQuery = '';
            if (body.isStart) {
              resetQuery = ', total_baru = 0, total_diperbarui = 0, total_tidak_berubah = 0, total_dihapus = 0';
            }
            // Upsert for id = 2
            await env.DB.prepare(`
              INSERT INTO status_sinkronisasi (id, bentuk_aktif, offset_terakhir, total_baru, total_diperbarui, total_tidak_berubah, updated_at) 
              VALUES (2, ?, ?, ?, ?, ?, datetime('now', '+7 hours'))
              ON CONFLICT(id) DO UPDATE SET
                bentuk_aktif = excluded.bentuk_aktif,
                offset_terakhir = excluded.offset_terakhir,
                updated_at = excluded.updated_at
                ${resetQuery ? resetQuery : `, total_baru = status_sinkronisasi.total_baru + excluded.total_baru, total_diperbarui = status_sinkronisasi.total_diperbarui + excluded.total_diperbarui, total_tidak_berubah = status_sinkronisasi.total_tidak_berubah + excluded.total_tidak_berubah`}
            `).bind(
              displayBentuk, offset, stats.baru, stats.diperbarui, stats.tidakBerubah
            ).run();
          }
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
