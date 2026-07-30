const os = require('os');

/**
 * Real machine metrics for the system monitor.
 *
 * Deliberately reports no GPU. This machine has no discrete GPU and Ollama
 * runs on the CPU, so a VRAM gauge would be a decoration showing a number
 * nothing produced. The monitor shows what is actually measurable.
 */

/*
 * CPU usage needs two samples taken a known distance apart: os.cpus() times are
 * cumulative since boot, so a single reading gives the all-time average.
 *
 * Sampling on the caller's cadence does not work. Two clients polling (a
 * browser every 5s and anything else) each consumed and reset the other's
 * sample, leaving deltas of a few milliseconds — one busy core in that window
 * reads as 100%. Measured 100% against Windows' own 62%.
 *
 * So the module samples itself on a fixed interval and readers get the last
 * computed value. The number no longer depends on who asks, or how often.
 */
/**
 * A short rolling window so the dashboard can draw a line rather than a single
 * number. Kept in memory: it is a live view, not something worth persisting.
 */
const HISTORY_POINTS = 60;
const history = { cpu: [], memory: [] };

const SAMPLE_MS = 2000;
let previous = null;
let lastPercent = null;

function cpuTotals() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    for (const kind of Object.keys(cpu.times)) total += cpu.times[kind];
    idle += cpu.times.idle;
  }

  return { idle, total, cores: cpus.length };
}

function sample() {
  const now = cpuTotals();

  if (previous) {
    const idleDelta = now.idle - previous.idle;
    const totalDelta = now.total - previous.total;
    if (totalDelta > 0) {
      lastPercent = Math.round(100 * (1 - idleDelta / totalDelta));
    }
  }

  previous = now;
  record();
}

sample();
// unref so a sampling timer never keeps the process alive on shutdown.
const timer = setInterval(sample, SAMPLE_MS);
if (typeof timer.unref === 'function') timer.unref();

function cpuUsagePercent() {
  // null until the first interval elapses — better than a misleading 0%.
  return { percent: lastPercent, cores: os.cpus().length };
}

function memory() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    usedGb: Number((used / 1024 ** 3).toFixed(1)),
    totalGb: Number((total / 1024 ** 3).toFixed(1)),
    percent: Math.round((used / total) * 100)
  };
}

function record() {
  const m = memory();
  history.cpu.push(lastPercent);
  history.memory.push(m.percent);
  if (history.cpu.length > HISTORY_POINTS) history.cpu.shift();
  if (history.memory.length > HISTORY_POINTS) history.memory.shift();
}

function systemMetrics() {
  const cpu = cpuUsagePercent();

  return {
    cpu: { percent: cpu.percent, cores: cpu.cores, history: [...history.cpu] },
    memory: { ...memory(), history: [...history.memory] },
    // Explicit, so the UI can say "CPU only" instead of leaving a blank card
    // that looks like a failed reading.
    gpu: { available: false, reason: 'No discrete GPU — Ollama runs on the CPU' },
    process: {
      uptimeSec: Math.round(process.uptime()),
      heapMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    },
    platform: `${os.type()} ${os.release()}`
  };
}

module.exports = { systemMetrics };
