import { createBestFabric } from './compute/gpu_fabric.js';
import { DEFAULT_TINY_HDL, synthesizeToNand, replicateNetlist, netlistStats } from './hdl/netlist_graph.js';
import { NeuralPredictor, optimizeNetlistAI } from './intelligence/npu_core.js';
import { CPUStateShared, Slot, createSharedMemory } from './core/cpu_state.js';
import { assemble, DEFAULT_ASSEMBLY } from './core/assembler.js';
import { exportToVerilog, downloadVerilog } from './export/verilog.js';
import { Dashboard } from './ui/dashboard.js';
import { drawSiliconHeatmap, drawSeries, drawBranchAccuracy } from './ui/charts.js';
import { loadWorkspace, saveWorkspace } from './storage/persistence.js';

export async function bootstrapResearchLab() {
  const ui = new Dashboard();
  ui.updateIsolation(Boolean(globalThis.crossOriginIsolated));
  ui.setStatus('Initializing research engines…', 'busy');

  const saved = await loadWorkspace();
  ui.setSources({ hdl: saved?.hdl || DEFAULT_TINY_HDL, asm: saved?.asm || DEFAULT_ASSEMBLY });
  if (saved?.stressCopies) ui.els.stress.value = String(saved.stressCopies);

  const cpu = new CPUStateShared();
  const memory = createSharedMemory();
  const worker = new Worker(new URL('./core/cpu_worker.js', import.meta.url), { type: 'module' });
  worker.postMessage({ type: 'init', stateBuffer: cpu.buffer, memoryBuffer: memory.buffer });

  const predictor = new NeuralPredictor({ historyLength: 32 });
  const npuBackend = await predictor.initialize();
  ui.log(`Neural predictor backend: ${npuBackend}`);

  const { engine: fabric, backend: fabricBackend, error: fabricError } = await createBestFabric();
  ui.log(fabricError ? `WebGPU unavailable; CPU fallback active (${fabricError.message})` : 'WebGPU compute fabric initialized.');
  ui.updateGPU({ backend: fabricBackend, adapterInfo: fabric.adapterInfo });

  let baseNetlist = null;
  let activeNetlist = null;
  let lastAI = null;
  let timingHistory = [];
  let branchHistory = [];
  let lastTraceHead = 0;
  let processingTrace = false;

  async function synthesize({ benchmark = true } = {}) {
    ui.setStatus('Synthesizing TinyHDL → NAND graph…', 'busy');
    try {
      baseNetlist = synthesizeToNand(ui.hdl());
      const copies = ui.stressCopies();
      activeNetlist = replicateNetlist(baseNetlist, copies);
      fabric.loadNetlist(activeNetlist);
      const stats = netlistStats(baseNetlist);
      ui.updateNetlist(stats, lastAI);
      ui.showNetlist(baseNetlist);
      drawSiliconHeatmap(ui.els.heatmap, activeNetlist);
      ui.updateGPU({ backend: fabricBackend, adapterInfo: fabric.adapterInfo, gateCount: activeNetlist.gateCount });
      const inputValues = Object.fromEntries(baseNetlist.inputs.map((name, i) => [name, i & 1]));
      fabric.setInputs(inputValues);
      await fabric.settle();
      const activity = await fabric.readActivity();
      drawSiliconHeatmap(ui.els.heatmap, activeNetlist, activity);
      if (benchmark) {
        const iterations = Math.max(4, Math.min(200, Math.floor(12_000_000 / Math.max(1, activeNetlist.nandCount))));
        const result = await fabric.benchmark({ iterations, ticksPerIteration: 1 });
        timingHistory.push(result.gatesPerSecond / 1e6);
        timingHistory = timingHistory.slice(-180);
        drawSeries(ui.els.timing, timingHistory, { label: 'NAND throughput', valueFormatter: v => `${v.toFixed(2)} M/s` });
        ui.updateGPU({ backend: fabricBackend, adapterInfo: fabric.adapterInfo, benchmark: result, gateCount: activeNetlist.gateCount });
        ui.log(`Fabric benchmark: ${(result.gatesPerSecond / 1e6).toFixed(2)} M NAND eval/s across ${activeNetlist.nandCount.toLocaleString()} replicated NAND gates.`);
      }
      ui.setStatus(`Synthesis complete: ${baseNetlist.nandCount} NAND, stress fabric ${activeNetlist.nandCount.toLocaleString()} NAND.`, 'ok');
      return baseNetlist;
    } catch (error) {
      ui.setStatus(error.message, 'error');
      ui.log(error.stack || error.message, 'error');
      throw error;
    }
  }

  async function optimize() {
    if (!baseNetlist) await synthesize({ benchmark: false });
    ui.setStatus('Running edge EDA neural heuristic…', 'busy');
    lastAI = await optimizeNetlistAI(baseNetlist);
    ui.showOptimization(lastAI);
    ui.updateNetlist(netlistStats(baseNetlist), lastAI);
    ui.log(`EDA optimizer: ${lastAI.backend}; estimated savings ${lastAI.estimatedGateSavings} NAND.`);
    ui.setStatus('AI EDA analysis complete.', 'ok');
  }

  function exportVerilog(download = false) {
    if (!baseNetlist) throw new Error('Synthesize first.');
    const code = exportToVerilog(baseNetlist, { moduleName: `Frontier_${baseNetlist.chip}` });
    ui.showVerilog(code);
    if (download) downloadVerilog(baseNetlist, { moduleName: `Frontier_${baseNetlist.chip}` });
    ui.log('Synthesizable Verilog generated.');
    return code;
  }

  function loadProgram() {
    const result = assemble(ui.asm());
    worker.postMessage({ type: 'load', program: result.words.buffer.slice(0) });
    ui.log(`Assembler loaded ${result.words.length} words into CPU worker.`);
    return result;
  }

  async function save() {
    const result = await saveWorkspace({ hdl: ui.hdl(), asm: ui.asm(), stressCopies: ui.stressCopies() });
    ui.log(`Workspace saved via ${result.backend}.`);
    ui.setStatus('Workspace saved locally.', 'ok');
  }

  async function processTrace() {
    if (processingTrace) return;
    processingTrace = true;
    try {
      const head = cpu.get(Slot.TRACE_HEAD) >>> 0;
      const available = Math.min(head - lastTraceHead, 256);
      if (available > 0) lastTraceHead = Math.max(0, head - available);
      while (lastTraceHead < head) {
        const branch = cpu.readBranch(lastTraceHead);
        const prediction = await predictor.predict(branch.pc, branch.target);
        predictor.update(branch.pc, branch.target, branch.taken, prediction.taken);
        // Feed the learned prediction back into the shared branch-prediction table.
        // The CPU worker consumes this entry before resolving the next occurrence.
        const nextPrediction = await predictor.predict(branch.pc, branch.target);
        cpu.setBranchPrediction(branch.pc, branch.target, nextPrediction.taken);
        lastTraceHead++;
      }
      const metrics = predictor.metrics();
      ui.updateNPU(metrics);
      branchHistory.push(metrics.accuracy);
      branchHistory = branchHistory.slice(-180);
      drawBranchAccuracy(ui.els.branch, branchHistory);
    } finally {
      processingTrace = false;
    }
  }

  ui.on('btn-synthesize', () => synthesize().catch(() => {}));
  ui.on('btn-optimize', () => optimize().catch(error => ui.log(error.message, 'error')));
  ui.on('btn-export', () => { try { exportVerilog(true); } catch (error) { ui.log(error.message, 'error'); } });
  ui.on('btn-save', () => save().catch(error => ui.log(error.message, 'error')));
  ui.on('btn-cpu-load', () => { try { loadProgram(); } catch (error) { ui.log(error.message, 'error'); } });
  ui.on('btn-cpu-run', () => worker.postMessage({ type: 'run' }));
  ui.on('btn-cpu-pause', () => worker.postMessage({ type: 'pause' }));
  ui.on('btn-cpu-step', () => worker.postMessage({ type: 'step' }));
  ui.on('btn-cpu-reset', () => { worker.postMessage({ type: 'reset' }); lastTraceHead = 0; branchHistory = []; });
  ui.onChange('stress-copies', () => synthesize().catch(() => {}));

  worker.addEventListener('message', event => {
    if (event.data.type === 'ready') { ui.log('CPU Web Worker attached to shared state.'); loadProgram(); }
  });

  const refresh = () => {
    ui.updateCPU(cpu.snapshot());
    processTrace().catch(error => ui.log(`Predictor: ${error.message}`, 'error'));
    requestAnimationFrame(refresh);
  };
  refresh();

  window.addEventListener('beforeunload', () => saveWorkspace({ hdl: ui.hdl(), asm: ui.asm(), stressCopies: ui.stressCopies() }));

  await synthesize();
  exportVerilog(false);
  ui.updateNPU(predictor.metrics());
  ui.setStatus('Frontier EDA v4 Research Edition ready.', 'ok');

  return { ui, cpu, memory, worker, predictor, fabric, get baseNetlist() { return baseNetlist; }, get activeNetlist() { return activeNetlist; } };
}
