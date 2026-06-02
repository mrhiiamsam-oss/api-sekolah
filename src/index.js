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

    try {
      const result = await runSync(env, { mulaiDariAwal, maxDurationMs: 22000 });

      // Jika belum selesai, panggil dirinya sendiri secara asinkron untuk melanjutkan
      if (!result.selesai) {
        const nextUrl = new URL(request.url);
        nextUrl.searchParams.set('awal', 'false');

        ctx.waitUntil(
          fetch(nextUrl.toString(), {
            headers: {
              'x-cron-secret': env.CRON_SECRET || '',
            }
          })
          .then(res => res.text())
          .then(txt => console.log('Chained run response:', txt.substring(0, 200)))
          .catch(err => console.error('Chained run error:', err))
        );
      }

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
