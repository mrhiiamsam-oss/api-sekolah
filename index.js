require('dotenv').config();
const fs = require('fs');

const WORKER_URL = process.env.CLOUDFLARE_WORKER_URL || 'https://YOUR_WORKER_URL_HERE.workers.dev';
const CRON_SECRET = process.env.CRON_SECRET;

if (!CRON_SECRET) {
  console.error('CRON_SECRET belum diatur. Tambahkan secret CRON_SECRET di GitHub.');
  process.exit(1);
}

const VALID_BENTUK = [
  'tk', 'kb', 'sps', 'tpa', 'paudq', 'sd', 'smp', 'sma', 'smk', 'slb',
  'skb', 'pkbm', 'kursus', 'ra', 'mi', 'mts', 'ma',
  'smak', 'smptk', 'smtk', 'sdtk', 'spk-kb', 'spk-sd', 'spk-sma', 'spk-smp', 'spk-tk',
  'spm-ula', 'spm-ulya', 'spm-wustha', 'taman-seminari', 'pdf-ulya', 'pdf-wustha',
  'mak', 'mula-dhammasekha', 'nava-dhammasekha', 'uttama-dhammasekha', 'pondok-pesantren',
  'smag-k'
];

async function getWorkerState() {
  const res = await fetch(`${WORKER_URL}/state`);
  if (!res.ok) {
    throw new Error('Gagal mengambil state dari Worker: ' + await res.text());
  }
  return await res.json();
}

async function postBatchToWorker(dataList, bentukAktif, offset, isFinished) {
  const res = await fetch(`${WORKER_URL}/sync-batch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-cron-secret': CRON_SECRET
    },
    body: JSON.stringify({ dataList, bentukAktif, offset, isFinished })
  });

  if (!res.ok) {
    throw new Error('Gagal push batch ke Worker: ' + await res.text());
  }
  return await res.json();
}

async function fetchDataAndInsert() {
  console.log("Memulai Sinkronisasi via Github Actions -> Cloudflare Worker (D1)");

  const mulaiDariAwal =
    process.argv.includes('--awal') ||
    ['1', 'true', 'yes'].includes(String(process.env.MULAI_DARI_AWAL || '').toLowerCase());

  let bentukAktif = 'tk';
  let offset = 0;

  if (mulaiDariAwal) {
    console.log('Mulai dari awal (bentuk direset ke tk, offset direset ke 0).');
    // Sinkronisasi status awal ke D1 via API dummy call jika diperlukan
    await postBatchToWorker([], 'tk', 0, false);
  } else {
    const state = await getWorkerState();
    bentukAktif = state.bentuk_aktif || 'tk';
    offset = parseInt(state.offset_terakhir, 10) || 0;
    console.log(`Melanjutkan sinkronisasi [${bentukAktif.toUpperCase()}] dari offset: ${offset}`);
  }

  const limit = 20;
  let hasMoreData = true;

  const startTime = Date.now();
  const LAMA_MAKSIMAL = 5 * 60 * 60 * 1000; // 5 jam

  while (hasMoreData) {
    if (Date.now() - startTime > LAMA_MAKSIMAL) {
      console.log("⚠️ Mendekati 5 jam! Berhenti untuk menghindari timeout GitHub.");
      fs.writeFileSync('lanjutkan.txt', 'true');
      break;
    }

    const url = `https://api.data.belajar.id/data-portal-backend/v2/master-data/satuan-pendidikan/daftar-data-induk/360?limit=${limit}&offset=${offset}&bentukPendidikan=${bentukAktif}`;

    try {
      console.log(`Mengecek API [${bentukAktif.toUpperCase()}] offset ${offset}...`);
      const response = await fetch(url);
      const result = await response.json();
      const dataList = result.data;

      if (!dataList || dataList.length === 0) {
        const currentIndex = VALID_BENTUK.indexOf(bentukAktif);
        const nextIndex = currentIndex + 1;

        if (nextIndex < VALID_BENTUK.length) {
          bentukAktif = VALID_BENTUK[nextIndex];
          offset = 0;
          console.log(`➡️ Selesai untuk tipe sekolah ini. Pindah ke bentuk pendidikan berikutnya: [${bentukAktif.toUpperCase()}]`);
          await postBatchToWorker([], bentukAktif, offset, false);
          continue;
        } else {
          hasMoreData = false;
          console.log("🎉 SINKRONISASI SELESAI PENUH! Semua bentuk pendidikan telah disinkronkan.");
          await postBatchToWorker([], 'tk', 0, true);
          break;
        }
      }

      offset += limit;
      
      const { stats } = await postBatchToWorker(dataList, bentukAktif, offset, false);

      console.log(
        `Offset ${offset - limit} [${bentukAktif}]: ${dataList.length} dari API — ` +
        `${stats.tidakBerubah} tidak berubah, ${stats.baru} baru, ${stats.diperbarui} diperbarui.`
      );

      const jedaMs = stats.baru === 0 && stats.diperbarui === 0 ? 200 : 1000;
      await new Promise((resolve) => setTimeout(resolve, jedaMs));

    } catch (error) {
      console.error("Terjadi kesalahan jaringan:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log("Proses fetch selesai.");
}

fetchDataAndInsert();
