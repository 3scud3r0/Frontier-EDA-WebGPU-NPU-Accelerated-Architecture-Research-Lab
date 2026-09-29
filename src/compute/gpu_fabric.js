import shaderSource from './logic_eval.wgsl?raw';

const WORKGROUP_SIZE = 256;

function assertTypedNetlist(netlist) {
  const required = ['inputA', 'inputB', 'kind', 'delayTicks', 'level', 'initialState'];
  for (const key of required) {
    if (!(netlist[key] instanceof Uint32Array)) throw new TypeError(`netlist.${key} deve ser Uint32Array`);
  }
  if (!netlist.gateCount || netlist.gateCount !== netlist.kind.length) {
    throw new Error('Netlist inválida: gateCount inconsistente.');
  }
}

function createStorageBuffer(device, data, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) {
  const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
  const buffer = device.createBuffer({ size, usage, mappedAtCreation: false });
  device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
  return buffer;
}

function createZeroBuffer(device, byteLength, usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC) {
  return device.createBuffer({ size: Math.max(4, Math.ceil(byteLength / 4) * 4), usage });
}

export class WebGPUFabric {
  constructor(adapter, device) {
    this.adapter = adapter;
    this.device = device;
    this.adapterInfo = adapter.info ?? device.adapterInfo ?? {};
    this.pipeline = null;
    this.netlist = null;
    this.buffers = null;
    this.bindGroups = null;
    this.readFromA = true;
    this.paramsData = new Uint32Array(4);
    this.lastBenchmark = null;
  }

  static async create(options = {}) {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU indisponível neste navegador.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' });
    if (!adapter) throw new Error('Nenhum GPUAdapter WebGPU disponível.');
    const device = await adapter.requestDevice();
    const engine = new WebGPUFabric(adapter, device);
    await engine.initializePipeline();
    return engine;
  }

  async initializePipeline() {
    const module = this.device.createShaderModule({ code: shaderSource, label: 'Frontier NAND fabric WGSL' });
    const info = await module.getCompilationInfo?.();
    const errors = info?.messages?.filter(m => m.type === 'error') ?? [];
    if (errors.length) throw new Error(errors.map(e => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n'));
    this.pipeline = this.device.createComputePipeline({
      label: 'Frontier NAND fabric pipeline',
      layout: 'auto',
      compute: { module, entryPoint: 'evaluate' },
    });
  }

  loadNetlist(netlist) {
    assertTypedNetlist(netlist);
    this.destroyBuffers();
    this.netlist = netlist;
    const bytes = netlist.gateCount * Uint32Array.BYTES_PER_ELEMENT;
    const d = this.device;

    const inputA = createStorageBuffer(d, netlist.inputA);
    const inputB = createStorageBuffer(d, netlist.inputB);
    const kind = createStorageBuffer(d, netlist.kind);
    const delayTicks = createStorageBuffer(d, netlist.delayTicks);
    const level = createStorageBuffer(d, netlist.level);
    const stateA = createStorageBuffer(d, netlist.initialState, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const stateB = createStorageBuffer(d, netlist.initialState, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const pending = createStorageBuffer(d, netlist.initialState, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    const countdown = createZeroBuffer(d, bytes);
    const activity = createZeroBuffer(d, bytes);
    const params = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.buffers = { inputA, inputB, kind, delayTicks, level, stateA, stateB, pending, countdown, activity, params };
    const entries = (stateIn, stateOut) => [
      { binding: 0, resource: { buffer: inputA } },
      { binding: 1, resource: { buffer: inputB } },
      { binding: 2, resource: { buffer: kind } },
      { binding: 3, resource: { buffer: delayTicks } },
      { binding: 4, resource: { buffer: level } },
      { binding: 5, resource: { buffer: stateIn } },
      { binding: 6, resource: { buffer: stateOut } },
      { binding: 7, resource: { buffer: pending } },
      { binding: 8, resource: { buffer: countdown } },
      { binding: 9, resource: { buffer: activity } },
      { binding: 10, resource: { buffer: params } },
    ];
    this.bindGroups = [
      d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: entries(stateA, stateB) }),
      d.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: entries(stateB, stateA) }),
    ];
    this.readFromA = true;
  }

  setInputs(values) {
    if (!this.netlist || !this.buffers) throw new Error('Carregue uma netlist antes de definir entradas.');
    const state = new Uint32Array(this.netlist.initialState);
    for (const [name, index] of Object.entries(this.netlist.inputIndices ?? {})) state[index] = values[name] ? 1 : 0;
    for (const [name, index] of Object.entries(this.netlist.inputIndices ?? {})) {
      const word = new Uint32Array([state[index]]);
      const byteOffset = index * 4;
      this.device.queue.writeBuffer(this.buffers.stateA, byteOffset, word);
      this.device.queue.writeBuffer(this.buffers.stateB, byteOffset, word);
    }
  }

  step({ ticks = 1, topological = true } = {}) {
    if (!this.netlist || !this.buffers) throw new Error('GPU fabric sem netlist.');
    const groups = Math.ceil(this.netlist.gateCount / WORKGROUP_SIZE);
    for (let tick = 0; tick < ticks; tick++) {
      this.paramsData[0] = this.netlist.gateCount;
      this.paramsData[1] = tick;
      this.paramsData[2] = this.netlist.maxLevel ?? 0;
      this.paramsData[3] = topological ? 1 : 0;
      this.device.queue.writeBuffer(this.buffers.params, 0, this.paramsData);
      const encoder = this.device.createCommandEncoder({ label: `Frontier NAND tick ${tick}` });
      const pass = encoder.beginComputePass({ label: `NAND tick ${tick}` });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroups[this.readFromA ? 0 : 1]);
      pass.dispatchWorkgroups(groups);
      pass.end();
      this.readFromA = !this.readFromA;
      this.device.queue.submit([encoder.finish()]);
    }
  }

