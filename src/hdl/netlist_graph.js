export const NodeKind = Object.freeze({ INPUT: 0, CONST0: 1, CONST1: 2, NAND: 3 });
const IDENT = /^[A-Za-z_]\w*$/;

export const DEFAULT_TINY_HDL = `chip FullAdder(a, b, cin) -> (sum, carry) {
  x = XOR(a, b)
  sum = XOR(x, cin)
  c0 = AND(a, b)
  c1 = AND(cin, x)
  carry = OR(c0, c1)
}`;

function splitArgs(text) {
  return text.split(',').map(x => x.trim()).filter(Boolean);
}

export function parseTinyHDL(source) {
  const chips = new Map();
  const re = /chip\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*->\s*\(([^)]*)\)\s*\{([\s\S]*?)\}/g;
  let match;
  while ((match = re.exec(source))) {
    const [, name, inputsText, outputsText, body] = match;
    const inputs = splitArgs(inputsText);
    const outputs = splitArgs(outputsText);
    for (const id of [...inputs, ...outputs]) if (!IDENT.test(id)) throw new Error(`TinyHDL identifier inválido: ${id}`);
    const statements = [];
    for (const raw of body.split(/\r?\n/)) {
      const line = raw.replace(/\/\/.*$/, '').trim().replace(/;$/, '');
      if (!line) continue;
      const sm = /^([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(([^)]*)\)$/.exec(line);
      if (!sm) throw new Error(`TinyHDL statement inválido em ${name}: ${line}`);
      statements.push({ target: sm[1], gate: sm[2].toUpperCase(), args: splitArgs(sm[3]) });
    }
    chips.set(name, { name, inputs, outputs, statements });
  }
  if (!chips.size) throw new Error('TinyHDL: nenhum chip encontrado.');
  return chips;
}

class Builder {
  constructor(chipName, inputs) {
    this.chipName = chipName;
    this.nodes = [];
    this.inputIndices = {};
    this.refs = new Map();
    this.const0 = this.addNode({ id: '$const0', kind: NodeKind.CONST0, a: 0, b: 0, label: 'CONST 0', delay: 0, level: 0 });
    this.const1 = this.addNode({ id: '$const1', kind: NodeKind.CONST1, a: 0, b: 0, label: 'CONST 1', delay: 0, level: 0 });
    for (const name of inputs) {
      const index = this.addNode({ id: `$${name}`, kind: NodeKind.INPUT, a: 0, b: 0, label: `IN ${name}`, delay: 0, level: 0 });
      this.refs.set(name, index);
      this.inputIndices[name] = index;
    }
  }

  addNode(node) {
    const index = this.nodes.length;
    this.nodes.push({ index, ...node });
    return index;
  }

  resolve(name) {
    if (name === '0') return this.const0;
    if (name === '1') return this.const1;
    if (!this.refs.has(name)) throw new Error(`TinyHDL sinal desconhecido: ${name}`);
    return this.refs.get(name);
  }

  nand(a, b, label = '') {
    const level = Math.max(this.nodes[a].level, this.nodes[b].level) + 1;
    return this.addNode({ id: `n${this.nodes.length}`, kind: NodeKind.NAND, a, b, label: label || 'NAND', delay: 1, level });
  }

  bind(name, index) { this.refs.set(name, index); return index; }
}

