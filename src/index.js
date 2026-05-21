import { runSync } from './sync.js';

/** Sabtu 16:00 UTC = Minggu 00:00 WITA — scan penuh dari offset 0 */
function isJadwalMingguanUtc() {
  const now = new Date();
  return now.getUTCDay() === 6 && now.getUTCHours() === 16 && now.getUTCMinutes() === 0;
}

export default {
  /** Dipanggil otomatis oleh Cloudflare Cron Triggers */
  async scheduled(event, env, ctx) {
    const now = new Date();
    // Kasus jika mingguan (atau harian) bertabrakan dengan tanggal 19 (jadwal bulanan GH Actions)
    if (now.getUTCDate() === 19) {
      console.log('Tanggal 19: Mengutamakan sinkronisasi bulanan dari GitHub Actions. CF Worker rehat.');
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
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(
        'Sinkron sekolah → Neon.\n' +
          'Cron: setiap 1 menit (lanjut) + Sabtu 16:00 UTC (dari awal).\n' +
          'Manual: GET /sync?secret=CRON_SECRET&awal=0|1\n',
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

    try {
      const result = await runSync(env, { mulaiDariAwal, maxDurationMs: 28000 });
      return Response.json(result, {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err) {
      return Response.json(
        { ok: false, error: err.message },
        { status: 500, headers: { 'content-type': 'application/json' } }
      );
    }
  },
};