  async settle(extraTicks = 2) {
    const ticks = (this.netlist?.maxLevel ?? 0) + (this.netlist?.maxDelay ?? 1) + extraTicks;
    this.step({ ticks, topological: true });
    await this.device.queue.onSubmittedWorkDone();
    return ticks;
  }

  async readState() {
    return this.#readBuffer(this.readFromA ? this.buffers.stateA : this.buffers.stateB, this.netlist.gateCount);
  }

  async readActivity() {
    return this.#readBuffer(this.buffers.activity, this.netlist.gateCount);
  }

  async #readBuffer(source, count) {
    const size = count * 4;
    const staging = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = this.device.createCommandEncoder();
    encoder.copyBufferToBuffer(source, 0, staging, 0, size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const result = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return result;
  }

  async benchmark({ iterations = 200, ticksPerIteration = 1 } = {}) {
    if (!this.netlist) throw new Error('GPU fabric sem netlist.');
    const totalPasses = iterations * ticksPerIteration;
    const groups = Math.ceil(this.netlist.gateCount / WORKGROUP_SIZE);
    this.paramsData.set([this.netlist.gateCount, 0, this.netlist.maxLevel ?? 0, 0]);
    this.device.queue.writeBuffer(this.buffers.params, 0, this.paramsData);
    const encoder = this.device.createCommandEncoder({ label: 'Frontier NAND throughput benchmark' });
    const started = performance.now();
    for (let i = 0; i < totalPasses; i++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroups[this.readFromA ? 0 : 1]);
      pass.dispatchWorkgroups(groups);
      pass.end();
      this.readFromA = !this.readFromA;
    }
    this.device.queue.submit([encoder.finish()]);
    await this.device.queue.onSubmittedWorkDone();
    const elapsedMs = Math.max(0.001, performance.now() - started);
    const evaluations = this.netlist.nandCount * totalPasses;
    this.lastBenchmark = {
      elapsedMs,
      evaluations,
      gatesPerSecond: evaluations / (elapsedMs / 1000),
      gateCount: this.netlist.gateCount,
      nandCount: this.netlist.nandCount,
    };
    return this.lastBenchmark;
  }

  destroyBuffers() {
    if (!this.buffers) return;
    for (const buffer of Object.values(this.buffers)) buffer?.destroy?.();
    this.buffers = null;
    this.bindGroups = null;
  }

  destroy() {
    this.destroyBuffers();
    this.device?.destroy?.();
  }
}

