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
        } catch (e) { } // Abaikan jika tabel belum ada

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

        const totalSynced = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
        const totalEstimasi = activeRow.total_estimasi || totalSynced || (isCustom ? 12654 : 553456);

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
        let sumApiDuplicates = 0;
        let sumAdjustedSelisih = 0;
        let diffCount = 0;

        if (compareCache) {
          lastChecked = compareCache.updated_at + ' WIB';
          compareCache.value.forEach(d => {
            compareMap[d.nama.replace(/[^A-Z]/g, '')] = d.selisih;
            if (d.selisih !== 0) hasDiffGlobal = true;

            sumTotalApi += d.total_api || 0;
            sumTotalDb += d.total_db || 0;
            sumApiDuplicates += d.api_duplicates || 0;
            sumAdjustedSelisih += d.selisih || 0;
            if (d.selisih !== 0) diffCount++;
          });
          compareCache.value.sort((a, b) => {
            const aDiff = a.selisih !== 0 ? 1 : 0;
            const bDiff = b.selisih !== 0 ? 1 : 0;
            if (aDiff !== bDiff) return bDiff - aDiff;
            return a.nama.localeCompare(b.nama);
          });

          compareHtml = compareCache.value.map((d, idx) => {
            const todayDate = new Date(new Date().getTime() + 7 * 60 * 60 * 1000).toISOString().split('T')[0];
            const isSyncedToday = d.terakhir_sukses && d.terakhir_sukses.split(' ')[0] === todayDate;

            let selisihColor = 'var(--danger)';
            let statusIcon = '⚠️ Berbeda';

            if (d.selisih === 0) {
              selisihColor = 'var(--success)';
              statusIcon = '✅ Sinkron';
            } else if (d.is_sinkron_walau_selisih) {
              selisihColor = 'var(--warning)';
              statusIcon = '✅ Berbeda';
            } else if (isSyncedToday) {
              selisihColor = 'var(--warning)';
              statusIcon = '✅ Selesai (Ada Data Gagal)';
            }

            const displayStyle = idx >= 5 ? 'display: none;' : '';
            const trClass = idx >= 5 ? 'hidden-row' : '';

            const warnings = [];
            if (d.api_duplicates > 0) warnings.push(`<span style="cursor: pointer; text-decoration: underline; color: var(--danger);" onclick="showDuplicateModal('${d.nama}')">⚠️ NPSN Ganda: ${d.api_duplicates}</span>`);
            if (d.api_empty_npsn > 0) warnings.push(`⚠️ NPSN Kosong: ${d.api_empty_npsn}`);
            if (d.api_unrecognized_shapes > 0) warnings.push(`⚠️ Bentuk Pendidikan Baru: ${d.api_unrecognized_shapes}`);

            // Fallback jika ada selisih yang belum teridentifikasi
            if (d.raw_selisih > 0 && d.api_duplicates === 0 && d.api_empty_npsn === 0 && d.api_unrecognized_shapes === 0) {
              warnings.push(`⚠️ Indikasi Data Invalid / Sinkron Terputus: ${d.raw_selisih}`);
            }

            const warningHtml = warnings.length > 0 ? `<div style="font-size: 11px; font-weight: 600; color: var(--danger); margin-top: 6px; line-height: 1.4;">${warnings.join('<br>')}</div>` : '';

            return `
                <tr class="${trClass}" style="border-bottom: 1px solid var(--border); ${displayStyle}">
                  <td style="padding: 12px 8px; font-weight: 600; color: var(--text);">${d.nama} <div style="font-size: 11px; color: var(--text-muted); font-weight: normal; margin-top: 4px;">Kode: ${d.kode}</div></td>
                  <td style="padding: 12px 8px; text-align: center; color: var(--info); font-weight: 600; font-size: 14px;">
                    ${d.total_api.toLocaleString('id-ID')}
                    ${warningHtml}
                  </td>
                  <td style="padding: 12px 8px; text-align: center; color: var(--primary-light); font-weight: 600; font-size: 14px;">
                    ${d.total_db.toLocaleString('id-ID')}
                  </td>
                  <td style="padding: 12px 8px; text-align: center; color: ${selisihColor}; font-weight: bold; font-size: 14px;">${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}</td>
                  <td style="padding: 12px 8px; text-align: center; color: ${selisihColor}; font-size: 12px; font-weight: 600;">${statusIcon}</td>
                </tr>
              `;
          }).join('');
          if (hasDiffGlobal) {
            compareHtml += '<tr class="hidden-row" style="display: none;"><td colspan="5" style="padding: 16px; text-align: center;"><div style="color: var(--text-muted); font-size: 12px; margin-bottom: 8px;">Ada data yang berbeda. Smart Sync akan otomatis memprioritaskan provinsi yang berselisih saja.</div></td></tr>';
          }

          // Tambahkan baris total
          let totalSelisihHtml = '';
          if (sumApiDuplicates > 0 && sumAdjustedSelisih !== 0) {
            totalSelisihHtml = `
              <div style="color: var(--success); font-weight: bold;">+${sumApiDuplicates.toLocaleString('id-ID')} ✅</div>
              <div style="color: var(--danger); font-weight: bold; margin-top: 4px;">${sumAdjustedSelisih > 0 ? '+' : ''}${sumAdjustedSelisih.toLocaleString('id-ID')} ⚠️</div>
            `;
          } else if (sumApiDuplicates > 0) {
            totalSelisihHtml = `<div style="color: var(--success); font-weight: bold;">+${sumApiDuplicates.toLocaleString('id-ID')} ✅</div>`;
          } else if (sumAdjustedSelisih !== 0) {
            totalSelisihHtml = `<div style="color: var(--danger); font-weight: bold;">${sumAdjustedSelisih > 0 ? '+' : ''}${sumAdjustedSelisih.toLocaleString('id-ID')} ⚠️</div>`;
          } else {
            totalSelisihHtml = `<div style="color: var(--success); font-weight: bold;">0</div>`;
          }

          compareHtml += `
             <tr class="hidden-row" style="display: none; border-top: 2px solid var(--border); font-weight: bold; background: rgba(0,0,0,0.03);">
               <td style="padding: 12px 8px; color: var(--text);">TOTAL KESELURUHAN</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--info); font-size: 14px;">${sumTotalApi.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; color: var(--primary-light); font-size: 14px;">${sumTotalDb.toLocaleString('id-ID')}</td>
               <td style="padding: 12px 8px; text-align: center; font-size: 14px; vertical-align: middle;">${totalSelisihHtml}</td>
               <td style="padding: 12px 8px; text-align: center; font-size: 12px;">${diffCount} Provinsi Berselisih</td>
             </tr>
           `;
        } else {
          compareHtml = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">Belum ada data perbandingan. Jalankan cron terlebih dahulu.</td></tr>';
        }

        const currentDate = new Date(new Date().getTime() + 7 * 60 * 60 * 1000);
        const currentDayOfWeek = currentDate.getDay() || 7;
        const isMandatoryUpdateDay = (currentDayOfWeek === 3 || currentDayOfWeek === 4);

        const SCHEDULE = {
          3: ["JAWA TIMUR", "JAWA TENGAH", "BANTEN", "LAMPUNG", "NUSA TENGGARA TIMUR", "RIAU", "SUMATERA BARAT", "DKI JAKARTA", "JAMBI", "DI YOGYAKARTA", "SULAWESI TENGGARA", "SULAWESI UTARA", "MALUKU", "MALUKU UTARA", "KEPULAUAN RIAU", "KEPULAUAN BANGKA BELITUNG", "PAPUA PEGUNUNGAN", "PAPUA TENGAH", "PAPUA BARAT DAYA", "LUAR NEGERI"],
          4: ["JAWA BARAT", "SUMATERA UTARA", "SULAWESI SELATAN", "SUMATERA SELATAN", "NUSA TENGGARA BARAT", "ACEH", "KALIMANTAN BARAT", "KALIMANTAN SELATAN", "SULAWESI TENGAH", "KALIMANTAN TENGAH", "KALIMANTAN TIMUR", "BALI", "BENGKULU", "SULAWESI BARAT", "GORONTALO", "PAPUA", "KALIMANTAN UTARA", "PAPUA BARAT", "PAPUA SELATAN"]
        };
        const nextDayOfWeek = (currentDayOfWeek === 3) ? 4 : 3; // Jika Rabu(3), besok(Kamis 4). Selain itu, antrean berikutnya di hari Rabu(3).
        const todaySchedule = SCHEDULE[currentDayOfWeek] || [];
        const tomorrowSchedule = SCHEDULE[nextDayOfWeek] || [];

        const todayDateWIB = currentDate.toISOString().split('T')[0];
        const diffData = compareCache && compareCache.value ? compareCache.value.filter(d => {
          const lastSuksesMs = provSyncMap[d.nama];
          d.isSyncedToday = lastSuksesMs && new Date(lastSuksesMs).toISOString().split('T')[0] === todayDateWIB;

          if (isMandatoryUpdateDay) {
            return todaySchedule.includes(d.nama) || tomorrowSchedule.includes(d.nama);
          } else {
            if (d.isSyncedToday) return false;
            if (Math.abs(d.selisih) === 0 || d.is_sinkron_walau_selisih) return false;
            return true;
          }
        }) : [];

        if (isMandatoryUpdateDay) {
          diffData.sort((a, b) => {
            const aIsToday = todaySchedule.includes(a.nama);
            const bIsToday = todaySchedule.includes(b.nama);
            if (aIsToday && !bIsToday) return -1;
            if (!aIsToday && bIsToday) return 1;
            if (aIsToday && bIsToday) return todaySchedule.indexOf(a.nama) - todaySchedule.indexOf(b.nama);
            return tomorrowSchedule.indexOf(a.nama) - tomorrowSchedule.indexOf(b.nama);
          });
        } else {
          diffData.sort((a, b) => {
            const aHasSynced = a.terakhir_sukses ? 1 : 0;
            const bHasSynced = b.terakhir_sukses ? 1 : 0;

            if (aHasSynced !== bHasSynced) {
              return aHasSynced - bHasSynced; // 0 (belum sinkron) duluan
            }

            const aIsDifferent = (Math.abs(a.selisih) > 0 && !a.is_sinkron_walau_selisih) ? 1 : 0;
            const bIsDifferent = (Math.abs(b.selisih) > 0 && !b.is_sinkron_walau_selisih) ? 1 : 0;

            if (aIsDifferent !== bIsDifferent) {
              return bIsDifferent - aIsDifferent; // 1 (berbeda) duluan
            }

            if (aHasSynced && bHasSynced) {
              const timeA = new Date(a.terakhir_sukses).getTime();
              const timeB = new Date(b.terakhir_sukses).getTime();
              if (timeA !== timeB) return timeA - timeB; // Terlama duluan agar bergiliran
            }

            const maxDiffA = Math.abs(a.selisih);
            const maxDiffB = Math.abs(b.selisih);
            return maxDiffB - maxDiffA; // Sisanya urutkan berdasarkan selisih terbesar
          });
        }

        const BATAS_AMAN = 500000;
        let syncedToday = 0;
        try {
          const { results: syncedTodayRes } = await env.DB.prepare("SELECT SUM(total_baru + total_diperbarui + total_tidak_berubah) as total FROM log_aktivitas_provinsi WHERE DATE(waktu_selesai) = DATE('now', '+7 hours')").all();
          syncedToday = syncedTodayRes[0]?.total || 0;
        } catch (e) { }

        if (isCustom && activeRow.updated_at) {
          const updatedAt = new Date(activeRow.updated_at.replace(' ', 'T') + '+07:00').getTime();
          if (Date.now() - updatedAt < 5 * 60000) {
            const currentRunning = (activeRow.total_baru || 0) + (activeRow.total_diperbarui || 0) + (activeRow.total_tidak_berubah || 0);
            syncedToday += currentRunning;
          }
        }
        const SISA_KUOTA = Math.max(0, BATAS_AMAN - syncedToday);
        let runningTotalEstimasi = 0;

        let activeProvince = null;
        let isActive = false;
        if (row2 && row2.updated_at) {
          const updatedAt = new Date(row2.updated_at.replace(' ', 'T') + '+07:00').getTime();
          if (Date.now() - updatedAt < 5 * 60000) {
            isActive = true;
            if (row2.bentuk_aktif) {
              const match = row2.bentuk_aktif.match(/\((.*?)\)/);
              if (match) activeProvince = match[1];
            }
          }
        }

        let bannerHtml = '';
        if (isMandatoryUpdateDay) {
          bannerHtml = `
            <div style="background: rgba(99, 102, 241, 0.1); border-left: 4px solid var(--primary); padding: 12px 16px; border-radius: 0 8px 8px 0; margin-top: 24px; margin-bottom: 24px;">
              <strong style="color: var(--primary);">🗓️ Hari Sinkronisasi Penuh Aktif!</strong>
              <div style="font-size: 13px; margin-top: 4px; color: var(--text-muted);">
                Setiap Rabu dan Kamis, sistem memperbarui seluruh provinsi sesuai grup tanpa mengecek perbedaan. Hari ini: <strong>${currentDayOfWeek === 3 ? 'Grup 1 (Rabu)' : 'Grup 2 (Kamis)'}</strong>.
              </div>
            </div>
          `;
        } else {
          bannerHtml = `
            <div style="background: rgba(16, 185, 129, 0.1); border-left: 4px solid var(--success); padding: 12px 16px; border-radius: 0 8px 8px 0; margin-top: 24px; margin-bottom: 24px;">
              <strong style="color: var(--success);">🧠 Mode Smart Sync Aktif!</strong>
              <div style="font-size: 13px; margin-top: 4px; color: var(--text-muted);">
                Di luar hari Rabu dan Kamis, sistem hanya menarik data untuk provinsi yang mendeteksi perbedaan secara cerdas.
              </div>
            </div>
          `;
        }

        const queueHtml = `
          <div id="queue-container">
          ${bannerHtml}
          <h2 style="font-size: 16px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 20px;">🤖</span> Antrean Smart Sync (Otomatis)
          </h2>
          <div style="background: rgba(0,0,0,0.02); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 24px;">
            <div style="padding: 12px 16px; background: rgba(0,0,0,0.03); font-size: 13px; color: var(--text-muted); border-bottom: 1px solid var(--border); line-height: 1.5;">
              Sistem secara cerdas mendeteksi provinsi mana yang butuh pembaruan. Provinsi dengan data tidak sinkron (belum pernah sukses) akan diprioritaskan, sedangkan yang sudah tersinkron namun berbeda akan digilir ke akhir antrean. 
              Maksimal <strong>~500.000 data</strong> disinkronisasi setiap harinya untuk menjaga limit <em>database</em>.
              <br>Kuota Harian Digunakan: <strong style="color: ${SISA_KUOTA <= 0 ? 'var(--danger)' : 'var(--warning)'}">${syncedToday.toLocaleString('id-ID')} / 500.000</strong>
              ${SISA_KUOTA <= 0 ? '<span style="color: var(--danger); font-weight: bold; margin-left: 8px;">⚠️ KUOTA PENUH, SISA ANTREAN DITUNDA BESOK</span>' : ''}
            </div>
            <div id="queue-table-wrapper" style="overflow-x: auto;">
            <table style="width: 100%; min-width: 500px; border-collapse: collapse; font-size: 13px;">
              <thead>
                <tr style="background: rgba(0,0,0,0.04); color: var(--text-muted); text-transform: uppercase; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;">
                  <th style="padding: 12px; text-align: left;">#</th>
                  <th style="padding: 12px; text-align: left;">Provinsi</th>
                  <th style="padding: 12px; text-align: center;">Estimasi Data</th>
                  <th style="padding: 12px; text-align: center;">Selisih</th>
                  <th style="padding: 12px; text-align: center;">Status Eksekusi</th>
                </tr>
              </thead>
              <tbody>
                ${diffData.length === 0 ? `
                  <tr><td colspan="5" style="padding: 24px; text-align: center; color: var(--success); font-weight: 600;">✅ Semua provinsi sudah sinkron sepenuhnya!</td></tr>
                ` : diffData.map((d, i) => {
          let isToday = false;

          if (!d.isSyncedToday) {
            const isFirstUnsynced = !diffData.slice(0, i).some(prev => !prev.isSyncedToday);
            if (runningTotalEstimasi + d.total_api <= SISA_KUOTA) {
              isToday = true;
              runningTotalEstimasi += d.total_api;
            } else if (isFirstUnsynced && SISA_KUOTA > 0) {
              isToday = true;
              runningTotalEstimasi += d.total_api;
            }
          }

          const isSynced = Math.abs(d.selisih) === 0 || d.is_sinkron_walau_selisih;
          let statusLabel = isToday ? '<span style="color: var(--warning); font-weight: 600;">⏳ Dieksekusi Hari Ini</span>' : '<span style="color: var(--text-muted);">Antre Besok</span>';

          let rowStyle = 'border-bottom: 1px solid var(--border);';
          if (d.isSyncedToday) {
            statusLabel = '<span style="color: var(--success); font-weight: 600;">✅ Selesai Hari Ini</span>';
          } else if (isActive && activeProvince === d.nama) {
            statusLabel = '<span style="color: var(--warning); font-weight: 600; display: flex; align-items: center; justify-content: center; gap: 4px;"><span class="spin-icon">🔄</span> Proses Sinkron</span>';
            rowStyle = 'border-bottom: 1px solid var(--border); background: rgba(245, 158, 11, 0.15);';
          }

          let selisihColor = 'var(--danger)';
          if (d.selisih === 0) {
            selisihColor = 'var(--success)';
          } else if (d.is_sinkron_walau_selisih) {
            selisihColor = 'var(--warning)';
          }
          const selisihVal = `${d.selisih > 0 ? '+' : ''}${d.selisih.toLocaleString('id-ID')}`;

          return `
                    <tr style="${rowStyle}">
                      <td style="padding: 12px; text-align: left; font-weight: bold; color: var(--text); font-size: 14px;">${i + 1}</td>
                      <td style="padding: 12px; text-align: left; font-weight: 600; color: var(--text); font-size: 14px;">${d.nama}</td>
                      <td style="padding: 12px; text-align: center; color: var(--info); font-weight: 600; font-size: 14px;">${d.total_api.toLocaleString('id-ID')}</td>
                      <td style="padding: 12px; text-align: center; color: ${selisihColor}; font-weight: bold; font-size: 14px;">${selisihVal}</td>
                      <td style="padding: 12px; text-align: center; font-size: 13px;">${statusLabel}</td>
                    </tr>
                  `;
        }).join('')}
              </tbody>
            </table>
            </div>
          </div>
          </div>
        `;

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
        } catch (e) { } // Abaikan jika tabel belum ada

        const totalPages = Math.ceil(totalLogs / limit) || 1;
        let paginationHtml = '';
        if (totalPages > 1) {
          paginationHtml = `<div id="log-pagination" style="display: flex; justify-content: center; gap: 8px; margin-top: 16px;">
            ${page > 1 ? `<a href="javascript:void(0)" onclick="changeLogPage(${page - 1})" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px; color: var(--text); text-decoration: none; font-size: 13px;">&laquo; Prev</a>` : ''}
            <span style="padding: 6px 12px; font-size: 13px; color: var(--text-muted);">Halaman ${page} dari ${totalPages}</span>
            ${page < totalPages ? `<a href="javascript:void(0)" onclick="changeLogPage(${page + 1})" style="padding: 6px 12px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 6px; color: var(--text); text-decoration: none; font-size: 13px;">Next &raquo;</a>` : ''}
          </div>`;
        }

        let logHtml = logAktivitasList.length > 0 ? logAktivitasList.map(log => {
          const totalData = log.total_baru + log.total_diperbarui + log.total_tidak_berubah;
          return `<div style="background: rgba(0,0,0,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 12px; font-size: 13px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
              <strong style="color: var(--text); font-size: 14px;">${log.nama_provinsi}</strong>
              <span style="color: var(--text-muted); font-size: 12px; font-weight: 500;">${log.waktu_selesai}</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center; font-size: 13px; font-weight: 600;">
              <div style="color: var(--success);">${log.total_baru} Baru</div>
              <div style="color: var(--info);">${log.total_diperbarui} Update</div>
              <div style="color: var(--danger);">${log.total_dihapus} Hapus</div>
              <div style="color: var(--text-muted);">${log.total_tidak_berubah} Tetap</div>
            </div>
            <div style="text-align: left; margin-top: 10px; font-weight: 700; font-size: 14px; color: var(--text); border-top: 1px solid var(--border); padding-top: 10px;">Total Data: ${totalData}</div>
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
      --bg: #f8fafc; --card: rgba(255, 255, 255, 0.85); --border: rgba(0, 0, 0, 0.1);
      --text: #0f172a; --text-muted: #64748b; --primary: #4f46e5; --primary-light: #6366f1;
      --success: #10b981; --info: #3b82f6; --danger: #ef4444; --warning: #f59e0b;
    }
    * { box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: linear-gradient(135deg, #f1f5f9, #e2e8f0);
      color: var(--text);
      display: flex; justify-content: center; align-items: flex-start;
      min-height: 100vh; margin: 0; padding: 40px 16px;
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
    .stat-box { background: rgba(0,0,0,0.02); border: 1px solid var(--border); border-radius: 16px; padding: 16px; }
    .stat-val { font-size: 20px; font-weight: 700; color: var(--text); }
    .stat-label { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    
    .progress-bar { height: 6px; background: var(--border); border-radius: 9999px; overflow: hidden; margin-top: 24px; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), #a855f7); transition: width 0.3s; }
    
    .loader {
      width: 48px; height: 48px; border: 5px solid var(--primary); border-bottom-color: transparent;
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
    .prov-item.processing { background: rgba(249, 115, 22, 0.2); border: 1px solid rgba(249, 115, 22, 0.35); }
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

    async function changeLogPage(page) {
      try {
        window.isAutoReloadPaused = true;
        const url = new URL(window.location.href);
        url.searchParams.set('page', page);
        url.searchParams.set('_t', new Date().getTime());
        
        // Tetap tampilkan loading state jika perlu, tapi karena cepat, biarkan saja
        const res = await fetch(url.toString(), { cache: 'no-store' });
        const html = await res.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        const newLogContainer = doc.getElementById('log-container');
        const currentLogContainer = document.getElementById('log-container');
        if (newLogContainer && currentLogContainer) {
          currentLogContainer.innerHTML = newLogContainer.innerHTML;
        }

        const newPagination = doc.getElementById('log-pagination');
        const currentPaginationWrapper = document.getElementById('log-pagination-wrapper');
        if (currentPaginationWrapper) {
          currentPaginationWrapper.innerHTML = newPagination ? newPagination.outerHTML : '';
        }
        
        // Update URL di browser tanpa me-refresh halaman
        window.history.pushState({}, '', url.toString());
      } catch(e) {
        console.error("Gagal mengganti halaman log", e);
      } finally {
        window.isAutoReloadPaused = false;
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

      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.set('_t', new Date().getTime());

      fetch(currentUrl.toString(), { cache: 'no-store' })
        .then(res => res.text())
        .then(html => {
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          
          const newCard = doc.querySelector('.card');
          const currentCard = document.querySelector('.card');
          
          if(doc) {
            // Update specific elements to prevent full DOM recreation and scroll interruption
            
             const loaderIcon = document.getElementById('loader-icon');
             const newLoaderIcon = doc.getElementById('loader-icon');
             if (loaderIcon && newLoaderIcon) { loaderIcon.style.display = newLoaderIcon.style.display; }

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
              if (isShowAll) {
                const newRows = newCompareBody.querySelectorAll('.hidden-row');
                newRows.forEach(r => r.style.display = 'table-row');
              }
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
            
            const queueContainer = document.getElementById('queue-container');
            const newQueueContainer = doc.getElementById('queue-container');
            if (queueContainer && newQueueContainer) {
              const queueWrapper = queueContainer.querySelector('#queue-table-wrapper');
              const currentScrollX = queueWrapper ? queueWrapper.scrollLeft : 0;
              queueContainer.innerHTML = newQueueContainer.innerHTML;
              const newQueueWrapper = queueContainer.querySelector('#queue-table-wrapper');
              if (newQueueWrapper) newQueueWrapper.scrollLeft = currentScrollX;
            }
            
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
        <div class="progress-fill" style="width: ${selesai ? 100 : progressPercent}%;"></div>
      </div>
      <div id="progress-stats" style="display: flex; justify-content: space-between; font-size: 13px; color: var(--text-muted); margin-top: 8px; font-weight: 500;">
        <span>${progressPercent}% Selesai</span>
        <span>Data: ${totalSynced} / ${totalEstimasi}</span>
      </div>
    </div>
    
    <h1 id="main-title">Sekolah Sync Dashboard ${isCustom ? '<span style="color: #f59e0b; font-size: 14px; vertical-align: middle; background: rgba(245, 158, 11, 0.15); padding: 4px 10px; border-radius: 20px;">Custom</span>' : '<span style="color: var(--primary-light); font-size: 14px; vertical-align: middle; background: rgba(99, 102, 241, 0.15); padding: 4px 10px; border-radius: 20px;">Full</span>'}</h1>
    <div id="main-info" style="font-size: 15px; color: var(--text); line-height: 1.5;">
      Bentuk Aktif: <strong style="color: var(--primary); text-transform: uppercase;">${bentukBerikutnya}</strong><br>
      Offset Saat Ini: <strong>${offsetBerikutnya}</strong><br>
      Update Terakhir: <strong style="color: var(--text);">${activeRow.updated_at || '-'} WIB</strong>
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
    
    ${queueHtml}
    
    <div style="margin-top: 32px; text-align: left;">
      <h2 style="font-size: 18px; margin-bottom: 16px; color: var(--text); font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--border);">Log Aktivitas Terakhir</h2>
      <div id="log-container" style="display: flex; flex-direction: column; gap: 8px;">
        ${logHtml}
      </div>
      <div id="log-pagination-wrapper">
        ${paginationHtml}
      </div>
    </div>

    <div style="margin-top: 32px; text-align: left;">
      <div id="compare-header-box" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 16px;">
        <div>
          <h2 style="font-size: 18px; color: var(--text); font-weight: 600; margin: 0 0 4px 0;">Perbandingan Data (Belajar.id vs DB)</h2>
          <div id="compare-last-checked" style="font-size: 12px; color: var(--text-muted);">Terakhir dicek: ${lastChecked}</div>
        </div>
        ${compareCache && compareCache.value.length > 5 ? `<button id="btn-compare" style="background: var(--primary); color: #fff; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: bold; transition: background 0.2s;" onclick="toggleComparison()">Tampilkan Semua</button>` : ''}
      </div>
      <div id="compare-container" style="background: rgba(0,0,0,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 16px; font-size: 13px; overflow-x: auto;">
         <table id="compare-table" style="width: 100%; min-width: 550px; border-collapse: collapse;">
           <thead>
             <tr style="border-bottom: 1px solid var(--border); color: var(--text); font-weight: 600; text-align: left; background: rgba(0,0,0,0.02);">
               <th style="padding: 12px 8px;">Provinsi</th>
               <th style="padding: 12px 8px; text-align: center;">Belajar.id</th>
               <th style="padding: 12px 8px; text-align: center;">Database</th>
               <th style="padding: 12px 8px; text-align: center;">Selisih</th>
               <th style="padding: 12px 8px; text-align: center;">Status</th>
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
  <script>
    // Gunakan doAutoReload() bawaan yang sudah pintar mempertahankan state tabel dan scroll
    
    async function showDuplicateModal(provinsi) {
      window.isAutoReloadPaused = true; // Pause auto reload when modal is open
      const modal = document.getElementById('duplicate-modal');
      const title = document.getElementById('modal-title');
      const content = document.getElementById('modal-content');
      
      title.innerText = 'Detail NPSN Ganda - Provinsi ' + provinsi;
      content.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);"><span class="spin-icon">🔄</span> Memuat data...</div>';
      modal.style.display = 'block';
      
      try {
        const res = await fetch('/api/duplicates-detail?provinsi=' + encodeURIComponent(provinsi) + '&_t=' + Date.now());
        const json = await res.json();
        if (json.success && json.data && json.data.length > 0) {
          let html = '';
          json.data.forEach(function(item) {
            html += '<div style="background: rgba(0,0,0,0.02); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 12px; border-left: 4px solid var(--danger);">' +
                    '<div style="font-weight: bold; color: var(--primary); font-size: 14px; margin-bottom: 8px;">NPSN: ' + item.npsn + '</div>' +
                    '<div style="display: flex; flex-direction: column; gap: 10px;">';
            item.sekolahList.forEach(function(s) {
              html += '<div style="padding-left: 8px; border-left: 2px solid var(--border); font-size: 13px;">' +
                      '<strong style="color: var(--text);">' + s.nama + '</strong> <span style="background: rgba(0,0,0,0.05); padding: 2px 6px; border-radius: 4px; font-size: 11px; text-transform: uppercase;">' + s.bentuk + '</span>' +
                      '<div style="color: var(--text-muted); margin-top: 4px;">Status: ' + s.status + ' | Kecamatan: ' + s.kecamatan + ' | Kabupaten: ' + s.kabupaten + '</div>' +
                      '<div style="color: var(--text-muted); font-size: 12px; margin-top: 2px;">Alamat: ' + (s.alamat || '-') + '</div>' +
                      '</div>';
            });
            html += '</div></div>';
          });
          content.innerHTML = html;
        } else {
          content.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted);">Tidak ada detail data NPSN ganda yang disimpan untuk provinsi ini. Jalankan sync ulang untuk memperbarui detail.</div>';
        }
      } catch (e) {
        content.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--danger);">Gagal memuat detail data: ' + e.message + '</div>';
      }
    }
    
    function closeDuplicateModal() {
      document.getElementById('duplicate-modal').style.display = 'none';
      window.isAutoReloadPaused = false; // Resume auto reload
    }
    
    // Close modal when clicking outside
    window.addEventListener('click', function(event) {
      const modal = document.getElementById('duplicate-modal');
      if (event.target === modal) {
        closeDuplicateModal();
      }
    });
  </script>
  
  <!-- Modal Detail NPSN Ganda -->
  <div id="duplicate-modal" style="display: none; position: fixed; z-index: 1000; left: 0; top: 0; width: 100%; height: 100%; overflow: auto; background-color: rgba(0,0,0,0.5); backdrop-filter: blur(4px);">
    <div style="background-color: #ffffff; margin: 10% auto; padding: 24px; border: 1px solid var(--border); width: 90%; max-width: 600px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.3); text-align: left; position: relative;">
      <span style="position: absolute; right: 20px; top: 15px; font-size: 24px; font-weight: bold; cursor: pointer; color: var(--text-muted);" onclick="closeDuplicateModal()">&times;</span>
      <h3 style="margin-top: 0; font-size: 16px; font-weight: 700; color: var(--text); border-bottom: 1px solid var(--border); padding-bottom: 10px;" id="modal-title">Detail NPSN Ganda</h3>
      <div id="modal-content" style="max-height: 400px; overflow-y: auto; margin-top: 15px;">
        <!-- Content will be populated by JS -->
      </div>
    </div>
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

        let synced_today = 0;
        try {
          const { results: syncedTodayRes } = await env.DB.prepare("SELECT SUM(total_baru + total_diperbarui + total_tidak_berubah) as total FROM log_aktivitas_provinsi WHERE DATE(waktu_selesai) = DATE('now', '+7 hours')").all();
          synced_today = syncedTodayRes[0]?.total || 0;
        } catch (e) { }

        if (!isCron) {
          const { results } = await env.DB.prepare("SELECT value FROM cache_data WHERE key = 'perbandingan'").all();
          if (results && results.length > 0) {
            return new Response(JSON.stringify({ success: true, data: JSON.parse(results[0].value), synced_today }), {
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
          } catch (e) {
            return { kode, nama: PROVINCES[kode], total_api: 0 };
          }
        });

        const apiData = await Promise.all(promises);

        // Fetch dari DB
        const { results: dbRes } = await env.DB.prepare(`
          SELECT 
            nama_provinsi as provinsi, 
            COUNT(*) as total_db,
            SUM(CASE WHEN bentuk_pendidikan IS NULL OR bentuk_pendidikan = '' OR bentuk_pendidikan = '-' THEN 1 ELSE 0 END) as tanpa_bentuk,
            SUM(CASE WHEN jenjang_pendidikan IS NULL OR jenjang_pendidikan = '' OR jenjang_pendidikan = '-' THEN 1 ELSE 0 END) as tanpa_jenjang,
            SUM(CASE WHEN nama_kabupaten IS NULL OR nama_kabupaten = '' OR nama_kabupaten = '-' THEN 1 ELSE 0 END) as tanpa_kabupaten,
            SUM(CASE WHEN nama_kecamatan IS NULL OR nama_kecamatan = '' OR nama_kecamatan = '-' THEN 1 ELSE 0 END) as tanpa_kecamatan,
            SUM(CASE WHEN nama_desa IS NULL OR nama_desa = '' OR nama_desa = '-' THEN 1 ELSE 0 END) as tanpa_desa
          FROM sekolah 
          GROUP BY nama_provinsi
        `).all();

        const cleanName = (name) => {
          if (!name) return "";
          let c = name.replace(/[^A-Z]/gi, '').toUpperCase();
          return c.replace(/^PROVINSI|^PROV/, '');
        };

        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provinsi_sync_status (nama_provinsi TEXT PRIMARY KEY, terakhir_sukses TIMESTAMPTZ)`).run();

        try {
          await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_duplicates INTEGER DEFAULT 0`).run();
        } catch (e) { }
        try {
          await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_empty_npsn INTEGER DEFAULT 0`).run();
        } catch (e) { }
        try {
          await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_unrecognized_shapes INTEGER DEFAULT 0`).run();
        } catch (e) { }

        const { results: syncStatusRes } = await env.DB.prepare('SELECT nama_provinsi, terakhir_sukses, api_duplicates, api_empty_npsn, api_unrecognized_shapes FROM provinsi_sync_status').all();
        const syncStatusMap = {};
        const duplicatesMap = {};
        const emptyNpsnMap = {};
        const unrecognizedShapesMap = {};
        if (syncStatusRes) {
          syncStatusRes.forEach(r => {
            syncStatusMap[cleanName(r.nama_provinsi)] = r.terakhir_sukses;
            duplicatesMap[cleanName(r.nama_provinsi)] = r.api_duplicates || 0;
            emptyNpsnMap[cleanName(r.nama_provinsi)] = r.api_empty_npsn || 0;
            unrecognizedShapesMap[cleanName(r.nama_provinsi)] = r.api_unrecognized_shapes || 0;
          });
        }

        const dbMap = {};
        dbRes.forEach(r => {
          dbMap[cleanName(r.provinsi)] = {
            total_db: r.total_db,
            tanpa_bentuk: r.tanpa_bentuk || 0,
            tanpa_jenjang: r.tanpa_jenjang || 0,
            tanpa_kabupaten: r.tanpa_kabupaten || 0,
            tanpa_kecamatan: r.tanpa_kecamatan || 0,
            tanpa_desa: r.tanpa_desa || 0
          };
        });

        // Hapus hardcode API_DUPLICATES, gunakan data dinamis dari duplicatesMap

        const comparison = apiData.map(d => {
          // Fallback manual jika database belum sempat diisi (misal PAPUA)
          let duplicateOffset = duplicatesMap[cleanName(d.nama)] || 0;
          if (d.kode === '250000' && duplicateOffset === 0) duplicateOffset = 1;

          const adjustedTotalApi = d.total_api - duplicateOffset;
          const emptyNpsnOffset = emptyNpsnMap[cleanName(d.nama)] || 0;
          const dbData = dbMap[cleanName(d.nama)] || { total_db: 0, tanpa_bentuk: 0, tanpa_jenjang: 0, tanpa_kabupaten: 0, tanpa_kecamatan: 0, tanpa_desa: 0 };
          const total_db = dbData.total_db;
          const selisih = adjustedTotalApi - total_db;
          const raw_selisih = d.total_api - total_db;

          const is_sinkron_walau_selisih = selisih !== 0 && selisih === emptyNpsnOffset;

          return {
            ...d,
            terakhir_sukses: syncStatusMap[cleanName(d.nama)],
            total_db,
            tanpa_bentuk: dbData.tanpa_bentuk,
            tanpa_jenjang: dbData.tanpa_jenjang,
            tanpa_kabupaten: dbData.tanpa_kabupaten,
            tanpa_kecamatan: dbData.tanpa_kecamatan,
            tanpa_desa: dbData.tanpa_desa,
            selisih,
            raw_selisih,
            api_duplicates: duplicateOffset,
            api_empty_npsn: emptyNpsnOffset,
            api_unrecognized_shapes: unrecognizedShapesMap[cleanName(d.nama)] || 0,
            is_sinkron_walau_selisih
          };
        });

        comparison.sort((a, b) => {
          const aDiff = (a.selisih !== 0 && !a.is_sinkron_walau_selisih) ? 1 : 0;
          const bDiff = (b.selisih !== 0 && !b.is_sinkron_walau_selisih) ? 1 : 0;
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

        return new Response(JSON.stringify({ success: true, data: comparison, synced_today }), {
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
        } catch (e) { }

        try {
          await env.DB.prepare(`ALTER TABLE status_sinkronisasi ADD COLUMN total_tanpa_npsn INTEGER DEFAULT 0`).run();
        } catch (e) { }

        if (dataList && dataList.length > 0) {
          stats = await syncBatch(env.DB, dataList);
        }

        // Jika mulai dari awal (tk atau ALL, offset 0), kita reset statistiknya
        let resetStats = "";
        if ((bentukAktif === 'tk' || bentukAktif === 'ALL') && offset === 0) {
          resetStats = ", total_baru = 0, total_diperbarui = 0, total_tidak_berubah = 0, total_dihapus = 0, waktu_mulai_sinkronisasi = datetime('now', '+7 hours')";
        }

        // Simpan log terakhir provinsi sukses
        if (isFinished && body.customSync && body.namaProvinsi && body.namaProvinsi !== 'SEMUA') {
          await env.DB.prepare(`CREATE TABLE IF NOT EXISTS provinsi_sync_status (nama_provinsi TEXT PRIMARY KEY, terakhir_sukses TIMESTAMPTZ)`).run();

          try {
            await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_duplicates INTEGER DEFAULT 0`).run();
          } catch (e) { }
          try {
            await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_empty_npsn INTEGER DEFAULT 0`).run();
          } catch (e) { }

          // Hitung api_duplicates: (totalEstimasi dari API) - (total_db setelah dihapus) - (total_tanpa_npsn yang di-skip)
          const { results: currentStatsRes } = await env.DB.prepare(`SELECT total_tanpa_npsn FROM status_sinkronisasi WHERE id = 2`).all();
          const totalTanpaNpsn = currentStatsRes[0]?.total_tanpa_npsn || 0;

          const searchProv = body.namaProvinsi === 'LUAR NEGERI' ? 'LUAR NEGERI' : `PROV. ${body.namaProvinsi}`;
          const { results: dbCountRes } = await env.DB.prepare(`SELECT COUNT(*) as total_db FROM sekolah WHERE nama_provinsi = ?`).bind(searchProv).all();
          const finalDbCount = dbCountRes[0]?.total_db || 0;

          let api_duplicates = (customParams.totalEstimasi || 0) - finalDbCount - totalTanpaNpsn - (customParams.unrecognized_shapes || 0);
          if (api_duplicates < 0) api_duplicates = 0;

          const isCleanScan = customParams.isCleanScan !== false;
          if (isCleanScan && customParams.duplicates) {
            api_duplicates = customParams.duplicates.length;
          }

          let extraColumns = '';
          let extraValues = '';
          let extraUpdates = '';
          let extraParams = [];
          if (customParams.unrecognized_shapes !== undefined) {
            extraColumns = ', api_unrecognized_shapes';
            extraValues = ', ?';
            extraUpdates = ', api_unrecognized_shapes = excluded.api_unrecognized_shapes';
            extraParams.push(customParams.unrecognized_shapes);
          }

          await env.DB.prepare(`
            INSERT INTO provinsi_sync_status (nama_provinsi, terakhir_sukses, api_duplicates, api_empty_npsn${extraColumns})
            VALUES (?, datetime('now', '+7 hours'), ?, ?${extraValues})
            ON CONFLICT(nama_provinsi) DO UPDATE SET 
              terakhir_sukses = excluded.terakhir_sukses,
              api_duplicates = excluded.api_duplicates,
              api_empty_npsn = excluded.api_empty_npsn
              ${extraUpdates}
          `).bind(body.namaProvinsi, api_duplicates, totalTanpaNpsn, ...extraParams).run();

          // Simpan detail NPSN ganda jika ada (hanya jika ini adalah clean scan dari client)
          if (isCleanScan) {
            await env.DB.prepare(`
              CREATE TABLE IF NOT EXISTS npsn_ganda_detail (
                npsn TEXT,
                nama_provinsi TEXT,
                sekolah_detail TEXT,
                PRIMARY KEY (npsn, nama_provinsi)
              )
            `).run();

            await env.DB.prepare(`
              DELETE FROM npsn_ganda_detail WHERE nama_provinsi = ?
            `).bind(body.namaProvinsi).run();

            if (customParams.duplicates && customParams.duplicates.length > 0) {
              const stmt = env.DB.prepare(`
                INSERT OR REPLACE INTO npsn_ganda_detail (npsn, nama_provinsi, sekolah_detail)
                VALUES (?, ?, ?)
              `);
              const batch = customParams.duplicates.map(d => stmt.bind(d.npsn, body.namaProvinsi, JSON.stringify(d.sekolahList)));
              await env.DB.batch(batch);
            }
          }
        }

        if (isFinished) {
          if (body.customSync) {
            // Karena kita berhenti mengupdate migrated_at untuk data yang tidak berubah (demi menghemat kuota D1),
            // pembersihan otomatis dilakukan dengan mencocokkan list NPSN aktif yang dikirim oleh worker.
            stats.dihapus = 0;
            if (body.activeNpsnList && body.activeNpsnList.length > 0) {
              const searchProv = body.namaProvinsi === 'LUAR NEGERI' ? 'LUAR NEGERI' : `PROV. ${body.namaProvinsi}`;

              let querySelect = `SELECT npsn FROM sekolah WHERE nama_provinsi = ?`;
              const selectParams = [searchProv];
              
              const isAllForms = body.bentukList && body.bentukList.includes('ALL');
              let bentukUppercase = [];
              if (!isAllForms && body.bentukList && body.bentukList.length > 0) {
                 bentukUppercase = body.bentukList.map(b => b.toUpperCase());
                 const placeholders = bentukUppercase.map(() => '?').join(',');
                 querySelect += ` AND bentuk_pendidikan IN (${placeholders})`;
                 selectParams.push(...bentukUppercase);
              }
              const { results: dbSchools } = await env.DB.prepare(querySelect).bind(...selectParams).all();

              const dbNpsnSet = new Set((dbSchools || []).map(r => r.npsn));

              // Hapus NPSN yang masih aktif (berarti sisanya adalah sekolah yang sudah tutup/dihapus)
              body.activeNpsnList.forEach(npsn => dbNpsnSet.delete(npsn));

              const deletedNpsns = Array.from(dbNpsnSet);
              const realDeletedNpsns = [];
              if (deletedNpsns.length > 0) {
                console.log(`Verifikasi ${deletedNpsns.length} NPSN calon dihapus ke API kementerian...`);
                // Batasi pengecekan maksimal 20 untuk meminimalkan subrequests Cloudflare Worker
                const checkList = deletedNpsns.slice(0, 20);
                const keepNpsns = new Set();
                
                await Promise.all(checkList.map(async (npsn) => {
                  try {
                    const res = await fetch(`https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?keyword=${npsn}&limit=1`);
                    const json = await res.json();
                    if (json.data && json.data.length > 0) {
                      keepNpsns.add(npsn);
                      console.log(`[Verify] NPSN ${npsn} masih aktif di kementerian. Pertahankan di DB.`);
                    }
                  } catch (e) {
                    keepNpsns.add(npsn); // Jika gagal cek, pertahankan untuk cari aman
                  }
                }));
                
                for (const npsn of deletedNpsns) {
                  if (!keepNpsns.has(npsn)) {
                    realDeletedNpsns.push(npsn);
                  }
                }
              }

              if (realDeletedNpsns.length > 0) {
                // Eksekusi penghapusan dalam chunk untuk menghindari limit parameter bind SQLite
                const chunkSize = 50;
                for (let i = 0; i < realDeletedNpsns.length; i += chunkSize) {
                  const chunk = realDeletedNpsns.slice(i, i + chunkSize);
                  
                  let queryDelete = `DELETE FROM sekolah WHERE npsn IN (${chunk.map(() => '?').join(',')}) AND nama_provinsi = ?`;
                  const deleteParams = [...chunk, searchProv];
                  if (!isAllForms && bentukUppercase.length > 0) {
                     const bentukPlaceholders = bentukUppercase.map(() => '?').join(',');
                     queryDelete += ` AND bentuk_pendidikan IN (${bentukPlaceholders})`;
                     deleteParams.push(...bentukUppercase);
                  }
                  
                  const delRes = await env.DB.prepare(queryDelete).bind(...deleteParams).run();
                  stats.dihapus += delRes.meta.changes;
                }
              }
            }

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

            // Hapus log aktivitas selain hari ini (kemarin dan sebelumnya)
            await env.DB.prepare(`
               DELETE FROM log_aktivitas_provinsi WHERE DATE(waktu_selesai) < DATE('now', '+7 hours')
            `).run();

            // Update status_sinkronisasi untuk id = 2 (Custom Sync)
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET total_dihapus = total_dihapus + ?, bentuk_aktif = 'Selesai', total_estimasi = ?, waktu_selesai_terakhir = datetime('now'), updated_at = datetime('now', '+7 hours')
              WHERE id = 2
            `).bind(stats.dihapus, customParams.totalEstimasi || 0).run();
          } else {
            await env.DB.prepare(`
              UPDATE status_sinkronisasi 
              SET bentuk_aktif = 'tk', offset_terakhir = 0, waktu_selesai_terakhir = datetime('now'), updated_at = datetime('now', '+7 hours')
              WHERE id = 1
            `).run();

            // Pembersihan berdasarkan migrated_at dinonaktifkan agar tidak menghapus data yang tidak ada perubahan.
            /*
            const delRes = await env.DB.prepare(`
              DELETE FROM sekolah WHERE migrated_at < (SELECT waktu_mulai_sinkronisasi FROM status_sinkronisasi WHERE id = 1)
            `).run();

            stats.dihapus = delRes.meta.changes;
            */
            stats.dihapus = 0;

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
              resetQuery = ', total_baru = excluded.total_baru, total_diperbarui = excluded.total_diperbarui, total_tidak_berubah = excluded.total_tidak_berubah, total_dihapus = 0, total_estimasi = excluded.total_estimasi, total_tanpa_npsn = excluded.total_tanpa_npsn';
            }
            // Upsert for id = 2
            await env.DB.prepare(`
              INSERT INTO status_sinkronisasi (id, bentuk_aktif, offset_terakhir, total_baru, total_diperbarui, total_tidak_berubah, total_estimasi, total_tanpa_npsn, updated_at, waktu_selesai_terakhir) 
              VALUES (2, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+7 hours'), datetime('now'))
              ON CONFLICT(id) DO UPDATE SET
                bentuk_aktif = excluded.bentuk_aktif,
                offset_terakhir = excluded.offset_terakhir,
                updated_at = excluded.updated_at,
                waktu_selesai_terakhir = excluded.waktu_selesai_terakhir
                ${resetQuery ? resetQuery : `, total_baru = status_sinkronisasi.total_baru + excluded.total_baru, total_diperbarui = status_sinkronisasi.total_diperbarui + excluded.total_diperbarui, total_tidak_berubah = status_sinkronisasi.total_tidak_berubah + excluded.total_tidak_berubah, total_estimasi = excluded.total_estimasi, total_tanpa_npsn = status_sinkronisasi.total_tanpa_npsn + excluded.total_tanpa_npsn`}
            `).bind(
              displayBentuk, offset, stats.baru, stats.diperbarui, stats.tidakBerubah, customParams.totalEstimasi || 0, stats.tanpaNpsn || 0
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

          try {
            await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_duplicates INTEGER DEFAULT 0`).run();
          } catch (e) { }
          try {
            await env.DB.prepare(`ALTER TABLE provinsi_sync_status ADD COLUMN api_empty_npsn INTEGER DEFAULT 0`).run();
          } catch (e) { }

          const stmt = env.DB.prepare(`
            INSERT INTO provinsi_sync_status (nama_provinsi, terakhir_sukses, api_duplicates, api_empty_npsn)
            VALUES (?, datetime('now', '+7 hours'), COALESCE(?, 0), COALESCE(?, 0))
            ON CONFLICT(nama_provinsi) DO UPDATE SET 
              terakhir_sukses = excluded.terakhir_sukses,
              api_duplicates = excluded.api_duplicates,
              api_empty_npsn = excluded.api_empty_npsn
          `);

          const batch = body.provinsiList.map(p => {
            if (typeof p === 'object' && p.nama) {
              return stmt.bind(p.nama, p.api_duplicates || 0, p.api_empty_npsn || 0);
            }
            return stmt.bind(p, 0, 0);
          });
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

    // Endpoint Detail NPSN Ganda (API)
    if (url.pathname === '/api/duplicates-detail' && request.method === 'GET') {
      try {
        const provinsi = url.searchParams.get('provinsi');
        if (!provinsi) {
          return new Response(JSON.stringify({ success: false, error: 'Provinsi parameter is required' }), { status: 400, headers: { 'content-type': 'application/json' } });
        }
        
        await env.DB.prepare(`
          CREATE TABLE IF NOT EXISTS npsn_ganda_detail (
            npsn TEXT,
            nama_provinsi TEXT,
            sekolah_detail TEXT,
            PRIMARY KEY (npsn, nama_provinsi)
          )
        `).run();

        const { results } = await env.DB.prepare(`
          SELECT npsn, sekolah_detail FROM npsn_ganda_detail WHERE nama_provinsi = ?
        `).bind(provinsi).all();

        const data = (results || []).map(r => ({
          npsn: r.npsn,
          sekolahList: JSON.parse(r.sekolah_detail)
        }));

        return new Response(JSON.stringify({ success: true, data }), {
          headers: { 
            'content-type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { 
          status: 500, 
          headers: { 'content-type': 'application/json' } 
        });
      }
    }

    // Endpoint untuk mendapatkan daftar bentuk pendidikan dinamis
    if (url.pathname === '/api/bentuk-pendidikan' && request.method === 'GET') {
      try {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bentuk_pendidikan (bentuk TEXT PRIMARY KEY)`).run();
        
        // Seed if empty
        const { results: countRes } = await env.DB.prepare(`SELECT COUNT(*) as count FROM bentuk_pendidikan`).all();
        if (countRes && countRes[0] && countRes[0].count === 0) {
          const defaultBentuk = [
            'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
            'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
            'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
            'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
            'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
            'smag-k'
          ];
          const statements = defaultBentuk.map(b => env.DB.prepare(`INSERT INTO bentuk_pendidikan (bentuk) VALUES (?)`).bind(b));
          await env.DB.batch(statements);
        }
        
        const { results } = await env.DB.prepare(`SELECT bentuk FROM bentuk_pendidikan`).all();
        return Response.json({ ok: true, data: results.map(r => r.bentuk) });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // Endpoint untuk mendaftarkan bentuk pendidikan baru
    if (url.pathname === '/api/bentuk-pendidikan' && request.method === 'POST') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const body = await request.json();
        const bentuk = (body.bentuk || '').toLowerCase().trim();
        if (!bentuk) {
          return Response.json({ ok: false, error: 'Bentuk cannot be empty' }, { status: 400 });
        }
        
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS bentuk_pendidikan (bentuk TEXT PRIMARY KEY)`).run();
        await env.DB.prepare(`INSERT OR IGNORE INTO bentuk_pendidikan (bentuk) VALUES (?)`).bind(bentuk).run();
        return Response.json({ ok: true, message: `Bentuk "${bentuk}" saved successfully` });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    // Endpoint untuk menghapus bentuk pendidikan
    if (url.pathname === '/api/bentuk-pendidikan' && request.method === 'DELETE') {
      const secret = url.searchParams.get('secret') || request.headers.get('x-cron-secret');
      if (!env.CRON_SECRET || secret !== env.CRON_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }
      try {
        const body = await request.json();
        const bentuk = (body.bentuk || '').toLowerCase().trim();
        if (!bentuk) {
          return Response.json({ ok: false, error: 'Bentuk cannot be empty' }, { status: 400 });
        }
        await env.DB.prepare(`DELETE FROM bentuk_pendidikan WHERE bentuk = ?`).bind(bentuk).run();
        return Response.json({ ok: true, message: `Bentuk "${bentuk}" deleted successfully` });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
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
