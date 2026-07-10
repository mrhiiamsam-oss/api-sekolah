require('dotenv').config();
const fs = require('fs');

const WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://YOUR_WORKER_URL_HERE.workers.dev';
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) {
  console.error('CRON_SECRET belum diatur. Tambahkan secret CRON_SECRET di GitHub.');
  process.exit(1);
}

const BENTUK_GROUP = {
  "Semua": ['tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb', 'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma', 'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk', 'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha', 'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren', 'smag-k'],
  "TK Sederajat": ['tk', 'ra', 'spk-tk', 'taman-seminari'],
  "KB Sederajat": ['kb', 'spk-kb', 'paudq'],
  "TPA & SPS": ['tpa', 'sps'],
  "SD Sederajat": ['sd', 'mi', 'sdtk', 'spk-sd', 'spm-ula', 'mula-dhammasekha'],
  "SMP Sederajat": ['smp', 'mts', 'smptk', 'spk-smp', 'spm-wustha', 'pdf-wustha', 'nava-dhammasekha'],
  "SMA Sederajat": ['sma', 'ma', 'smak', 'smtk', 'spk-sma', 'spm-ulya', 'pdf-ulya', 'uttama-dhammasekha', 'smag-k'],
  "SMK Sederajat": ['smk', 'mak'],
  "SLB": ['slb'],
  "Dikmas": ['pkbm', 'skb', 'kursus', 'pondok-pesantren']
};

let PROVINCES = {};

async function loadProvinces() {
  try {
    console.log("Mengambil referensi kode wilayah provinsi dari API Belajar.id...");
    const res = await fetch('https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/jumlah-data-induk/360?limit=100&offset=0');
    const result = await res.json();
    if (result && result.data) {
      result.data.forEach(p => {
        PROVINCES[p.kodeWilayah] = p.namaWilayah;
      });
      PROVINCES["350000"] = "LUAR NEGERI"; // Pastikan Luar Negeri terdaftar
    }
  } catch (e) {
    console.error("Gagal mengambil referensi provinsi, menggunakan mode fallback", e);
    // Fallback darurat
    PROVINCES = {
      "010000": "DKI JAKARTA", "020000": "JAWA BARAT", "030000": "JAWA TENGAH", "040000": "DI YOGYAKARTA",
      "050000": "JAWA TIMUR", "060000": "ACEH", "070000": "SUMATERA UTARA", "080000": "SUMATERA BARAT",
      "090000": "RIAU", "100000": "JAMBI", "110000": "SUMATERA SELATAN", "120000": "LAMPUNG",
      "130000": "KALIMANTAN BARAT", "140000": "KALIMANTAN TENGAH", "150000": "KALIMANTAN SELATAN",
      "160000": "KALIMANTAN TIMUR", "170000": "SULAWESI UTARA", "180000": "SULAWESI TENGAH",
      "190000": "SULAWESI SELATAN", "200000": "SULAWESI TENGGARA", "210000": "MALUKU", "220000": "BALI",
      "230000": "NUSA TENGGARA BARAT", "240000": "NUSA TENGGARA TIMUR", "250000": "PAPUA", "260000": "BENGKULU",
      "270000": "MALUKU UTARA", "280000": "BANTEN", "290000": "KEPULAUAN BANGKA BELITUNG", "300000": "GORONTALO",
      "310000": "KEPULAUAN RIAU", "320000": "PAPUA BARAT", "330000": "SULAWESI BARAT", "340000": "KALIMANTAN UTARA",
      "350000": "LUAR NEGERI", "360000": "PAPUA TENGAH", "370000": "PAPUA SELATAN", "380000": "PAPUA PEGUNUNGAN", 
      "390000": "PAPUA BARAT DAYA"
    };
  }
}