export class CPUFabricFallback {
  constructor() {
    this.netlist = null;
    this.stateA = null;
    this.stateB = null;
    this.pending = null;
    this.countdown = null;
    this.activity = null;
    this.readFromA = true;
    this.adapterInfo = { vendor: 'CPU', architecture: 'JavaScript fallback' };
  }

  loadNetlist(netlist) {
    assertTypedNetlist(netlist);
    this.netlist = netlist;
    this.stateA = new Uint32Array(netlist.initialState);
    this.stateB = new Uint32Array(netlist.initialState);
    this.pending = new Uint32Array(netlist.initialState);
    this.countdown = new Uint32Array(netlist.gateCount);
    this.activity = new Uint32Array(netlist.gateCount);
    this.readFromA = true;
  }

  setInputs(values) {
    for (const [name, index] of Object.entries(this.netlist.inputIndices ?? {})) {
      const v = values[name] ? 1 : 0;
      this.stateA[index] = v;
      this.stateB[index] = v;
    }
  }

  step({ ticks = 1, topological = true } = {}) {
    for (let tick = 0; tick < ticks; tick++) {
      const src = this.readFromA ? this.stateA : this.stateB;
      const dst = this.readFromA ? this.stateB : this.stateA;
      for (let i = 0; i < this.netlist.gateCount; i++) {
        const kind = this.netlist.kind[i];
        if (kind === 0) { dst[i] = src[i]; continue; }
        if (kind === 1) { dst[i] = 0; continue; }
        if (kind === 2) { dst[i] = 1; continue; }
        if (topological && this.netlist.level[i] > tick) { dst[i] = src[i]; continue; }
        const desired = 1 - ((src[this.netlist.inputA[i]] & 1) & (src[this.netlist.inputB[i]] & 1));
        let current = src[i] & 1;
        if (desired === current) {
          this.countdown[i] = 0;
          this.pending[i] = current;
        } else if (this.pending[i] !== desired || this.countdown[i] === 0) {
          this.pending[i] = desired;
          this.countdown[i] = Math.max(1, this.netlist.delayTicks[i]);
        } else if (this.countdown[i] > 1) {
          this.countdown[i]--;
        } else {
          current = this.pending[i];
          this.countdown[i] = 0;
          this.activity[i]++;
        }
        dst[i] = current;
      }
      this.readFromA = !this.readFromA;
    }
  }

  async settle(extraTicks = 2) {
    const ticks = (this.netlist.maxLevel ?? 0) + (this.netlist.maxDelay ?? 1) + extraTicks;
    this.step({ ticks, topological: true });
    return ticks;
  }

  async readState() { return new Uint32Array(this.readFromA ? this.stateA : this.stateB); }
  async readActivity() { return new Uint32Array(this.activity); }

  async benchmark({ iterations = 200, ticksPerIteration = 1 } = {}) {
    const started = performance.now();
    for (let i = 0; i < iterations; i++) this.step({ ticks: ticksPerIteration, topological: false });
    const elapsedMs = Math.max(0.001, performance.now() - started);
    const evaluations = this.netlist.nandCount * iterations * ticksPerIteration;
    return { elapsedMs, evaluations, gatesPerSecond: evaluations / (elapsedMs / 1000), gateCount: this.netlist.gateCount, nandCount: this.netlist.nandCount };
  }
}

export async function createBestFabric() {
  try {
    return { engine: await WebGPUFabric.create(), backend: 'WebGPU' };
  } catch (error) {
    console.warn('[Frontier EDA] WebGPU fallback:', error);
    return { engine: new CPUFabricFallback(), backend: 'CPU fallback', error };
  }
}
