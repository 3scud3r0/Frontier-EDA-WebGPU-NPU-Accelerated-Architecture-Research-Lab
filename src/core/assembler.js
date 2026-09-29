export const OPCODE = Object.freeze({
  NOP: 0x0, LDI: 0x1, MOV: 0x2, ADD: 0x3, SUB: 0x4, AND: 0x5, OR: 0x6, XOR: 0x7,
  LD: 0x8, ST: 0x9, JMP: 0xA, JZ: 0xB, JNZ: 0xC, CALL: 0xD, RET: 0xE, HALT: 0xF,
});

const reg = token => {
  const m = /^R([0-7])$/i.exec(token ?? '');
  if (!m) throw new Error(`Registrador inválido: ${token}`);
  return Number(m[1]);
};

function cleanLine(line) { return line.replace(/;.*/, '').replace(/#.*/, '').trim(); }
function split(line) { return line.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean); }
function signed6(value) {
  if (value < -32 || value > 63) throw new Error(`Imediato fora de 6 bits: ${value}`);
  return value & 0x3f;
}
function emitRR(op, rd = 0, rs = 0, imm = 0) { return ((op & 0xf) << 12) | ((rd & 7) << 9) | ((rs & 7) << 6) | (imm & 0x3f); }
function sizeOf(mn) { return ['LD','ST','JMP','JZ','JNZ','CALL'].includes(mn) ? 2 : 1; }

export function decodeWord(word) {
  return { opcode: (word >>> 12) & 0xf, rd: (word >>> 9) & 7, rs: (word >>> 6) & 7, imm6: word & 0x3f };
}

export function assemble(source) {
  const labels = new Map();
  const lines = [];
  let pc = 0;
  const raw = source.split(/\r?\n/);
  for (let lineNo = 0; lineNo < raw.length; lineNo++) {
    let line = cleanLine(raw[lineNo]);
    if (!line) continue;
    const lm = /^([A-Za-z_]\w*):\s*(.*)$/.exec(line);
    if (lm) {
      if (labels.has(lm[1])) throw new Error(`Label duplicado: ${lm[1]}`);
      labels.set(lm[1], pc);
      line = lm[2].trim();
      if (!line) continue;
    }
    const parts = split(line);
    const mn = parts[0].toUpperCase();
    lines.push({ lineNo: lineNo + 1, text: line, parts, address: pc });
    pc += sizeOf(mn);
  }

  const value = token => {
    if (token == null) throw new Error('Operando ausente.');
    if (labels.has(token)) return labels.get(token);
    if (/^0x[0-9a-f]+$/i.test(token)) return parseInt(token, 16);
    if (/^-?\d+$/.test(token)) return Number(token);
    throw new Error(`Símbolo desconhecido: ${token}`);
  };

  const words = [], listing = [];
  const put = (word, item, annotation = '') => {
    listing.push({ address: words.length, word: word & 0xffff, source: item.text, annotation, lineNo: item.lineNo });
    words.push(word & 0xffff);
  };

  for (const item of lines) {
    const [mnRaw, a, b] = item.parts;
    const mn = mnRaw.toUpperCase();
    try {
      switch (mn) {
        case 'NOP': put(emitRR(OPCODE.NOP), item); break;
        case 'LDI': put(emitRR(OPCODE.LDI, reg(a), 0, signed6(value(b))), item); break;
        case 'MOV': put(emitRR(OPCODE.MOV, reg(a), reg(b)), item); break;
        case 'ADD': put(emitRR(OPCODE.ADD, reg(a), reg(b)), item); break;
        case 'SUB': put(emitRR(OPCODE.SUB, reg(a), reg(b)), item); break;
        case 'AND': put(emitRR(OPCODE.AND, reg(a), reg(b)), item); break;
        case 'OR': put(emitRR(OPCODE.OR, reg(a), reg(b)), item); break;
        case 'XOR': put(emitRR(OPCODE.XOR, reg(a), reg(b)), item); break;
        case 'LD': put(emitRR(OPCODE.LD, reg(a)), item); put(value(b), item, b); break;
        case 'ST': put(emitRR(OPCODE.ST, reg(a)), item); put(value(b), item, b); break;
        case 'JMP': put(emitRR(OPCODE.JMP), item); put(value(a), item, a); break;
        case 'JZ': put(emitRR(OPCODE.JZ, reg(a)), item); put(value(b), item, b); break;
        case 'JNZ': put(emitRR(OPCODE.JNZ, reg(a)), item); put(value(b), item, b); break;
        case 'CALL': put(emitRR(OPCODE.CALL), item); put(value(a), item, a); break;
        case 'RET': put(emitRR(OPCODE.RET), item); break;
        case 'HALT': put(emitRR(OPCODE.HALT), item); break;
        case '.WORD': put(value(a), item, a); break;
        default: throw new Error(`Instrução desconhecida: ${mn}`);
      }
    } catch (error) {
      throw new Error(`ASM linha ${item.lineNo}: ${error.message}`);
    }
  }
  return { words: Uint16Array.from(words), listing, labels: Object.fromEntries(labels) };
}

export const DEFAULT_ASSEMBLY = `; Branch-heavy benchmark for the neural predictor
LDI R0, 0
LDI R1, 1
LDI R2, 24
loop:
ADD R0, R1
SUB R2, R1
JNZ R2, loop
ST R0, 0x0200
HALT`;