async function postBatchToWorker(dataList, bentukAktif, offset, isFinished, customSyncParams = null) {
  const payload = { dataList, bentukAktif, offset, isFinished, customSync: true };
  if (customSyncParams) {
    payload.bentukList = customSyncParams.bentukList;
    payload.namaProvinsi = customSyncParams.namaProvinsi;
    payload.waktuMulai = customSyncParams.waktuMulai;
    payload.isStart = customSyncParams.isStart;
    payload.totalEstimasi = customSyncParams.totalEstimasi;
  }
  const res = await fetch(`${WORKER_URL}/sync-batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Gagal push batch ke Worker: ' + await res.text());
  return await res.json();
}

async function fetchCustomData() {
  await loadProvinces();
  
  const argBentuk = process.env.PILIHAN_BENTUK || "Semua";
  const argProvinsi = (process.env.PILIHAN_PROVINSI || "Semua").trim().toUpperCase();
  const mulaiDariAwal = process.env.MULAI_DARI_AWAL === 'true';

  console.log(`Menjalankan sinkronisasi khusus...`);
  console.log(`- Bentuk Sekolah: ${argBentuk}`);
  console.log(`- Provinsi: ${argProvinsi}`);

  const bentukList = BENTUK_GROUP[argBentuk] || BENTUK_GROUP["Semua"];
  
  let kodeWilayahList = [];
  if (argProvinsi === "SEMUA" || argProvinsi === "") {
    kodeWilayahList = Object.keys(PROVINCES);
  } else {
    const parts = argProvinsi.split(',').map(p => p.trim()).filter(p => p);
    for (const p of parts) {
      const searchP = p.replace(/[^A-Z0-9]/g, '');
      // 1. Coba cari exact match dulu
      let foundCode = Object.keys(PROVINCES).find(k => {
        const cleanK = k.replace(/[^A-Z0-9]/g, '');
        const cleanV = PROVINCES[k].replace(/[^A-Z0-9]/g, '');
        return cleanK === searchP || cleanV === searchP;
      });
      // 2. Jika tidak ada, baru coba substring match (.includes)
      if (!foundCode) {
        foundCode = Object.keys(PROVINCES).find(k => {
          const cleanV = PROVINCES[k].replace(/[^A-Z0-9]/g, '');
          return cleanV.includes(searchP);
        });
      }
      if (foundCode) {
        kodeWilayahList.push(foundCode);
        console.log(`Provinsi dikenali: ${PROVINCES[foundCode]} (Kode: ${foundCode}) dari input '${p}'`);
      } else {
        console.log(`Peringatan: Provinsi '${p}' tidak dikenali, akan diabaikan.`);
      }
    }
    if (kodeWilayahList.length === 0) {
      console.log(`Tidak ada provinsi valid yang dimasukkan. Jatuh kembali ke sinkronisasi seluruh 39 provinsi.`);
      kodeWilayahList = Object.keys(PROVINCES);
    }
  }

  // --- SMART SYNC FILTER ---
  let skippedProvinces = [];
  try {
    console.log(`Mengambil data perbandingan (Smart Sync) dari ${WORKER_URL}/api/compare...`);
    const compareRes = await fetch(`${WORKER_URL}/api/compare`);
    if (compareRes.ok) {
      const compareJson = await compareRes.json();
      if (compareJson.success && compareJson.data) {
        // Provinsi yang butuh sinkron (selisih != 0)
        const diffCodes = compareJson.data.filter(d => Math.abs(d.selisih) > 0).map(d => d.kode);
        // Provinsi yang sudah sinkron (selisih == 0)
        const syncedCodes = compareJson.data.filter(d => d.selisih === 0).map(d => d.kode);

        // Prioritas 1: Provinsi jadwal hari ini yang butuh sinkron
        const primaryTargets = kodeWilayahList.filter(kode => diffCodes.includes(kode));
        
        // Catat provinsi jadwal hari ini yang sudah sinkron (untuk UI dashboard)
        skippedProvinces = kodeWilayahList.filter(kode => syncedCodes.includes(kode));

        // Prioritas 2 (SINKRON CERDAS): Provinsi HARI LAIN yang butuh sinkron
        const secondaryTargets = diffCodes.filter(kode => !kodeWilayahList.includes(kode));

        // Batasi berdasarkan JUMLAH DATA (bukan sekadar jumlah provinsi) untuk mencegah limit D1 Cloudflare.
        // Kuota aman penulisan baris per hari untuk Cloudflare D1 Free (Limit ~100k write/hari).
        const BATAS_AMAN_DATA_PER_HARI = 70000; 
        
        let totalDataSaatIni = 0;
        let finalTargets = [];

        // Fungsi pembantu untuk mencari estimasi total data provinsi
        const getTotalApi = (kode) => {
          const p = compareJson.data.find(d => d.kode === kode);
          return p ? p.total_api : 0;
        };

        // 1. Masukkan semua target jadwal hari ini terlebih dahulu (Prioritas Utama)
        for (const kode of primaryTargets) {
          finalTargets.push(kode);
          totalDataSaatIni += getTotalApi(kode);
        }

        // 2. SINKRON CERDAS: Jika kuota data harian masih tersisa, 'pinjam' dari hari lain 
        // yang muat dimasukkan ke dalam sisa kuota.
        if (totalDataSaatIni < BATAS_AMAN_DATA_PER_HARI) {
          for (const kode of secondaryTargets) {
            const estimasiData = getTotalApi(kode);
            if (totalDataSaatIni + estimasiData <= BATAS_AMAN_DATA_PER_HARI) {
              finalTargets.push(kode);
              totalDataSaatIni += estimasiData;
            }
          }
        }

        if (finalTargets.length === 0) {
          console.log(`✅ SEMUA PROVINSI SUDAH SINKRON. Tidak ada yang perlu disinkronkan. Membatalkan sinkronisasi untuk menghemat resource.`);
          kodeWilayahList = [];
        } else {
          console.log(`⚠️ Terdapat ${primaryTargets.length} provinsi jadwal hari ini dan ${finalTargets.length - primaryTargets.length} provinsi pinjaman jadwal lain yang akan disinkron.`);
          console.log(`🚀 Smart Sync akan menyinkronkan ${finalTargets.length} provinsi dengan total estimasi ~${totalDataSaatIni.toLocaleString('id-ID')} data (Batas Aman: ${BATAS_AMAN_DATA_PER_HARI.toLocaleString('id-ID')} per hari).`);
          kodeWilayahList = finalTargets;
        }

        // Tandai provinsi yang di-skip karena sudah sinkron ke database agar mendapat centang hijau di Dashboard
        if (skippedProvinces.length > 0) {
          const provNames = skippedProvinces.map(k => k === "350000" ? "LUAR NEGERI" : (PROVINCES[k] || "")).filter(n => n);
          if (provNames.length > 0) {
            console.log(`Menandai ${provNames.length} provinsi sebagai sinkron di database (agar UI Dashboard terceklis)...`);
            try {
              await fetch(`${WORKER_URL}/mark-synced`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-cron-secret': CRON_SECRET },
                body: JSON.stringify({ provinsiList: provNames })
              });
            } catch (err) {
              console.log(`Gagal memanggil /mark-synced: ${err.message}`);
            }
          }
        }
      } else {
        console.log(`Gagal mem-parsing data Smart Sync. Akan menyinkronkan target secara default.`);
      }
    } else {
      console.log(`Gagal menghubungi API Smart Sync. Akan menyinkronkan target secara default.`);
    }
  } catch (e) {
    console.log(`Error saat mengecek Smart Sync: ${e.message}. Akan menyinkronkan target secara default.`);
  }

  if (kodeWilayahList.length === 0) return;

  // Buat daftar antrean task: kombinasi tiap provinsi dan tiap bentuk sekolah
  const tasks = [];
  for (const prov of kodeWilayahList) {
    for (const bentuk of bentukList) {
      tasks.push({ prov, bentuk });
    }
  }

  let taskIndex = 0;
  let offset = 0;
  let waktuMulai = process.env.WAKTU_MULAI || "";

  if (!mulaiDariAwal) {
    taskIndex = parseInt(process.env.LANJUTAN_INDEX || '0', 10);
    offset = parseInt(process.env.LANJUTAN_OFFSET || '0', 10);
    if (taskIndex > 0 || offset > 0) {
      const t = tasks[Math.min(taskIndex, tasks.length - 1)];
      console.log(`Melanjutkan dari iterasi sebelumnya: Provinsi ${PROVINCES[t.prov] || 'SEMUA'}, Bentuk ${t.bentuk}, Offset ${offset}`);
    }
  }

  let isFirstBatch = false;
  if (!waktuMulai) {
    // Buat waktu mulai baru dalam format UTC+7 YYYY-MM-DD HH:MM:SS
    const d = new Date(new Date().getTime() + 7 * 3600 * 1000);
    waktuMulai = d.toISOString().replace('T', ' ').substring(0, 19);
    console.log(`Waktu mulai sync baru: ${waktuMulai}`);
    isFirstBatch = true;
  } else {
    console.log(`Menggunakan waktu mulai dari iterasi sebelumnya: ${waktuMulai}`);
  }

  const limit = 20;
  const startTime = Date.now();
  const LAMA_MAKSIMAL = 5 * 60 * 60 * 1000;

  let previousProv = null;
  let currentProvinceStarted = false;
  let currentTotalEstimasi = 0;

  while (taskIndex < tasks.length) {
    if (Date.now() - startTime > LAMA_MAKSIMAL) {
      console.log("⚠️ Mendekati 5 jam! Berhenti untuk menghindari timeout GitHub.");
      fs.writeFileSync('lanjutkan_custom.json', JSON.stringify({ bentukIndex: taskIndex, offset, waktuMulai }));
      break;
    }

    const currentTask = tasks[taskIndex];
    const kodeWilayah = currentTask.prov;
    
    if (kodeWilayah !== previousProv) {
      currentProvinceStarted = false;
      previousProv = kodeWilayah;
      
      try {
        const totalUrl = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=1&offset=0`;
        const totalRes = await fetch(totalUrl);
        const totalJson = await totalRes.json();
        currentTotalEstimasi = totalJson.meta ? totalJson.meta.total : 0;
        console.log(`📊 Estimasi total data untuk provinsi ${kodeWilayah}: ${currentTotalEstimasi}`);
      } catch (err) {
        console.error(`Gagal mendapatkan estimasi total data:`, err);
        currentTotalEstimasi = 0;
      }
    }

    const bentukAktif = currentTask.bentuk;
    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/${kodeWilayah}?limit=${limit}&offset=${offset}&bentukPendidikan=${bentukAktif}`;

    try {
      console.log(`Mengecek API [${bentukAktif.toUpperCase()}] wilayah ${kodeWilayah} offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      const dataList = result.data || [];

      if (dataList.length === 0) {
        offset = 0;
        taskIndex++;
        console.log(`➡️ Selesai untuk tipe sekolah [${bentukAktif.toUpperCase()}] wilayah ${kodeWilayah}. Pindah ke antrean berikutnya.`);
        
        const isProvinceFinished = taskIndex >= tasks.length || tasks[taskIndex].prov !== kodeWilayah;
        if (isProvinceFinished) {
          console.log(`✨ Selesai sinkronisasi seluruh bentuk untuk provinsi ${kodeWilayah}. Melakukan pembersihan...`);
          const provNameDB = kodeWilayah === "360" ? "SEMUA" : PROVINCES[kodeWilayah];
          try {
            const { stats } = await postBatchToWorker([], 'tk', 0, true, {
              bentukList,
              namaProvinsi: provNameDB,
              waktuMulai: waktuMulai
            });
            console.log(`🧹 Berhasil membersihkan data lama untuk ${provNameDB}. ${stats?.dihapus || 0} sekolah dihapus dan aktivitas dicatat.`);
          } catch (e) {
            console.error(`Gagal membersihkan data lama untuk ${provNameDB}:`, e);
          }
        }
        continue;
      }

      offset += limit;
      
      const provNameDB = kodeWilayah === "360" ? "SEMUA" : PROVINCES[kodeWilayah];
      const isStartProv = !currentProvinceStarted;
      
      const customParams = {
        bentukList,
        namaProvinsi: provNameDB,
        waktuMulai,
        isStart: isStartProv,
        totalEstimasi: currentTotalEstimasi
      };
      
      const { stats } = await postBatchToWorker(dataList, bentukAktif, offset, false, customParams);
      currentProvinceStarted = true;
      
      console.log(`Offset ${offset - limit} [${bentukAktif}]: ${dataList.length} ditarik — ${stats.tidakBerubah} tetap, ${stats.baru} baru, ${stats.diperbarui} update.`);

      const jedaMs = stats.baru === 0 && stats.diperbarui === 0 ? 200 : 1000;
      await new Promise((resolve) => setTimeout(resolve, jedaMs));

    } catch (err) {
      console.error(`Gagal mengambil data dari API untuk bentuk ${bentukAktif}:`, err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  if (taskIndex >= tasks.length) {
    console.log("🎉 SINKRONISASI KHUSUS SELESAI!");
  }
}

fetchCustomData();