function emitDerived(builder, gate, refs, target) {
  const [a, b, s] = refs;
  switch (gate) {
    case 'NAND':
      if (refs.length !== 2) throw new Error('NAND requer 2 argumentos.');
      return builder.nand(a, b, target);
    case 'NOT':
      if (refs.length !== 1) throw new Error('NOT requer 1 argumento.');
      return builder.nand(a, a, `${target}/NOT`);
    case 'AND': {
      const n = builder.nand(a, b, `${target}/AND.n`);
      return builder.nand(n, n, `${target}/AND.out`);
    }
    case 'OR': {
      const na = builder.nand(a, a, `${target}/OR.na`);
      const nb = builder.nand(b, b, `${target}/OR.nb`);
      return builder.nand(na, nb, `${target}/OR.out`);
    }
    case 'XOR': {
      const n0 = builder.nand(a, b, `${target}/XOR.n0`);
      const n1 = builder.nand(a, n0, `${target}/XOR.n1`);
      const n2 = builder.nand(b, n0, `${target}/XOR.n2`);
      return builder.nand(n1, n2, `${target}/XOR.out`);
    }
    case 'MUX': {
      if (refs.length !== 3) throw new Error('MUX requer 3 argumentos (a,b,sel).');
      const ns = builder.nand(s, s, `${target}/MUX.ns`);
      const l0 = builder.nand(a, ns, `${target}/MUX.l0`);
      const l1 = builder.nand(l0, l0, `${target}/MUX.l1`);
      const r0 = builder.nand(b, s, `${target}/MUX.r0`);
      const r1 = builder.nand(r0, r0, `${target}/MUX.r1`);
      const nl = builder.nand(l1, l1, `${target}/MUX.nl`);
      const nr = builder.nand(r1, r1, `${target}/MUX.nr`);
      return builder.nand(nl, nr, `${target}/MUX.out`);
    }
    default:
      return null;
  }
}

function inlineChip(builder, chip, library, refs, prefix) {
  if (chip.inputs.length !== refs.length) throw new Error(`${chip.name}: aridade inválida.`);
  const env = new Map(chip.inputs.map((name, i) => [name, refs[i]]));
  const resolve = name => {
    if (name === '0') return builder.const0;
    if (name === '1') return builder.const1;
    if (!env.has(name)) throw new Error(`${chip.name}: sinal desconhecido ${name}`);
    return env.get(name);
  };
  for (const st of chip.statements) {
    const args = st.args.map(resolve);
    let result = emitDerived(builder, st.gate, args, `${prefix}/${st.target}`);
    if (result == null) {
      const custom = [...library.values()].find(x => x.name.toUpperCase() === st.gate);
      if (!custom) throw new Error(`TinyHDL gate/chip desconhecido: ${st.gate}`);
      if (custom.outputs.length !== 1) throw new Error(`Subchip ${custom.name}: uso inline exige uma saída.`);
      result = inlineChip(builder, custom, library, args, `${prefix}/${st.target}:${custom.name}`)[custom.outputs[0]];
    }
    env.set(st.target, result);
  }
  const outputs = {};
  for (const out of chip.outputs) {
    if (!env.has(out)) throw new Error(`${chip.name}: saída ${out} não dirigida.`);
    outputs[out] = env.get(out);
  }
  return outputs;
}

export function synthesizeToNand(sourceOrChip, { chipName, delayTicks = 1 } = {}) {
  const library = typeof sourceOrChip === 'string' ? parseTinyHDL(sourceOrChip) : new Map([[sourceOrChip.name, sourceOrChip]]);
  const chip = chipName ? library.get(chipName) : [...library.values()].at(-1);
  if (!chip) throw new Error(`Chip TinyHDL não encontrado: ${chipName}`);
  const builder = new Builder(chip.name, chip.inputs);
  const outputs = inlineChip(builder, chip, library, chip.inputs.map(name => builder.resolve(name)), chip.name);

  for (const node of builder.nodes) if (node.kind === NodeKind.NAND) node.delay = Math.max(1, Number(delayTicks) || 1);

  const gateCount = builder.nodes.length;
  const inputA = new Uint32Array(gateCount);
  const inputB = new Uint32Array(gateCount);
  const kind = new Uint32Array(gateCount);
  const delays = new Uint32Array(gateCount);
  const level = new Uint32Array(gateCount);
  const initialState = new Uint32Array(gateCount);
  const fanout = new Uint32Array(gateCount);

  for (const n of builder.nodes) {
    inputA[n.index] = n.a ?? 0;
    inputB[n.index] = n.b ?? 0;
    kind[n.index] = n.kind;
    delays[n.index] = n.delay ?? 0;
    level[n.index] = n.level ?? 0;
    initialState[n.index] = n.kind === NodeKind.CONST1 ? 1 : 0;
    if (n.kind === NodeKind.NAND) {
      fanout[n.a]++;
      fanout[n.b]++;
    }
  }

  const outputNames = Object.keys(outputs);
  const outputIndices = new Uint32Array(outputNames.map(name => outputs[name]));
  const maxLevel = Math.max(...level);
  const maxDelay = Math.max(...delays);
  const nandCount = kind.reduce((acc, value) => acc + (value === NodeKind.NAND ? 1 : 0), 0);

  return {
    chip: chip.name,
    nodes: builder.nodes,
    inputs: [...chip.inputs],
    outputs,
    outputNames,
    outputIndices,
    inputIndices: builder.inputIndices,
    gateCount,
    nandCount,
    maxLevel,
    maxDelay,
    inputA,
    inputB,
    kind,
    delayTicks: delays,
    level,
    initialState,
    fanout,
  };
}

