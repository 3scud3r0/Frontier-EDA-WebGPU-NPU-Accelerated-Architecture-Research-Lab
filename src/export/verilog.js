import { NodeKind } from '../hdl/netlist_graph.js';

const ident = value => String(value).replace(/[^A-Za-z0-9_$]/g, '_').replace(/^([0-9])/, '_$1');

export function exportToVerilog(netlist, { moduleName = null, systemVerilog = false } = {}) {
  const name = ident(moduleName || `Frontier_${netlist.chip || 'Netlist'}`);
  const inputs = netlist.inputs.map(ident);
  const outputs = netlist.outputNames.map(ident);
  const lines = [];
  lines.push(`module ${name}(`);
  lines.push(`    input wire ${inputs.join(', ')},`);
  lines.push(`    output wire ${outputs.join(', ')}`);
  lines.push(');');
  lines.push('');

  const ref = index => {
    const node = netlist.nodes[index];
    if (!node) return `n${index}`;
    if (node.kind === NodeKind.INPUT) return ident(node.label.replace(/^IN\s+/, ''));
    if (node.kind === NodeKind.CONST0) return "1'b0";
    if (node.kind === NodeKind.CONST1) return "1'b1";
    return `n${index}`;
  };

  const nandIndices = [];
  for (let i = 0; i < netlist.nodes.length; i++) if (netlist.kind[i] === NodeKind.NAND) nandIndices.push(i);
  if (nandIndices.length) lines.push(`    wire ${nandIndices.map(i => `n${i}`).join(', ')};`);
  lines.push('');
  for (const i of nandIndices) {
    lines.push(`    assign n${i} = ~(${ref(netlist.inputA[i])} & ${ref(netlist.inputB[i])});`);
  }
  lines.push('');
  for (let i = 0; i < netlist.outputNames.length; i++) {
    lines.push(`    assign ${ident(netlist.outputNames[i])} = ${ref(netlist.outputIndices[i])};`);
  }
  lines.push('endmodule');
  lines.push('');
  if (systemVerilog) lines.unshift('`default_nettype none', '');
  if (systemVerilog) lines.push('`default_nettype wire');
  return lines.join('\n');
}

export function downloadVerilog(netlist, options = {}) {
  const code = exportToVerilog(netlist, options);
  const blob = new Blob([code], { type: 'text/x-verilog;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${options.moduleName || netlist.chip || 'frontier_netlist'}.v`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return code;
}
