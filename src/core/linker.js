export function makeObject(name, { text = [], exports = {}, imports = [], relocations = [], data = [] } = {}) {
  return { format: 'n16o', version: 2, name, text: [...text], data: [...data], exports: { ...exports }, imports: [...imports], relocations: relocations.map(x => ({ ...x })) };
}

export function linkObjects(objects, { base = 0 } = {}) {
  const layout = [], symbols = new Map();
  let cursor = base;
  for (const obj of objects) {
    layout.push({ obj, base: cursor });
    for (const [name, offset] of Object.entries(obj.exports)) {
      if (symbols.has(name)) throw new Error(`Símbolo duplicado: ${name}`);
      symbols.set(name, cursor + offset);
    }
    cursor += obj.text.length;
  }
  const words = [];
  for (const { obj, base: objectBase } of layout) {
    const local = [...obj.text];
    for (const relocation of obj.relocations) {
      if (!symbols.has(relocation.symbol)) throw new Error(`Símbolo não resolvido: ${relocation.symbol}`);
      const target = symbols.get(relocation.symbol) + (relocation.addend || 0);
      if (relocation.type === 'ABS16') local[relocation.offset] = target & 0xffff;
      else if (relocation.type === 'REL12') local[relocation.offset] = (local[relocation.offset] & 0xf000) | ((target - (objectBase + relocation.offset + 1)) & 0x0fff);
      else throw new Error(`Relocation desconhecida: ${relocation.type}`);
    }
    words.push(...local.map(x => x & 0xffff));
  }
  for (const { obj } of layout) for (const imp of obj.imports) if (!symbols.has(imp)) throw new Error(`Import não resolvido: ${imp}`);
  return { format: 'n16x', version: 2, base, words: Uint16Array.from(words), symbols: Object.fromEntries(symbols), map: layout.map(x => ({ module: x.obj.name, base: x.base, size: x.obj.text.length })) };
}
