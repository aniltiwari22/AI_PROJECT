const express = require('express');
const excelLogger = require('../logging/excelLogger');
const voiceLogger = require('../logging/voiceLogger');
const sqlite = require('../storage/sqlite');
const { systemMetrics } = require('./system');
const { storageBreakdown, modelInventory } = require('./storage');

const router = express.Router();

/**
 * Benchmark figures over the request log.
 *
 * Used to parse the whole AssistantLogs.xlsx workbook on every page load and
 * aggregate the rows in JavaScript. The log lives in SQLite now, so the
 * database does the grouping and only the summary crosses into Node.
 */

// Answered without invoking a model at all.
const INSTANT_ORIGINS = ['excel', 'cache', 'greeting'];

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// SQLite has no median aggregate, so the per-origin timings come back as a
// list and the middle value is taken here. Everything else is done in SQL.
function medianSecondsByOrigin(origin) {
  const rows = sqlite
    .stmt('SELECT response_ms FROM request_logs WHERE origin = ? AND response_ms IS NOT NULL')
    .all(origin);
  return median(rows.map((r) => r.response_ms / 1000));
}

router.get('/', async (req, res, next) => {
  try {
    const totals = sqlite
      .stmt(`SELECT COUNT(*) AS requests,
                    AVG(response_ms) / 1000.0 AS avgSeconds,
                    MIN(response_ms) / 1000.0 AS fastestSeconds,
                    MAX(response_ms) / 1000.0 AS slowestSeconds,
                    AVG(confidence) AS avgConfidence
             FROM request_logs WHERE origin IS NOT NULL`)
      .get();

    if (!totals || !totals.requests) {
      return res.json({
        success: true, empty: true, file: excelLogger.LOG_FILE, months: [], totals: null
      });
    }

    const months = sqlite
      .stmt(`SELECT substr(at, 1, 7) AS name, COUNT(*) AS requests
             FROM request_logs WHERE origin IS NOT NULL GROUP BY name ORDER BY name`)
      .all();

    const origins = sqlite
      .stmt(`SELECT origin, COUNT(*) AS count, AVG(response_ms) / 1000.0 AS avgSeconds
             FROM request_logs WHERE origin IS NOT NULL
             GROUP BY origin ORDER BY count DESC`)
      .all()
      .map((o) => ({
        origin: o.origin,
        count: o.count,
        share: Number(((o.count / totals.requests) * 100).toFixed(1)),
        avgSeconds: Number((o.avgSeconds || 0).toFixed(2)),
        medianSeconds: Number(medianSecondsByOrigin(o.origin).toFixed(2))
      }));

    const holes = INSTANT_ORIGINS.map(() => '?').join(',');
    const { instant } = sqlite
      .stmt(`SELECT COUNT(*) AS instant FROM request_logs WHERE origin IN (${holes})`)
      .get(...INSTANT_ORIGINS);

    const allTimes = sqlite
      .stmt('SELECT response_ms FROM request_logs WHERE response_ms IS NOT NULL')
      .all()
      .map((r) => r.response_ms / 1000);

    const topQuestions = sqlite
      .stmt(`SELECT lower(trim(question)) AS question, COUNT(*) AS count
             FROM request_logs
             WHERE question IS NOT NULL AND trim(question) <> ''
             GROUP BY question ORDER BY count DESC, question ASC LIMIT 8`)
      .all();

    res.json({
      success: true,
      file: excelLogger.LOG_FILE,
      engine: 'sqlite',
      months,
      totals: {
        requests: totals.requests,
        avgSeconds: Number((totals.avgSeconds || 0).toFixed(2)),
        medianSeconds: Number(median(allTimes).toFixed(2)),
        fastestSeconds: Number((totals.fastestSeconds || 0).toFixed(2)),
        slowestSeconds: Number((totals.slowestSeconds || 0).toFixed(2)),
        instantAnswers: instant,
        instantRate: Number(((instant / totals.requests) * 100).toFixed(1)),
        avgConfidence: Number((totals.avgConfidence || 0).toFixed(2))
      },
      origins,
      topQuestions
    });
  } catch (error) {
    next(error);
  }
});

// Live machine metrics for the system monitor. Separate from the aggregation
// above because it is polled every few seconds and must stay cheap.
router.get('/system', (req, res) => {
  res.json({ success: true, ...systemMetrics() });
});

// Where disk actually goes. Cached — walking the model directory is real I/O.
router.get('/storage', async (req, res, next) => {
  try {
    res.json({ success: true, ...(await storageBreakdown()) });
  } catch (error) {
    next(error);
  }
});

// Installed models with their real sizes and which are resident right now.
router.get('/models', async (req, res, next) => {
  try {
    res.json({ success: true, models: await modelInventory() });
  } catch (error) {
    next(error);
  }
});

/**
 * Writes the .xlsx workbooks from the database. The logs are no longer kept
 * as live spreadsheets, so this is how you get one to open in Excel.
 */
router.post('/export', async (req, res, next) => {
  try {
    const which = String(req.body?.which || 'all');
    const done = {};

    if (which === 'all' || which === 'requests') done.requests = await excelLogger.exportWorkbook();
    if (which === 'all' || which === 'voice') done.voice = await voiceLogger.exportWorkbook();

    if (!Object.keys(done).length) {
      return res.status(400).json({ success: false, error: 'which must be "requests", "voice" or "all"' });
    }

    res.json({ success: true, exported: done });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
