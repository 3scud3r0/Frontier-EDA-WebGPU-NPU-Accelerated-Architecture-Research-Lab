import { CPUStateShared, Slot } from './cpu_state.js';
import { OPCODE, decodeWord } from './assembler.js';

let cpu = null;
let memory = null;
let rom = new Uint16Array();
let running = false;
let stack = [];

function sign6(x) { return (x & 0x20) ? x - 0x40 : x; }
function setZN(value) {
  const v = value & 0xffff;
  cpu.set(Slot.FLAGS, (v === 0 ? 1 : 0) | (v & 0x8000 ? 2 : 0));
}
function nextWord(pc) { return rom[(pc + 1) & 0xffff] ?? 0; }

const BRANCH_FLUSH_PENALTY = 3;
function resolveBranch(pc, target, taken, fallthrough) {
  const prediction = cpu.getBranchPrediction(pc, target);
  const predictedNext = prediction.taken ? prediction.target : fallthrough;
  const actualNext = taken ? target : fallthrough;
  cpu.recordBranch(pc, target, taken);
  if (predictedNext !== actualNext) {
    cpu.add(Slot.MISPREDICTIONS, 1);
    cpu.add(Slot.CYCLES, BRANCH_FLUSH_PENALTY);
  }
  return actualNext;
}

function step() {
  let pc = cpu.get(Slot.PC) & 0xffff;
  const ir = rom[pc] ?? 0;
  cpu.set(Slot.IR, ir);
  const { opcode, rd, rs, imm6 } = decodeWord(ir);
  let next = (pc + 1) & 0xffff;
  const rA = cpu.readReg(rd) & 0xffff;
  const rB = cpu.readReg(rs) & 0xffff;

  switch (opcode) {
    case OPCODE.NOP: break;
    case OPCODE.LDI: cpu.writeReg(rd, sign6(imm6) & 0xffff); setZN(cpu.readReg(rd)); break;
    case OPCODE.MOV: cpu.writeReg(rd, rB); setZN(rB); break;
    case OPCODE.ADD: cpu.writeReg(rd, (rA + rB) & 0xffff); setZN(cpu.readReg(rd)); break;
    case OPCODE.SUB: cpu.writeReg(rd, (rA - rB) & 0xffff); setZN(cpu.readReg(rd)); break;
    case OPCODE.AND: cpu.writeReg(rd, rA & rB); setZN(cpu.readReg(rd)); break;
    case OPCODE.OR: cpu.writeReg(rd, rA | rB); setZN(cpu.readReg(rd)); break;
    case OPCODE.XOR: cpu.writeReg(rd, rA ^ rB); setZN(cpu.readReg(rd)); break;
    case OPCODE.LD: {
      const addr = nextWord(pc); next = (pc + 2) & 0xffff;
      const v = cpu.cacheRead(addr, memory); cpu.writeReg(rd, v); setZN(v); break;
    }
    case OPCODE.ST: {
      const addr = nextWord(pc); next = (pc + 2) & 0xffff;
      cpu.cacheWrite(addr, rA, memory); break;
    }
    case OPCODE.JMP: {
      const target = nextWord(pc); next = resolveBranch(pc, target, true, (pc + 2) & 0xffff); break;
    }
    case OPCODE.JZ: {
      const target = nextWord(pc); const taken = rA === 0; next = resolveBranch(pc, target, taken, (pc + 2) & 0xffff); break;
    }
    case OPCODE.JNZ: {
      const target = nextWord(pc); const taken = rA !== 0; next = resolveBranch(pc, target, taken, (pc + 2) & 0xffff); break;
    }
    case OPCODE.CALL: {
      const target = nextWord(pc); stack.push((pc + 2) & 0xffff); cpu.set(Slot.SP, (cpu.get(Slot.SP) - 1) & 0xffff); next = resolveBranch(pc, target, true, (pc + 2) & 0xffff); break;
    }
    case OPCODE.RET: next = stack.pop() ?? next; cpu.set(Slot.SP, (cpu.get(Slot.SP) + 1) & 0xffff); break;
    case OPCODE.HALT: cpu.set(Slot.HALTED, 1); running = false; break;
  }
  cpu.set(Slot.PC, next);
  cpu.add(Slot.CYCLES, 1);
}

function runBurst() {
  if (!running) return;
  for (let i = 0; i < 4096 && running; i++) step();
  setTimeout(runBurst, 0);
}

self.onmessage = event => {
  const msg = event.data;
  if (msg.type === 'init') {
    cpu = new CPUStateShared({ buffer: msg.stateBuffer });
    memory = new Uint16Array(msg.memoryBuffer);
    cpu.set(Slot.WORKER_STATE, 1);
    self.postMessage({ type: 'ready' });
  } else if (msg.type === 'load') {
    rom = new Uint16Array(msg.program);
    cpu.reset();
    stack = [];
    self.postMessage({ type: 'loaded', words: rom.length });
  } else if (msg.type === 'run') {
    if (!running) { running = true; cpu.set(Slot.HALTED, 0); runBurst(); }
  } else if (msg.type === 'pause') {
    running = false;
  } else if (msg.type === 'step') {
    running = false;
    if (!cpu.get(Slot.HALTED)) step();
  } else if (msg.type === 'reset') {
    running = false; cpu.reset(); stack = [];
  }
};
