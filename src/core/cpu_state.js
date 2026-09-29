export const CPU_WORDS = 32;
export const REG_COUNT = 8;
export const TRACE_LENGTH = 256;
export const CACHE_LINES = 64;
export const PREDICTOR_LINES = 64;

export const Slot = Object.freeze({
  PC: 0,
  IR: 1,
  SP: 2,
  FLAGS: 3,
  CYCLES: 4,
  HALTED: 5,
  CACHE_HITS: 6,
  CACHE_MISSES: 7,
  BRANCHES: 8,
  MISPREDICTIONS: 9,
  TRACE_HEAD: 10,
  WORKER_STATE: 11,
});

const STATE_BYTES = CPU_WORDS * 4;
const REGS_OFFSET = STATE_BYTES;
const REGS_BYTES = REG_COUNT * 4;
const CACHE_TAG_OFFSET = REGS_OFFSET + REGS_BYTES;
const CACHE_DATA_OFFSET = CACHE_TAG_OFFSET + CACHE_LINES * 4;
const CACHE_VALID_OFFSET = CACHE_DATA_OFFSET + CACHE_LINES * 4;
const TRACE_PC_OFFSET = CACHE_VALID_OFFSET + CACHE_LINES * 4;
const TRACE_TARGET_OFFSET = TRACE_PC_OFFSET + TRACE_LENGTH * 4;
const TRACE_TAKEN_OFFSET = TRACE_TARGET_OFFSET + TRACE_LENGTH * 4;
const PRED_TAG_OFFSET = TRACE_TAKEN_OFFSET + TRACE_LENGTH * 4;
const PRED_TARGET_OFFSET = PRED_TAG_OFFSET + PREDICTOR_LINES * 4;
const PRED_TAKEN_OFFSET = PRED_TARGET_OFFSET + PREDICTOR_LINES * 4;
const PRED_VALID_OFFSET = PRED_TAKEN_OFFSET + PREDICTOR_LINES * 4;
const TOTAL_BYTES = PRED_VALID_OFFSET + PREDICTOR_LINES * 4;

function atomicLoad(view, index, shared) { return shared ? Atomics.load(view, index) : view[index]; }
function atomicStore(view, index, value, shared) { if (shared) Atomics.store(view, index, value); else view[index] = value; return value; }
function atomicAdd(view, index, value, shared) { if (shared) return Atomics.add(view, index, value); const old = view[index]; view[index] += value; return old; }

export class CPUStateShared {
  constructor({ buffer = null } = {}) {
    const canShare = typeof SharedArrayBuffer === 'function';
    this.buffer = buffer ?? (canShare ? new SharedArrayBuffer(TOTAL_BYTES) : new ArrayBuffer(TOTAL_BYTES));
    this.shared = this.buffer instanceof SharedArrayBuffer;
    this.state = new Int32Array(this.buffer, 0, CPU_WORDS);
    this.regs = new Uint32Array(this.buffer, REGS_OFFSET, REG_COUNT);
    this.cacheTags = new Int32Array(this.buffer, CACHE_TAG_OFFSET, CACHE_LINES);
    this.cacheData = new Uint32Array(this.buffer, CACHE_DATA_OFFSET, CACHE_LINES);
    this.cacheValid = new Int32Array(this.buffer, CACHE_VALID_OFFSET, CACHE_LINES);
    this.tracePC = new Uint32Array(this.buffer, TRACE_PC_OFFSET, TRACE_LENGTH);
    this.traceTarget = new Uint32Array(this.buffer, TRACE_TARGET_OFFSET, TRACE_LENGTH);
    this.traceTaken = new Int32Array(this.buffer, TRACE_TAKEN_OFFSET, TRACE_LENGTH);
    this.predTags = new Int32Array(this.buffer, PRED_TAG_OFFSET, PREDICTOR_LINES);
    this.predTargets = new Uint32Array(this.buffer, PRED_TARGET_OFFSET, PREDICTOR_LINES);
    this.predTaken = new Int32Array(this.buffer, PRED_TAKEN_OFFSET, PREDICTOR_LINES);
    this.predValid = new Int32Array(this.buffer, PRED_VALID_OFFSET, PREDICTOR_LINES);
    if (!buffer) this.reset();
  }

  static byteLength() { return TOTAL_BYTES; }

  reset() {
    this.state.fill(0);
    this.regs.fill(0);
    this.cacheTags.fill(-1);
    this.cacheData.fill(0);
    this.cacheValid.fill(0);
    this.tracePC.fill(0);
    this.traceTarget.fill(0);
    this.traceTaken.fill(0);
    this.predTags.fill(-1);
    this.predTargets.fill(0);
    this.predTaken.fill(0);
    this.predValid.fill(0);
    this.set(Slot.SP, 0xfffe);
  }