export function simulateTypedNetlist(netlist, inputs = {}) {
  const state = new Uint32Array(netlist.initialState);
  for (const [name, index] of Object.entries(netlist.inputIndices)) state[index] = inputs[name] ? 1 : 0;
  const order = [...Array(netlist.gateCount).keys()].sort((a, b) => netlist.level[a] - netlist.level[b]);
  for (const i of order) {
    if (netlist.kind[i] !== NodeKind.NAND) continue;
    state[i] = 1 - ((state[netlist.inputA[i]] & 1) & (state[netlist.inputB[i]] & 1));
  }
  return {
    state,
    outputs: Object.fromEntries(netlist.outputNames.map((name, i) => [name, state[netlist.outputIndices[i]]])),
  };
}

export function replicateNetlist(netlist, copies = 1) {
  copies = Math.max(1, Math.floor(copies));
  if (copies === 1) return netlist;
  const total = netlist.gateCount * copies;
  const arrays = Object.fromEntries(['inputA','inputB','kind','delayTicks','level','initialState','fanout'].map(k => [k, new Uint32Array(total)]));
  const nodes = [];
  for (let c = 0; c < copies; c++) {
    const offset = c * netlist.gateCount;
    for (let i = 0; i < netlist.gateCount; i++) {
      const j = offset + i;
      arrays.kind[j] = netlist.kind[i];
      arrays.delayTicks[j] = netlist.delayTicks[i];
      arrays.level[j] = netlist.level[i];
      arrays.initialState[j] = netlist.initialState[i];
      arrays.fanout[j] = netlist.fanout[i];
      arrays.inputA[j] = netlist.kind[i] === NodeKind.NAND ? offset + netlist.inputA[i] : j;
      arrays.inputB[j] = netlist.kind[i] === NodeKind.NAND ? offset + netlist.inputB[i] : j;
      if (c === 0) nodes.push(netlist.nodes[i]);
    }
  }
  const inputIndices = Object.fromEntries(Object.entries(netlist.inputIndices).map(([k, v]) => [k, v]));
  return {
    ...netlist,
    nodes,
    copies,
    gateCount: total,
    nandCount: netlist.nandCount * copies,
    outputIndices: new Uint32Array(netlist.outputIndices),
    inputIndices,
    ...arrays,
  };
}

export function netlistStats(netlist) {
  let maxFanout = 0, fanoutSum = 0;
  for (const value of netlist.fanout) { maxFanout = Math.max(maxFanout, value); fanoutSum += value; }
  return {
    chip: netlist.chip,
    nodes: netlist.gateCount,
    nandGates: netlist.nandCount,
    logicDepth: netlist.maxLevel,
    maxDelayTicks: netlist.maxDelay,
    maxFanout,
    averageFanout: fanoutSum / Math.max(1, netlist.gateCount),
    estimatedCriticalPathTicks: netlist.maxLevel * Math.max(1, netlist.maxDelay),
  };
}
