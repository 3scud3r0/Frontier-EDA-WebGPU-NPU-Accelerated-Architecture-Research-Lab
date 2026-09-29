import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TINY_HDL, synthesizeToNand, simulateTypedNetlist, replicateNetlist, netlistStats } from '../src/hdl/netlist_graph.js';
import { exportToVerilog } from '../src/export/verilog.js';
import { CPUStateShared, Slot } from '../src/core/cpu_state.js';
import { assemble, DEFAULT_ASSEMBLY } from '../src/core/assembler.js';
import { makeObject, linkObjects } from '../src/core/linker.js';
import { NeuralPredictor, optimizeNetlistAI } from '../src/intelligence/npu_core.js';

test('TinyHDL FullAdder synthesizes to typed NAND graph and matches truth table', () => {
  const net = synthesizeToNand(DEFAULT_TINY_HDL);
  assert.ok(net.inputA instanceof Uint32Array);
  assert.ok(net.inputB instanceof Uint32Array);
  assert.ok(net.kind instanceof Uint32Array);
  assert.equal(net.nandCount, 15);
  for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let cin = 0; cin < 2; cin++) {
    const { outputs } = simulateTypedNetlist(net, { a, b, cin });
    const total = a + b + cin;
    assert.equal(outputs.sum, total & 1);
    assert.equal(outputs.carry, total >= 2 ? 1 : 0);
  }
});
test('replicated fabric preserves typed topology and scales NAND count', () => {
  const base = synthesizeToNand(DEFAULT_TINY_HDL);
  const big = replicateNetlist(base, 4096);
  assert.equal(big.nandCount, base.nandCount * 4096);
  assert.equal(big.gateCount, base.gateCount * 4096);
  assert.ok(netlistStats(base).logicDepth > 0);
});
test('Verilog export is structural and synthesizable-shaped', () => {
  const net = synthesizeToNand(DEFAULT_TINY_HDL);
  const v = exportToVerilog(net, { moduleName: 'FullAdder_GPU' });
  assert.match(v, /module FullAdder_GPU/);
  assert.match(v, /assign n\d+ = ~\(/);
  assert.match(v, /assign sum =/);
  assert.match(v, /assign carry =/);
  assert.match(v, /endmodule/);
});
test('Shared CPU state exposes Atomics-compatible registers and L1 cache', () => {
  const cpu = new CPUStateShared();
  const memory = new Uint16Array(65536);
  memory[0x1234] = 0xbeef;
  assert.equal(cpu.cacheRead(0x1234, memory), 0xbeef);
  assert.equal(cpu.cacheRead(0x1234, memory), 0xbeef);
  const snap = cpu.snapshot();
  assert.equal(snap.cacheMisses, 1);
  assert.equal(snap.cacheHits, 1);
  cpu.recordBranch(0x10, 0x20, true);
  assert.equal(cpu.get(Slot.BRANCHES), 1);
});
test('Assembler resolves branch labels and emits executable words', () => {
  const program = assemble(DEFAULT_ASSEMBLY);
  assert.ok(program.words instanceof Uint16Array);
  assert.ok(program.words.length > 8);
  assert.ok(program.labels.loop >= 0);
});
test('Static linker resolves ABS16 relocation', () => {
  const a = makeObject('a', { text: [0, 0], exports: { entry: 0 }, imports: ['target'], relocations: [{ offset: 1, type: 'ABS16', symbol: 'target' }] });
  const b = makeObject('b', { text: [0xF000], exports: { target: 0 } });
  const linked = linkObjects([a, b], { base: 0x100 });
  assert.equal(linked.words[1], 0x102);
});
test('Online neural branch predictor learns a stable taken branch', async () => {
  const predictor = new NeuralPredictor({ historyLength: 32, learningRate: 0.15 });
  for (let i = 0; i < 200; i++) {
    const prediction = await predictor.predict(0x20, 0x10);
    predictor.update(0x20, 0x10, true, prediction.taken);
  }
  assert.ok(predictor.metrics().accuracy > 0.85);
  assert.ok((await predictor.predict(0x20, 0x10)).probability > 0.5);
});
test('EDA optimizer reports structural opportunities without fabricating savings', async () => {
  const net = synthesizeToNand(`chip Duplicate(a,b) -> (x,y) {\n x = NAND(a,b)\n y = NAND(a,b)\n}`);
  const result = await optimizeNetlistAI(net);
  assert.ok(result.duplicateNands >= 1);
  assert.ok(result.estimatedGateSavings >= 1);
});
