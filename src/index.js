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
            total_dihapus,
            total_estimasi
          FROM status_sinkronisasi WHERE id IN (1, 2)
        `).all();
        
        let provStatusList = [];
        let compareCache = null;
        try {
          const { results: provRes } = await env.DB.prepare('SELECT nama_provinsi, terakhir_sukses FROM provinsi_sync_status').all();
          provStatusList = provRes || [];
          
          const { results: cacheRes } = await env.DB.prepare('SELECT value, updated_at FROM cache_data WHERE key = ?').bind('perbandingan').all();
          if (cacheRes && cacheRes.length > 0) {
             compareCache = { value: JSON.parse(cacheRes[0].value), updated_at: cacheRes[0].updated_at };
          }
        } catch (e) {} // Abaikan jika tabel belum ada
        
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
        
        const totalEstimasi = activeRow.total_estimasi || (isCustom ? 12654 : 553456);
        const totalSynced = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
        
        const currentIndex = VALID_BENTUK.indexOf(bentukBerikutnya);
        let progressPercent = 0;
        if (isCustom) {
           progressPercent = totalEstimasi > 0 ? Math.min(100, Math.round((totalSynced / totalEstimasi) * 100)) : 0;
        } else {
           progressPercent = Math.max(0, Math.round((currentIndex / VALID_BENTUK.length) * 100));
        }
        
        const selesai = isCustom ? (bentukBerikutnya === 'Selesai') : (bentukBerikutnya === 'tk' && offsetBerikutnya === 0 && activeRow.waktu_selesai_terakhir !== null && progressPercent === 0);
        
        if (selesai) {
           progressPercent = 100;
        }

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

        // Data Jadwal Sinkronisasi Mingguan per Provinsi (sesuai jalankan-skrip.yml)
        const jadwal = [
          { hari: 'Senin', id: 1, provs: ['JAWA BARAT', 'BALI', 'BENGKULU', 'GORONTALO', 'SULAWESI BARAT'] },
          { hari: 'Selasa', id: 2, provs: ['JAWA TIMUR', 'DI YOGYAKARTA', 'KEPULAUAN BANGKA BELITUNG', 'KALIMANTAN UTARA', 'MALUKU UTARA'] },
          { hari: 'Rabu', id: 3, provs: ['JAWA TENGAH', 'BANTEN', 'KEPULAUAN RIAU', 'PAPUA BARAT', 'PAPUA BARAT DAYA'] },
          { hari: 'Kamis', id: 4, provs: ['SUMATERA UTARA', 'DKI JAKARTA', 'ACEH', 'JAMBI', 'PAPUA', 'PAPUA SELATAN'] },
          { hari: 'Jumat', id: 5, provs: ['SUMATERA SELATAN', 'LAMPUNG', 'RIAU', 'SUMATERA BARAT', 'PAPUA TENGAH', 'PAPUA PEGUNUNGAN'] },
          { hari: 'Sabtu', id: 6, provs: ['SULAWESI SELATAN', 'SULAWESI TENGGARA', 'SULAWESI TENGAH', 'SULAWESI UTARA', 'KALIMANTAN TIMUR', 'MALUKU'] },
          { hari: 'Minggu', id: 0, provs: ['KALIMANTAN BARAT', 'KALIMANTAN SELATAN', 'KALIMANTAN TENGAH', 'NUSA TENGGARA TIMUR', 'NUSA TENGGARA BARAT', 'LUAR NEGERI'] }
        ];

        // Kalkulasi waktu menggunakan UTC yang ditambahkan offset WIB (+7 jam)
        const nowUtcMs = new Date().getTime();
        const wibMs = nowUtcMs + (7 * 60 * 60 * 1000);
        const dateWIB = new Date(wibMs);
        
        const todayId = dateWIB.getUTCDay(); // 0 = Minggu, 1 = Senin
        const currentDayIndex = todayId === 0 ? 7 : todayId;
        
        // Dapatkan representasi tanggal jam 00:00 di WIB untuk kalkulasi offset hari
        const today00Utc = Date.UTC(dateWIB.getUTCFullYear(), dateWIB.getUTCMonth(), dateWIB.getUTCDate());
        const today00WibAbsoluteMs = today00Utc - (7 * 60 * 60 * 1000); // Absolute timestamp 00:00 WIB hari ini
        
        const provSyncMap = {};
        provStatusList.forEach(p => {
           provSyncMap[p.nama_provinsi] = new Date(p.terakhir_sukses.replace(' ', 'T') + '+07:00').getTime();
        });

        const compareMap = {};
        let compareHtml = '';
        let hasDiffGlobal = false;
        let lastChecked = 'Belum ada data';
        
        let sumTotalApi = 0;
        let sumTotalDb = 0;
        let diffCount = 0;
        
        if (compareCache) {
           lastChecked = compareCache.updated_at + ' WIB';
           compareCache.value.forEach(d => {
              compareMap[d.nama.replace(/[^A-Z]/g, '')] = d.selisih;
              if (d.selisih !== 0) hasDiffGlobal = true;
              
              sumTotalApi += d.total_api || 0;
              sumTotalDb += d.total_db || 0;
              if (d.selisih !== 0) diffCount++;
           });
           compareCache.value.sort((a, b) => {
              const aDiff = a.selisih !== 0 ? 1 : 0;
              const bDiff = b.selisih !== 0 ? 1 : 0;
              if (aDiff !== bDiff) return bDiff - aDiff;
              return a.nama.localeCompare(b.nama);
           });
           
           compareHtml = compareCache.value.map((d, idx) => {
              const selisihColor = d.selisih === 0 ? 'var(--success)' : 'var(--danger)';
              const statusIcon = d.selisih === 0 ? '✅ Sinkron' : '⚠️ Berbeda';
              const displayStyle = idx >= 5 ? 'display: none;' : '';
              const trClass = idx >= 5 ? 'hidden-row' : '';
              return `
                <tr class="${trClass}" style="border-bottom: 1px solid rgba(255,255,255,0.02); ${displayStyle}">
                  <td style="padding: 8px;">${d.nama} <div style="font-size: 10px; color: var(--text-muted)">Kode: ${d.kode}</div></td>
                  <td style="padding: 8px; text-align: center; color: var(--info);">${d.total_api.toLocaleString('id-ID')}</td>
                  <td style="padding: 8px; text-align: center; color: var(--primary-light);">${d.total_db.toLocaleString('id-ID')}</td>
                  <td style="padding: 8px; text-align: center; color: ${selisihColor}; font-weight: bold;">${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}</td>
                  <td style="padding: 8px; text-align: center; color: ${selisihColor}; font-size: 11px;">${statusIcon}</td>
                </tr>
              `;
           }).join('');
           if(hasDiffGlobal) {
             compareHtml += '<tr class="hidden-row" style="display: none;"><td colspan="5" style="padding: 16px; text-align: center;"><div style="color: var(--text-muted); font-size: 12px; margin-bottom: 8px;">Ada data yang berbeda. Smart Sync (GitHub Action) akan otomatis memprioritaskan provinsi yang berselisih saja.</div></td></tr>';
           }
           
           // Tambahkan baris total
           const totalSelisih = sumTotalApi - sumTotalDb;
           const totalColor = totalSelisih === 0 ? 'var(--success)' : 'var(--danger)';
           compareHtml += `
             <tr class="hidden-row" style="display: none; border-top: 2px solid var(--border); font-weight: bold; background: rgba(0,0,0,0.2);">
               <td style="padding: 12px 8px;">TOTAL KESELURUHAN</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--info);">${sumTotalApi.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--primary-light);">${sumTotalDb.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; color: ${totalColor};">${totalSelisih > 0 ? '+' : ''}${totalSelisih.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; font-size: 11px;">${diffCount} Provinsi Berselisih</td>
             </tr>
           `;
        } else {
           compareHtml = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">Belum ada data perbandingan. Jalankan cron terlebih dahulu.</td></tr>';
        }

        let jadwalHtml = '<div class="jadwal-container"><h2>Jadwal Sinkronisasi Mingguan (00:00 WIB)</h2><div class="jadwal-grid">';
        jadwal.forEach(j => {
          const jIndex = j.id === 0 ? 7 : j.id;
          
          let diff = jIndex - currentDayIndex;
          if (diff < -1) diff += 7; // Jika sudah lewat >1 hari, maka jadikan minggu depan
          if (diff === 6) diff = -1; // +6 hari dari hari ini sama dengan kemarin
          
          const isToday = diff === 0;
          const isPast = diff === -1;
          
          // Hitung tanggal target
          const targetTime = today00Utc + (diff * 24 * 60 * 60 * 1000);
          const targetDate = new Date(targetTime);
          
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
          const d = targetDate.getUTCDate();
          const m = monthNames[targetDate.getUTCMonth()];
          const y = targetDate.getUTCFullYear();
          const dateStr = `${d} ${m} ${y}`;
          const displayHari = `${j.hari}, ${dateStr}`;
          
          let dayClass = isToday ? 'day-card today' : 'day-card';
          let dayHeaderClass = isToday ? 'day-header today' : 'day-header';
          
          let provListHtml = j.provs.map(prov => {
            let statusIcon = '🕒';
            let statusText = 'Menunggu';
            let itemClass = 'prov-item waiting';
            
            const cleanName = (name) => name.replace(/[^A-Z]/g, '');
            const matchingKey = Object.keys(provSyncMap).find(k => cleanName(k) === cleanName(prov));
            let lastSyncTime = matchingKey ? provSyncMap[matchingKey] : 0;
            
            const isCurrentlyRunning = isRunning && activeRow.bentuk_aktif && cleanName(activeRow.bentuk_aktif).includes(cleanName(prov));
            const isCompleted = lastSyncTime >= targetTime;
            const isActiveButNotRunning = !isRunning && activeRow.bentuk_aktif && cleanName(activeRow.bentuk_aktif).includes(cleanName(prov));

            // Logika baru: Ikuti status sinkron database (selisih == 0) untuk SEMUA hari
            const isSynced = compareMap[cleanName(prov)] === 0;
            const hasData = compareMap[cleanName(prov)] !== undefined;
            
            if (isCurrentlyRunning) {
              statusIcon = '<span class="spin-icon">🔄</span>';
              statusText = 'Proses Sinkronisasi';
              itemClass = 'prov-item processing';
            } else if (hasData && isSynced) {
              statusIcon = '✅';
              statusText = 'Sudah Sinkron';
              itemClass = 'prov-item done';
            } else if (isActiveButNotRunning) {
              statusIcon = '⚠️';
              statusText = 'Terhenti / Menunggu';
              itemClass = 'prov-item waiting';
            } else {
              statusIcon = '🕒';
              statusText = 'Menunggu Sinkronisasi';
              itemClass = 'prov-item waiting';
            }
            
            return `<div class="${itemClass}">
              <span class="prov-name">${prov}</span>
              <span class="prov-status" title="${statusText}">${statusIcon}</span>
            </div>`;
          }).join('');

          jadwalHtml += `
            <div class="${dayClass}">
              <div class="${dayHeaderClass}">${displayHari} ${isToday ? ' (Hari Ini)' : ''}</div>
              <div class="prov-list">
                ${provListHtml}
              </div>
            </div>
          `;
        });
        jadwalHtml += '</div></div>';

        // Fetch Log Aktivitas
        const pageStr = url.searchParams.get('page') || '1';
        const page = parseInt(pageStr, 10) || 1;
        const limit = 5;
        const offset = (page - 1) * limit;

        let logAktivitasList = [];
        let totalLogs = 0;
        try {
          const { results: countRes } = await env.DB.prepare('SELECT COUNT(*) as total FROM log_aktivitas_provinsi').all();
          totalLogs = countRes[0]?.total || 0;

          const { results: logRes } = await env.DB.prepare('SELECT * FROM log_aktivitas_provinsi ORDER BY waktu_selesai DESC LIMIT ? OFFSET ?').bind(limit, offset).all();
          logAktivitasList = logRes || [];
        } catch (e) {} // Abaikan jika tabel belum ada
        
        const totalPages = Math.ceil(totalLogs / limit) || 1;
        let paginationHtml = '';
        if (totalPages > 1) {
          paginationHtml = `<div style="display: flex; justify-content: center; gap: 8px; margin-top: 16px;">
            ${page > 1 ? `<a href="/?page=${page - 1}" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px; color: var(--text); text-decoration: none; font-size: 13px;">&laquo; Prev</a>` : ''}
            <span style="padding: 6px 12px; font-size: 13px; color: var(--text-muted);">Halaman ${page} dari ${totalPages}</span>
            ${page < totalPages ? `<a href="/?page=${page + 1}" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px; color: var(--text); text-decoration: none; font-size: 13px;">Next &raquo;</a>` : ''}
          </div>`;
        }

        let logHtml = logAktivitasList.length > 0 ? logAktivitasList.map(log => {
          const totalData = log.total_baru + log.total_diperbarui + log.total_tidak_berubah;
          return `<div style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 12px; font-size: 13px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <strong style="color: #e5e7eb;">${log.nama_provinsi}</strong>
              <span style="color: var(--text-muted); font-size: 11px;">${log.waktu_selesai}</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center; font-size: 12px;">
              <div style="color: var(--success);">${log.total_baru} Baru</div>
              <div style="color: var(--info);">${log.total_diperbarui} Update</div>
              <div style="color: var(--danger);">${log.total_dihapus} Hapus</div>
              <div style="color: var(--text-muted);">${log.total_tidak_berubah} Tetap</div>
            </div>
            <div style="text-align: left; margin-top: 8px; font-weight: 600; color: #d1d5db; border-top: 1px solid var(--border); padding-top: 8px;">Total Data: ${totalData}</div>
          </div>`;
        }).join('') : '<div style="color: var(--text-muted); font-size: 13px;">Belum ada log aktivitas.</div>';

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
      padding: 32px 24px; width: 100%; max-width: 650px;
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
    @media (min-width: 600px) {
      .grid { grid-template-columns: repeat(4, 1fr); }
    }
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

    /* Styles untuk Jadwal */
    .jadwal-container { margin-top: 32px; text-align: left; }
    .jadwal-container h2 { font-size: 18px; margin-bottom: 16px; color: #fff; font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .jadwal-grid { display: grid; grid-template-columns: 1fr; gap: 12px; max-height: 380px; overflow-y: auto; padding-right: 6px; }
    @media (min-width: 600px) {
      .jadwal-grid { grid-template-columns: repeat(2, 1fr); }
    }
    .jadwal-grid::-webkit-scrollbar { width: 6px; }
    .jadwal-grid::-webkit-scrollbar-track { background: rgba(0,0,0,0.1); border-radius: 4px; }
    .jadwal-grid::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
    .day-card { background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 16px; padding: 16px; transition: transform 0.2s; }
    .day-card.today { border-color: var(--primary); background: rgba(99, 102, 241, 0.08); box-shadow: 0 4px 12px rgba(99, 102, 241, 0.1); }
    .day-header { font-weight: 700; font-size: 15px; margin-bottom: 12px; color: var(--text-muted); }
    .day-header.today { color: var(--primary-light); }
    .prov-list { display: flex; flex-direction: column; gap: 8px; }
    .prov-item { display: flex; justify-content: space-between; align-items: center; font-size: 13px; background: rgba(0,0,0,0.25); padding: 8px 12px; border-radius: 8px; transition: background 0.2s; }
    .prov-item.done { background: rgba(34, 197, 94, 0.1); }
    .prov-item.processing { background: rgba(99, 102, 241, 0.2); border: 1px solid rgba(99, 102, 241, 0.3); }
    .prov-name { color: #e5e7eb; font-weight: 500; }
    .prov-item.done .prov-name { color: var(--text-muted); }
    .spin-icon { display: inline-block; animation: rotation 2s linear infinite; }
    
    @media (max-width: 480px) {
      .card { padding: 24px 16px; border-radius: 16px; }
      h1 { font-size: 20px; }
      .grid { gap: 10px; }
      .stat-box { padding: 12px; }
    }
  </style>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      // Restore window scroll
      const scrollPos = sessionStorage.getItem("scrollPos");
      if (scrollPos) {
        window.scrollTo(0, parseInt(scrollPos));
      }
      // Restore grid scroll
      const gridScrollPos = sessionStorage.getItem("gridScrollPos");
      const gridEl = document.querySelector(".jadwal-grid");
      if (gridEl) {
        if (gridScrollPos !== null) {
          gridEl.scrollTop = parseInt(gridScrollPos);
        } else {
          // Auto-focus to today's schedule on first load
          const todayCard = gridEl.querySelector('.day-card.today');
          if (todayCard) {
            const topPos = todayCard.offsetTop - gridEl.offsetTop;
            gridEl.scrollTop = topPos > 0 ? topPos : 0;
            sessionStorage.setItem("gridScrollPos", gridEl.scrollTop);
          }
        }
        
        // Save scroll position on manual scroll
        gridEl.addEventListener('scroll', function() {
          sessionStorage.setItem("gridScrollPos", gridEl.scrollTop);
        });
      }
      
      // Restore compare horizontal scroll
      const compareScrollPos = sessionStorage.getItem("compareScrollPos");
      const compareEl = document.getElementById("compare-container");
      if (compareScrollPos && compareEl) {
        compareEl.scrollLeft = parseInt(compareScrollPos);
      }
      
      // Restore show all compare
      const showAll = sessionStorage.getItem("compareShowAll");
      if (showAll === "true") {
         const rows = document.querySelectorAll('.hidden-row');
         const btn = document.getElementById('btn-compare');
         if (rows.length > 0 && btn) {
            rows.forEach(r => r.style.display = 'table-row');
            btn.innerText = 'Tutup Perbandingan';
         }
      }
    });
    
    function toggleComparison() {
      const rows = document.querySelectorAll('.hidden-row');
      const btn = document.getElementById('btn-compare');
      let isHidden = true;
      
      if (rows.length > 0) {
        isHidden = rows[0].style.display === 'none';
        rows.forEach(r => {
           r.style.display = isHidden ? 'table-row' : 'none';
        });
        btn.innerText = isHidden ? 'Tutup Perbandingan' : 'Tampilkan Semua';
        sessionStorage.setItem('compareShowAll', isHidden ? 'true' : 'false');
      }
    }

    function doAutoReload() {
      if (window.isAutoReloadPaused) {
        setTimeout(doAutoReload, 5000);
        return;
      }
      
      const gridEl = document.querySelector(".jadwal-grid");
      const gridScroll = gridEl ? gridEl.scrollTop : 0;
      
      const compareEl = document.getElementById("compare-container");
      const compareScroll = compareEl ? compareEl.scrollLeft : 0;
      
      const isShowAll = sessionStorage.getItem("compareShowAll") === "true";

      fetch(window.location.href)
        .then(res => res.text())
        .then(html => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          
          const newCard = doc.querySelector('.card');
          const currentCard = document.querySelector('.card');
          
          if(doc) {
            // Update specific elements to prevent full DOM recreation and scroll interruption
            
            const statusBadge = document.getElementById('status');
            const newStatusBadge = doc.getElementById('status');
            if (statusBadge && newStatusBadge) { statusBadge.className = newStatusBadge.className; statusBadge.innerHTML = newStatusBadge.innerHTML; }
            
            const progBar = document.querySelector('.progress-bar');
            const newProgBar = doc.querySelector('.progress-bar');
            if (progBar && newProgBar) progBar.innerHTML = newProgBar.innerHTML;
            
            const progStats = document.getElementById('progress-stats');
            const newProgStats = doc.getElementById('progress-stats');
            if (progStats && newProgStats) progStats.innerHTML = newProgStats.innerHTML;
            
            const grid = document.querySelector('.grid');
            const newGrid = doc.querySelector('.grid');
            if (grid && newGrid) grid.innerHTML = newGrid.innerHTML;
            
            const jadwalGrid = document.querySelector('.jadwal-grid');
            const newJadwalGrid = doc.querySelector('.jadwal-grid');
            if (jadwalGrid && newJadwalGrid) {
              const currentScroll = jadwalGrid.scrollTop;
              jadwalGrid.innerHTML = newJadwalGrid.innerHTML;
              jadwalGrid.scrollTop = currentScroll;
            }
            
            const logContainer = document.getElementById('log-container');
            const newLogContainer = doc.getElementById('log-container');
            if (logContainer && newLogContainer) logContainer.innerHTML = newLogContainer.innerHTML;
            
            const compareBody = document.getElementById('compare-body');
            const newCompareBody = doc.getElementById('compare-body');
            if (compareBody && newCompareBody) {
              compareBody.innerHTML = newCompareBody.innerHTML;
            }
            
            const lastChecked = document.getElementById('compare-last-checked');
            const newLastChecked = doc.getElementById('compare-last-checked');
            if (lastChecked && newLastChecked) lastChecked.innerHTML = newLastChecked.innerHTML;
            
            const mainTitle = document.getElementById('main-title');
            const newMainTitle = doc.getElementById('main-title');
            if (mainTitle && newMainTitle) mainTitle.innerHTML = newMainTitle.innerHTML;
            
            const mainInfo = document.getElementById('main-info');
            const newMainInfo = doc.getElementById('main-info');
            if (mainInfo && newMainInfo) mainInfo.innerHTML = newMainInfo.innerHTML;
            
            // Restore show all state
            if (isShowAll) {
               const rows = document.querySelectorAll('.hidden-row');
               const btn = document.getElementById('btn-compare');
               if (rows.length > 0 && btn) {
                  rows.forEach(r => r.style.display = 'table-row');
                  btn.innerText = 'Tutup Perbandingan';
               }
            }
          }
          setTimeout(doAutoReload, 5000);
        })
        .catch(e => {
          setTimeout(doAutoReload, 5000);
        });
    }
    setTimeout(doAutoReload, 5000);
  </script>
</head>
<body>
  <div class="card">
    <div id="loader-icon" class="loader" style="${!isRunning && !selesai ? 'display: none;' : ''} ${selesai ? 'display: none;' : ''}"></div>
    
    <div id="status" class="status-badge ${selesai ? 'finished' : (!isRunning ? 'stopped' : '')}" style="margin-bottom: 12px;">
      ${selesai ? 'Sinkronisasi Selesai' : (isRunning ? 'Sedang Menyinkronkan...' : 'Menunggu / Terhenti')}
    </div>
    
    <div style="max-width: 400px; margin: 0 auto 24px auto;">
      <div class="progress-bar" style="margin-top: 0;">
        <div class="progress-fill"></div>
      </div>
      <div id="progress-stats" style="display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-top: 8px; font-weight: 500;">
        <span>${progressPercent}% Selesai</span>
        <span>Data: ${totalSynced} / ${totalEstimasi}</span>
      </div>
    </div>
    
    <h1 id="main-title">Sekolah Sync Dashboard ${isCustom ? '<span style="color: #f59e0b; font-size: 14px; vertical-align: middle; background: rgba(245, 158, 11, 0.15); padding: 4px 10px; border-radius: 20px;">Custom</span>' : '<span style="color: var(--primary-light); font-size: 14px; vertical-align: middle; background: rgba(99, 102, 241, 0.15); padding: 4px 10px; border-radius: 20px;">Full</span>'}</h1>
    <div id="main-info" style="font-size: 15px; color: #d1d5db; line-height: 1.5;">
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
    
    ${jadwalHtml}
    
    <div style="margin-top: 32px; text-align: left;">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: #fff; font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--border);">Log Aktivitas Terakhir</h2>
      <div id="log-container" style="display: flex; flex-direction: column; gap: 8px;">
        ${logHtml}
      </div>
      ${paginationHtml}
    </div>

    <div style="margin-top: 32px; text-align: left;">
      <div id="compare-header-box" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 16px;">
        <div>
          <h2 style="font-size: 18px; color: #fff; font-weight: 600; margin: 0 0 4px 0;">Perbandingan Data (Belajar.id vs DB)</h2>
          <div id="compare-last-checked" style="font-size: 12px; color: var(--text-muted);">Terakhir dicek: ${lastChecked}</div>
        </div>
        ${compareCache && compareCache.value.length > 5 ? `<button id="btn-compare" style="background: var(--primary); color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; transition: background 0.2s;" onclick="toggleComparison()">Tampilkan Semua</button>` : ''}
      </div>
      <div id="compare-container" style="background: rgba(255,255,255,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-size: 13px; overflow-x: auto;">
         <table id="compare-table" style="width: 100%; min-width: 550px; border-collapse: collapse;">
           <thead>
             <tr style="border-bottom: 1px solid var(--border); color: var(--text-muted); text-align: left;">
               <th style="padding: 8px;">Provinsi</th>
               <th style="padding: 8px; text-align: center;">Belajar.id</th>
               <th style="padding: 8px; text-align: center;">Database</th>
               <th style="padding: 8px; text-align: center;">Selisih</th>
               <th style="padding: 8px; text-align: center;">Status</th>
             </tr>
           </thead>
           <tbody id="compare-body">${compareHtml}</tbody>
         </table>
      </div>
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

    // Endpoint Perbandingan Data (API)
    if (url.pathname === '/api/compare' && request.method === 'GET') {
      try {
        const isCron = url.searchParams.get('cron') === 'true';
        
        // Buat tabel cache_data jika belum ada
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS cache_data (key TEXT PRIMARY KEY, value TEXT, updated_at TIMESTAMPTZ)`).run();

        if (!isCron) {
           const { results } = await env.DB.prepare("SELECT value FROM cache_data WHERE key = 'perbandingan'").all();
           if (results && results.length > 0) {
              return new Response(JSON.stringify({ success: true, data: JSON.parse(results[0].value) }), {
                headers: { 'content-type': 'application/json' }
              });
           }
           // Jika kosong, lanjut ambil data dari API untuk inisialisasi awal
        }

        const PROVINCES = {
            '010000': 'DKI JAKARTA', '020000': 'JAWA BARAT', '030000': 'JAWA TENGAH', '040000': 'DI YOGYAKARTA',
            '050000': 'JAWA TIMUR', '060000': 'ACEH', '070000': 'SUMATERA UTARA', '080000': 'SUMATERA BARAT',
            '090000': 'RIAU', '100000': 'JAMBI', '110000': 'SUMATERA SELATAN', '120000': 'LAMPUNG',
            '130000': 'KALIMANTAN BARAT', '140000': 'KALIMANTAN TENGAH', '150000': 'KALIMANTAN SELATAN',
            '160000': 'KALIMANTAN TIMUR', '170000': 'SULAWESI UTARA', '180000': 'SULAWESI TENGAH',
            '190000': 'SULAWESI SELATAN', '200000': 'SULAWESI TENGGARA', '210000': 'MALUKU', '220000': 'BALI',
            '230000': 'NUSA TENGGARA BARAT', '240000': 'NUSA TENGGARA TIMUR', '250000': 'PAPUA', '260000': 'BENGKULU',
            '270000': 'MALUKU UTARA', '280000': 'BANTEN', '290000': 'KEPULAUAN BANGKA BELITUNG', '300000': 'GORONTALO',
            '310000': 'KEPULAUAN RIAU', '320000': 'PAPUA BARAT', '330000': 'SULAWESI BARAT', '340000': 'KALIMANTAN UTARA',
            '350000': 'LUAR NEGERI', '360000': 'PAPUA TENGAH', '370000': 'PAPUA SELATAN', '380000': 'PAPUA PEGUNUNGAN', 
            '390000': 'PAPUA BARAT DAYA'
        };

        const promises = Object.keys(PROVINCES).map(async (kode) => {
          try {
            const res = await fetch(`https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kode}?limit=1&offset=0`);
            const json = await res.json();
            return { kode, nama: PROVINCES[kode], total_api: json.meta ? json.meta.total : 0 };
          } catch(e) {
            return { kode, nama: PROVINCES[kode], total_api: 0 };
          }
        });
        
        const apiData = await Promise.all(promises);

        // Fetch dari DB
        const { results: dbRes } = await env.DB.prepare('SELECT nama_provinsi as provinsi, COUNT(*) as total_db FROM sekolah GROUP BY nama_provinsi').all();
        
        const cleanName = (name) => {
          if (!name) return "";
          let c = name.replace(/[^A-Z]/gi, '').toUpperCase();
          return c.replace(/^PROVINSI|^PROV/, '');
        };

        const dbMap = {};
        dbRes.forEach(r => {
          dbMap[cleanName(r.provinsi)] = r.total_db;
        });

        const comparison = apiData.map(d => {
           const total_db = dbMap[cleanName(d.nama)] || 0;
           const selisih = d.total_api - total_db;
           return { ...d, total_db, selisih };
        });
        
        comparison.sort((a, b) => {
           const aDiff = a.selisih !== 0 ? 1 : 0;
           const bDiff = b.selisih !== 0 ? 1 : 0;
           if (aDiff !== bDiff) return bDiff - aDiff;
           return a.nama.localeCompare(b.nama);
        });
        
        const jsonResult = JSON.stringify(comparison);
        
        // Simpan ke cache
        await env.DB.prepare(`
          INSERT INTO cache_data (key, value, updated_at) 
          VALUES ('perbandingan', ?, datetime('now', '+7 hours'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).bind(jsonResult).run();

        return new Response(JSON.stringify({ success: true, data: comparison }), {
          headers: { 'content-type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: { 'content-type': 'application/json' } });
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
        const { dataList, bentukAktif, offset, isFinished, ...customParams } = body;

        let stats = { baru: 0, diperbarui: 0, tidakBerubah: 0, dihapus: 0 };
        
        // Ensure total_estimasi column exists
        try {
          await env.DB.prepare(`ALTER TABLE status_sinkronisasi ADD COLUMN total_estimasi INTEGER DEFAULT 0`).run();
        } catch (e) {}
        
        if (dataList && dataList.length > 0) {
          stats = await syncBatch(env.DB, dataList);
        }

        // Jika mulai dari awal (tk, offset 0), kita reset statistiknya
        let resetStats = "";
        if (bentukAktif === 'tk' && offset === 0) {
          resetStats = ", total_baru = 0, total_diperbarui = 0, total_tidak_berubah = 0, total_dihapus = 0, waktu_mulai_sinkronisasi = datetime('now', '+7 hours')";
        }
        
        // Simpan log terakhir provinsi sukses
        if (body.customSync && body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provinsi_sync_status (nama_provinsi TEXT PRIMARY KEY, terakhir_sukses TIMESTAMPTZ)`).run();
          await env.DB.prepare(`
            INSERT INTO provinsi_sync_status (nama_provinsi, terakhir_sukses)
            VALUES (?, datetime('now', '+7 hours'))
            ON CONFLICT(nama_provinsi) DO UPDATE SET terakhir_sukses = excluded.terakhir_sukses
          `).bind(body.namaProvinsi).run();
        }

        if (isFinished) {
          if (body.customSync) {
            // Gunakan LOWER(bentuk_pendidikan) karena database mungkin menyimpannya sebagai huruf besar (misal 'TK', 'SD'),
            // sedangkan body.bentukList berisi huruf kecil (misal 'tk', 'sd').
            const dbBentukList = body.bentukList.map(b => b === 'smag-k' ? 'smag.k' : b.replace(/-/g, ' '));
            const placeholders = dbBentukList.map(() => '?').join(',');
            let query = `DELETE FROM sekolah WHERE LOWER(bentuk_pendidikan) IN (${placeholders}) AND migrated_at < ?`;
            let params = [...dbBentukList, body.waktuMulai];

            if (body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
               const searchProv = body.namaProvinsi === 'LUAR NEGERI' ? 'LUAR NEGERI' : `PROV. ${body.namaProvinsi}`;
               query = `DELETE FROM sekolah WHERE LOWER(bentuk_pendidikan) IN (${placeholders}) AND nama_provinsi = ? AND migrated_at < ?`;
               params = [...dbBentukList, searchProv, body.waktuMulai];
            }

            const delRes = await env.DB.prepare(query).bind(...params).run();
            stats.dihapus = delRes.meta.changes;
            
            // Ambil data status_sinkronisasi saat ini sebelum direset (untuk dicatat ke log_aktivitas)
            const { results: currentStatsRes } = await env.DB.prepare(`SELECT * FROM status_sinkronisasi WHERE id = 2`).all();
            const current = currentStatsRes[0] || {};
            
            // Catat ke log_aktivitas_provinsi
            await env.DB.prepare(`CREATE TABLE IF NOT EXISTS log_aktivitas_provinsi (id INTEGER PRIMARY KEY AUTOINCREMENT, nama_provinsi TEXT, total_baru INTEGER, total_diperbarui INTEGER, total_dihapus INTEGER, total_tidak_berubah INTEGER, waktu_selesai TIMESTAMPTZ)`).run();
            await env.DB.prepare(`
               INSERT INTO log_aktivitas_provinsi (nama_provinsi, total_baru, total_diperbarui, total_dihapus, total_tidak_berubah, waktu_selesai)
               VALUES (?, ?, ?, ?, ?, datetime('now', '+7 hours'))
            `).bind(
               body.namaProvinsi || 'SEMUA',
               current.total_baru || 0,
               current.total_diperbarui || 0,
               stats.dihapus || 0,
               current.total_tidak_berubah || 0
            ).run();

            // Hapus log aktivitas yang usianya lebih dari 3 hari
            await env.DB.prepare(`
               DELETE FROM log_aktivitas_provinsi WHERE waktu_selesai < datetime('now', '+7 hours', '-3 days')
            `).run();

            // Update status_sinkronisasi untuk id = 2 (Custom Sync)
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET total_dihapus = total_dihapus + ?, bentuk_aktif = 'Selesai', waktu_selesai_terakhir = datetime('now'), updated_at = datetime('now', '+7 hours')
              WHERE id = 2
            `).bind(stats.dihapus).run();
          } else {
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET bentuk_aktif = 'tk', offset_terakhir = 0, waktu_selesai_terakhir = datetime('now'), updated_at = datetime('now', '+7 hours')
              WHERE id = 1
            `).run();

            // Hapus sekolah yang usianya lebih lama dari waktu mulai sinkronisasi siklus ini
            const delRes = await env.DB.prepare(`
              DELETE FROM sekolah WHERE migrated_at < (SELECT waktu_mulai_sinkronisasi FROM status_sinkronisasi WHERE id = 1)
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
              SET bentuk_aktif = ?, offset_terakhir = ?, updated_at = datetime('now', '+7 hours'), waktu_selesai_terakhir = datetime('now')
              ${resetStats ? resetStats : ', total_baru = total_baru + ?, total_diperbarui = total_diperbarui + ?, total_tidak_berubah = total_tidak_berubah + ?'}
              WHERE id = 1
            `).bind(
              ...(resetStats ? [bentukAktif, offset] : [bentukAktif, offset, stats.baru, stats.diperbarui, stats.tidakBerubah])
            ).run();
          } else {
            const displayBentuk = body.namaProvinsi && body.namaProvinsi !== 'SEMUA' ? `${bentukAktif.toUpperCase()} (${body.namaProvinsi})` : bentukAktif.toUpperCase();
            let resetQuery = '';
            if (body.isStart) {
              resetQuery = ', total_baru = excluded.total_baru, total_diperbarui = excluded.total_diperbarui, total_tidak_berubah = excluded.total_tidak_berubah, total_dihapus = 0, total_estimasi = excluded.total_estimasi';
            }
            // Upsert for id = 2
            await env.DB.prepare(`
              INSERT INTO status_sinkronisasi (id, bentuk_aktif, offset_terakhir, total_baru, total_diperbarui, total_tidak_berubah, total_estimasi, updated_at, waktu_selesai_terakhir) 
              VALUES (2, ?, ?, ?, ?, ?, ?, datetime('now', '+7 hours'), datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                bentuk_aktif = excluded.bentuk_aktif,
                offset_terakhir = excluded.offset_terakhir,
                updated_at = excluded.updated_at,
                waktu_selesai_terakhir = excluded.waktu_selesai_terakhir
                ${resetQuery ? resetQuery : `, total_baru = status_sinkronisasi.total_baru + excluded.total_baru, total_diperbarui = status_sinkronisasi.total_diperbarui + excluded.total_diperbarui, total_tidak_berubah = status_sinkronisasi.total_tidak_berubah + excluded.total_tidak_berubah, total_estimasi = excluded.total_estimasi`}
            `).bind(
              displayBentuk, offset, stats.baru, stats.diperbarui, stats.tidakBerubah, customParams.totalEstimasi || 0
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
    // Endpoint untuk menandai provinsi yang sudah sinkron (di-skip oleh Smart Sync)
    if (url.pathname === '/mark-synced' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }

      try {
        const body = await request.json();
        if (body.provinsiList && Array.isArray(body.provinsiList)) {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provinsi_sync_status (nama_provinsi TEXT PRIMARY KEY, terakhir_sukses TIMESTAMPTZ)`).run();
          
          const stmt = env.DB.prepare(`
            INSERT INTO provinsi_sync_status (nama_provinsi, terakhir_sukses)
            VALUES (?, datetime('now', '+7 hours'))
            ON CONFLICT(nama_provinsi) DO UPDATE SET terakhir_sukses = excluded.terakhir_sukses
          `);
          
          const batch = body.provinsiList.map(p => stmt.bind(p));
          await env.DB.batch(batch);
        }
        return Response.json({ ok: true });
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