  get(slot) { return atomicLoad(this.state, slot, this.shared); }
  set(slot, value) { return atomicStore(this.state, slot, value | 0, this.shared); }
  add(slot, value = 1) { return atomicAdd(this.state, slot, value | 0, this.shared); }

  readReg(index) { return this.shared ? Atomics.load(this.regs, index) >>> 0 : this.regs[index] >>> 0; }
  writeReg(index, value) { if (this.shared) Atomics.store(this.regs, index, value >>> 0); else this.regs[index] = value >>> 0; }

  cacheRead(address, memory) {
    const addr = address & 0xffff;
    const line = addr & (CACHE_LINES - 1);
    const tag = addr >>> 6;
    if (atomicLoad(this.cacheValid, line, this.shared) && atomicLoad(this.cacheTags, line, this.shared) === tag) {
      this.add(Slot.CACHE_HITS, 1);
      return atomicLoad(this.cacheData, line, this.shared) & 0xffff;
    }
    this.add(Slot.CACHE_MISSES, 1);
    const value = memory[addr] & 0xffff;
    atomicStore(this.cacheTags, line, tag, this.shared);
    atomicStore(this.cacheData, line, value, this.shared);
    atomicStore(this.cacheValid, line, 1, this.shared);
    return value;
  }

  cacheWrite(address, value, memory) {
    const addr = address & 0xffff;
    const word = value & 0xffff;
    memory[addr] = word;
    const line = addr & (CACHE_LINES - 1);
    const tag = addr >>> 6;
    atomicStore(this.cacheTags, line, tag, this.shared);
    atomicStore(this.cacheData, line, word, this.shared);
    atomicStore(this.cacheValid, line, 1, this.shared);
  }

  recordBranch(pc, target, taken) {
    const head = this.add(Slot.TRACE_HEAD, 1);
    const i = ((head % TRACE_LENGTH) + TRACE_LENGTH) % TRACE_LENGTH;
    this.tracePC[i] = pc >>> 0;
    this.traceTarget[i] = target >>> 0;
    this.traceTaken[i] = taken ? 1 : 0;
    this.add(Slot.BRANCHES, 1);
    return i;
  }

  readBranch(index) {
    const i = ((index % TRACE_LENGTH) + TRACE_LENGTH) % TRACE_LENGTH;
    return { pc: this.tracePC[i] >>> 0, target: this.traceTarget[i] >>> 0, taken: Boolean(this.traceTaken[i]) };
  }

  setBranchPrediction(pc, target, taken) {
    const branchPC = pc & 0xffff;
    const line = branchPC & (PREDICTOR_LINES - 1);
    atomicStore(this.predTags, line, branchPC, this.shared);
    atomicStore(this.predTargets, line, target & 0xffff, this.shared);
    atomicStore(this.predTaken, line, taken ? 1 : 0, this.shared);
    atomicStore(this.predValid, line, 1, this.shared);
  }

  getBranchPrediction(pc, fallbackTarget = 0) {
    const branchPC = pc & 0xffff;
    const line = branchPC & (PREDICTOR_LINES - 1);
    const valid = atomicLoad(this.predValid, line, this.shared);
    const tag = atomicLoad(this.predTags, line, this.shared);
    if (!valid || tag !== branchPC) return { valid: false, taken: false, target: fallbackTarget & 0xffff };
    return {
      valid: true,
      taken: Boolean(atomicLoad(this.predTaken, line, this.shared)),
      target: atomicLoad(this.predTargets, line, this.shared) & 0xffff,
    };
  }

  snapshot() {
    const hits = this.get(Slot.CACHE_HITS) >>> 0;
    const misses = this.get(Slot.CACHE_MISSES) >>> 0;
    return {
      shared: this.shared,
      pc: this.get(Slot.PC) & 0xffff,
      ir: this.get(Slot.IR) & 0xffff,
      sp: this.get(Slot.SP) & 0xffff,
      flags: this.get(Slot.FLAGS) & 0xffff,
      cycles: this.get(Slot.CYCLES) >>> 0,
      halted: Boolean(this.get(Slot.HALTED)),
      registers: Array.from(this.regs, x => x & 0xffff),
      cacheHits: hits,
      cacheMisses: misses,
      cacheHitRate: hits + misses ? hits / (hits + misses) : 0,
      branches: this.get(Slot.BRANCHES) >>> 0,
      mispredictions: this.get(Slot.MISPREDICTIONS) >>> 0,
      traceHead: this.get(Slot.TRACE_HEAD) >>> 0,
    };
  }
}

export function createSharedMemory(words = 65536) {
  const bytes = words * Uint16Array.BYTES_PER_ELEMENT;
  const buffer = typeof SharedArrayBuffer === 'function' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
  return { buffer, words: new Uint16Array(buffer) };
}
