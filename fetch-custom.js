require('dotenv').config();
const fs = require('fs');

const WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://fetch-data-belajar-sync.dunia-sekolah.workers.dev';
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

const PROVINCES = {
  "010000": "DKI JAKARTA", "020000": "JAWA BARAT", "030000": "JAWA TENGAH", "040000": "DI YOGYAKARTA",
  "050000": "JAWA TIMUR", "060000": "ACEH", "070000": "SUMATERA UTARA", "080000": "SUMATERA BARAT",
  "090000": "RIAU", "100000": "JAMBI", "110000": "SUMATERA SELATAN", "120000": "LAMPUNG",
  "130000": "KALIMANTAN BARAT", "140000": "KALIMANTAN TENGAH", "150000": "KALIMANTAN SELATAN",
  "160000": "KALIMANTAN TIMUR", "170000": "SULAWESI UTARA", "180000": "SULAWESI TENGAH",
  "190000": "SULAWESI SELATAN", "200000": "SULAWESI TENGGARA", "210000": "MALUKU", "220000": "BALI",
  "230000": "NUSA TENGGARA BARAT", "240000": "NUSA TENGGARA TIMUR", "250000": "PAPUA", "260000": "BENGKULU",
  "270000": "MALUKU UTARA", "280000": "BANTEN", "290000": "KEPULAUAN BANGKA BELITUNG", "300000": "GORONTALO",
  "310000": "KEPULAUAN RIAU", "320000": "PAPUA BARAT", "330000": "SULAWESI BARAT", "340000": "KALIMANTAN UTARA",
  "350000": "PAPUA SELATAN", "360000": "PAPUA TENGAH", "370000": "PAPUA PEGUNUNGAN", "380000": "PAPUA BARAT DAYA"
};

async function postBatchToWorker(dataList, bentukAktif, offset, isFinished, customSyncParams = null) {
  const payload = { dataList, bentukAktif, offset, isFinished, customSync: true };
  if (customSyncParams) {
    payload.bentukList = customSyncParams.bentukList;
    payload.namaProvinsi = customSyncParams.namaProvinsi;
    payload.waktuMulai = customSyncParams.waktuMulai;
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
  const argBentuk = process.env.PILIHAN_BENTUK || "Semua";
  const argProvinsi = (process.env.PILIHAN_PROVINSI || "Semua").trim().toUpperCase();
  const mulaiDariAwal = process.env.MULAI_DARI_AWAL === 'true';

  console.log(`Menjalankan sinkronisasi khusus...`);
  console.log(`- Bentuk Sekolah: ${argBentuk}`);
  console.log(`- Provinsi: ${argProvinsi}`);

  const bentukList = BENTUK_GROUP[argBentuk] || BENTUK_GROUP["Semua"];
  
  let kodeWilayahList = [];
  if (argProvinsi === "SEMUA" || argProvinsi === "") {
    kodeWilayahList.push("360");
  } else {
    const parts = argProvinsi.split(',').map(p => p.trim()).filter(p => p);
    for (const p of parts) {
      const foundCode = Object.keys(PROVINCES).find(k => PROVINCES[k] === p || k === p || PROVINCES[k].includes(p));
      if (foundCode) {
        kodeWilayahList.push(foundCode);
        console.log(`Provinsi dikenali: ${PROVINCES[foundCode]} (Kode: ${foundCode})`);
      } else {
        console.log(`Peringatan: Provinsi '${p}' tidak dikenali, akan diabaikan.`);
      }
    }
    if (kodeWilayahList.length === 0) {
      console.log(`Tidak ada provinsi valid yang dimasukkan. Menggunakan data seluruh Indonesia (360).`);
      kodeWilayahList.push("360");
    }
  }

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

  while (taskIndex < tasks.length) {
    if (Date.now() - startTime > LAMA_MAKSIMAL) {
      console.log("⚠️ Mendekati 5 jam! Berhenti untuk menghindari timeout GitHub.");
      fs.writeFileSync('lanjutkan_custom.json', JSON.stringify({ bentukIndex: taskIndex, offset, waktuMulai }));
      break;
    }

    const currentTask = tasks[taskIndex];
    const kodeWilayah = currentTask.prov;
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
        continue;
      }

      offset += limit;
      
      const provNameDB = kodeWilayah === "360" ? "SEMUA" : PROVINCES[kodeWilayah];
      const customParams = {
        bentukList,
        namaProvinsi: provNameDB,
        waktuMulai,
        isStart: isFirstBatch
      };
      
      const { stats } = await postBatchToWorker(dataList, bentukAktif, offset, false, customParams);
      isFirstBatch = false;
      
      console.log(`Offset ${offset - limit} [${bentukAktif}]: ${dataList.length} ditarik — ${stats.tidakBerubah} tetap, ${stats.baru} baru, ${stats.diperbarui} update.`);

      const jedaMs = stats.baru === 0 && stats.diperbarui === 0 ? 200 : 1000;
      await new Promise((resolve) => setTimeout(resolve, jedaMs));

    } catch (err) {
      console.error(`Gagal mengambil data dari API untuk bentuk ${bentukAktif}:`, err);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  if (taskIndex >= tasks.length) {
    console.log("✨ Melakukan pembersihan data yang tidak lagi ada di sumber...");
    
    for (const provCode of kodeWilayahList) {
      const provNameDB = provCode === "360" ? "SEMUA" : PROVINCES[provCode];
      try {
        const { stats } = await postBatchToWorker([], 'tk', 0, true, {
          bentukList,
          namaProvinsi: provNameDB,
          waktuMulai: waktuMulai
        });
        console.log(`🧹 Berhasil membersihkan data lama untuk ${provNameDB}. ${stats.dihapus || 0} sekolah dihapus.`);
      } catch (e) {
        console.error(`Gagal membersihkan data lama untuk ${provNameDB}:`, e);
      }
    }
    
    console.log("🎉 SINKRONISASI KHUSUS SELESAI!");
  }
}

fetchCustomData();
