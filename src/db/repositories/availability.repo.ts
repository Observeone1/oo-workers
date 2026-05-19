import { sql as pg } from '../../config/db.ts';

export interface AvailabilityDay {
  date: string; // YYYY-MM-DD
  total: number;
  passed: number;
}

export async function getFleetAvailability(days: number): Promise<AvailabilityDay[]> {
  // UNION ALL across all six execution tables, grouped by UTC calendar day.
  // Status values: agent writes 'SUCCESS'/'FAILED'; legacy rows may use 'up'/'passed'.
  const rows = await pg`
    SELECT day::date AS date,
           SUM(total)::int  AS total,
           SUM(passed)::int AS passed
    FROM (
      SELECT date_trunc('day', start_time) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM url_monitor_executions
      WHERE start_time >= NOW() - make_interval(days => ${days})
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', start_time) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM api_executions
      WHERE start_time >= NOW() - make_interval(days => ${days})
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', start_time) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM tcp_executions
      WHERE start_time >= NOW() - make_interval(days => ${days})
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', start_time) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM udp_executions
      WHERE start_time >= NOW() - make_interval(days => ${days})
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', start_time) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM db_executions
      WHERE start_time >= NOW() - make_interval(days => ${days})
      GROUP BY 1
      UNION ALL
      SELECT date_trunc('day', started_at) AS day,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status IN ('SUCCESS','up','passed'))::int AS passed
      FROM qa_test_executions
      WHERE started_at >= NOW() - make_interval(days => ${days})
      GROUP BY 1
    ) t
    GROUP BY day
    ORDER BY day
  `;

  // Build a full N-slot array (oldest → newest), filling gaps with zeros.
  const now = new Date();
  const byDate = new Map<string, { total: number; passed: number }>();
  for (const row of rows) {
    const key = (row.date as Date | string).toString().slice(0, 10);
    byDate.set(key, { total: Number(row.total), passed: Number(row.passed) });
  }

  return Array.from({ length: days }, (_, i) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    const date = d.toISOString().slice(0, 10);
    const row = byDate.get(date);
    return { date, total: row?.total ?? 0, passed: row?.passed ?? 0 };
  });
}
