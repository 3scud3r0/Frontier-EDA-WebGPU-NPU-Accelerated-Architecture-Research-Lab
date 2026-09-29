const $ = id => document.getElementById(id);
const fmt = n => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const rate = n => {
  n = Number(n || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} G/s`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} M/s`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)} K/s`;
  return `${n.toFixed(0)}/s`;
};

export class Dashboard {
  constructor() {
    this.els = {
      hdl: $('hdl-source'), asm: $('asm-source'), log: $('event-log'), netlist: $('netlist-table'),
      heatmap: $('silicon-heatmap'), timing: $('timing-chart'), branch: $('branch-chart'),
      gpuBackend: $('gpu-backend'), gpuAdapter: $('gpu-adapter'), gpuRate: $('gpu-rate'), gpuGates: $('gpu-gates'),
      npuBackend: $('npu-backend'), npuAccuracy: $('npu-accuracy'), npuPredictions: $('npu-predictions'),
      pc: $('cpu-pc'), ir: $('cpu-ir'), cycles: $('cpu-cycles'), cache: $('cache-rate'), shared: $('shared-state'),
      gateCount: $('metric-gates'), depth: $('metric-depth'), critical: $('metric-critical'), aiSavings: $('metric-ai-savings'),
      isolation: $('isolation-state'), status: $('status-line'), stress: $('stress-copies'),
      verilog: $('verilog-output'), optimization: $('optimization-output'),
    };
    this.handlers = new Map();
  }

  on(id, handler) { $(id)?.addEventListener('click', handler); return this; }
  onChange(id, handler) { $(id)?.addEventListener('change', handler); return this; }
  hdl() { return this.els.hdl.value; }
  asm() { return this.els.asm.value; }
  stressCopies() { return Number(this.els.stress.value || 1); }
  setSources({ hdl, asm }) { if (hdl != null) this.els.hdl.value = hdl; if (asm != null) this.els.asm.value = asm; }

  log(message, kind = 'info') {
    const time = new Date().toLocaleTimeString();
    this.els.log.textContent += `[${time}] ${kind.toUpperCase()} ${message}\n`;
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  setStatus(message, kind = 'ok') {
    this.els.status.textContent = message;
    this.els.status.dataset.kind = kind;
  }

  updateIsolation(isolated) {
    this.els.isolation.textContent = isolated ? 'COI / SAB READY' : 'DEGRADED';
    this.els.isolation.dataset.ok = isolated ? '1' : '0';
  }

  updateNetlist(stats, ai = null) {
    this.els.gateCount.textContent = fmt(stats.nandGates);
    this.els.depth.textContent = fmt(stats.logicDepth);
    this.els.critical.textContent = `${fmt(stats.estimatedCriticalPathTicks)} ticks`;
    this.els.aiSavings.textContent = ai ? fmt(ai.estimatedGateSavings) : '—';
  }

  updateGPU({ backend, adapterInfo = {}, benchmark = null, gateCount = 0 }) {
    this.els.gpuBackend.textContent = backend;
    this.els.gpuAdapter.textContent = [adapterInfo.vendor, adapterInfo.architecture, adapterInfo.description].filter(Boolean).join(' / ') || 'n/a';
    this.els.gpuRate.textContent = benchmark ? rate(benchmark.gatesPerSecond) : '—';
    this.els.gpuGates.textContent = fmt(gateCount);
  }

  updateNPU(metrics) {
    this.els.npuBackend.textContent = metrics.backend || 'initializing';
    this.els.npuAccuracy.textContent = `${((metrics.accuracy || 0) * 100).toFixed(1)}%`;
    this.els.npuPredictions.textContent = fmt(metrics.predictions || 0);
  }

  updateCPU(snapshot) {
    this.els.pc.textContent = `0x${snapshot.pc.toString(16).padStart(4, '0').toUpperCase()}`;
    this.els.ir.textContent = `0x${snapshot.ir.toString(16).padStart(4, '0').toUpperCase()}`;
    this.els.cycles.textContent = fmt(snapshot.cycles);
    this.els.cache.textContent = `${(snapshot.cacheHitRate * 100).toFixed(1)}%`;
    this.els.shared.textContent = snapshot.shared ? 'SharedArrayBuffer' : 'ArrayBuffer fallback';
  }

  showNetlist(netlist) {
    const rows = [];
    const limit = Math.min(netlist.nodes.length, 120);
    for (let i = 0; i < limit; i++) {
      const node = netlist.nodes[i];
      rows.push(`<tr><td>${i}</td><td>${node.label}</td><td>${netlist.kind[i]}</td><td>${netlist.inputA[i]}</td><td>${netlist.inputB[i]}</td><td>${netlist.level[i]}</td><td>${netlist.fanout[i]}</td></tr>`);
    }
    this.els.netlist.innerHTML = rows.join('');
  }

  showOptimization(result) {
    const lines = [
      `backend: ${result.backend}`,
      `neural score: ${result.neuralScore == null ? 'n/a' : result.neuralScore.toFixed(4)}`,
      `duplicate NANDs: ${result.duplicateNands}`,
      `high fan-out nodes: ${result.highFanoutNodes}`,
      `estimated gate savings: ${result.estimatedGateSavings}`,
      '',
      ...result.suggestions.slice(0, 24).map(s => `${s.type.padEnd(7)} gate=${s.gate} ${s.reason}${s.fanout ? ` fanout=${s.fanout}` : ''}`),
    ];
    this.els.optimization.textContent = lines.join('\n');
  }

  showVerilog(code) { this.els.verilog.value = code; }
}
