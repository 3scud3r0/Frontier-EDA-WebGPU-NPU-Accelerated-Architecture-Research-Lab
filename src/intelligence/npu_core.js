const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));

class OnlinePerceptron {
  constructor(size = 32, learningRate = 0.08) {
    this.size = size;
    this.learningRate = learningRate;
    this.weights = new Float32Array(size);
    this.bias = 0;
  }

  score(features) {
    let sum = this.bias;
    for (let i = 0; i < this.size; i++) sum += this.weights[i] * (features[i] ?? 0);
    return sigmoid(sum);
  }

  update(features, target) {
    const prediction = this.score(features);
    const error = target - prediction;
    for (let i = 0; i < this.size; i++) this.weights[i] += this.learningRate * error * (features[i] ?? 0);
    this.bias += this.learningRate * error;
    return prediction;
  }
}

async function createNativeWebNNLinear(size, initialWeights, initialBias = 0) {
  if (!globalThis.navigator?.ml || typeof globalThis.MLGraphBuilder === 'undefined') return null;
  try {
    const context = await navigator.ml.createContext({ accelerated: true, powerPreference: 'high-performance' });
    const builder = new MLGraphBuilder(context);
    const vector = { dataType: 'float32', shape: [size] };
    const scalar = { dataType: 'float32', shape: [1] };
    const x = builder.input('x', vector);
    const w = builder.input('w', vector);
    const b = builder.input('b', scalar);
    const product = builder.mul(x, w);
    const sum = builder.reduceSum(product, { keepDimensions: true });
    const y = builder.sigmoid(builder.add(sum, b));
    const graph = await builder.build({ y });
    const [xTensor, wTensor, bTensor, yTensor] = await Promise.all([
      context.createTensor({ ...vector, writable: true }),
      context.createTensor({ ...vector, writable: true }),
      context.createTensor({ ...scalar, writable: true }),
      context.createTensor({ ...scalar, readable: true }),
    ]);
    context.writeTensor(wTensor, initialWeights);
    context.writeTensor(bTensor, new Float32Array([initialBias]));
    return {
      backend: 'WebNN accelerated graph',
      async infer(features, weights = initialWeights, bias = initialBias) {
        context.writeTensor(xTensor, features);
        context.writeTensor(wTensor, weights);
        context.writeTensor(bTensor, new Float32Array([bias]));
        context.dispatch(graph, { x: xTensor, w: wTensor, b: bTensor }, { y: yTensor });
        const data = await context.readTensor(yTensor);
        return new Float32Array(data)[0];
      },
    };
  } catch (error) {
    console.warn('[Frontier EDA] Native WebNN graph unavailable:', error);
    return null;
  }
}

async function createOnnxSession(modelUrl, { preferNpu = true } = {}) {
  if (!modelUrl) return null;
  try {
    const ort = await import('onnxruntime-web/all');
    const candidates = [];
    if (preferNpu) candidates.push([{ name: 'webnn', deviceType: 'npu' }]);
    candidates.push([{ name: 'webnn', deviceType: 'gpu' }], ['webgpu'], ['wasm']);
    for (const executionProviders of candidates) {
      try {
        const session = await ort.InferenceSession.create(modelUrl, {
          executionProviders,
          graphOptimizationLevel: 'all',
        });
        return { ort, session, backend: `ONNX Runtime ${JSON.stringify(executionProviders[0])}` };
      } catch (error) {
        console.debug('[Frontier EDA] ONNX provider rejected:', executionProviders, error);
      }
    }
  } catch (error) {
    console.warn('[Frontier EDA] ONNX Runtime initialization failed:', error);
  }
  return null;
}

export class NeuralPredictor {
  constructor({ historyLength = 32, learningRate = 0.08 } = {}) {
    this.historyLength = historyLength;
    this.perceptron = new OnlinePerceptron(historyLength, learningRate);
    this.outcomes = new Int8Array(historyLength);
    this.pcHistory = new Uint32Array(historyLength);
    this.cursor = 0;
    this.nativeGraph = null;
    this.onnx = null;
    this.backend = 'JS online perceptron';
    this.total = 0;
    this.correct = 0;
    this.lastProbability = 0.5;
  }

  async initialize({ modelUrl = null } = {}) {
    this.onnx = await createOnnxSession(modelUrl, { preferNpu: true });
    if (this.onnx) {
      this.backend = this.onnx.backend;
      return this.backend;
    }
    this.nativeGraph = await createNativeWebNNLinear(this.historyLength, this.perceptron.weights, this.perceptron.bias);
    if (this.nativeGraph) this.backend = this.nativeGraph.backend;
    return this.backend;
  }

  featureVector(pc = 0, target = 0) {
    const f = new Float32Array(this.historyLength);
    for (let i = 0; i < this.historyLength; i++) {
      const idx = (this.cursor - 1 - i + this.historyLength) % this.historyLength;
      const outcome = this.outcomes[idx] || -1;
      const pcMix = ((this.pcHistory[idx] ^ pc ^ target) & 0xff) / 255;
      f[i] = outcome * (0.65 + 0.35 * pcMix);
    }
    return f;
  }

  async predict(pc, target = 0) {
    const features = this.featureVector(pc, target);
    let probability;
    if (this.onnx) {
      try {
        const { ort, session } = this.onnx;
        const inputName = session.inputNames[0];
        const outputName = session.outputNames[0];
        const tensor = new ort.Tensor('float32', features, [1, this.historyLength]);
        const output = await session.run({ [inputName]: tensor });
        probability = Number(output[outputName].data[0]);
      } catch (error) {
        console.warn('[Frontier EDA] ONNX predictor fallback:', error);
        this.onnx = null;
      }
    }
    if (probability == null && this.nativeGraph) {
      try {
        probability = await this.nativeGraph.infer(features, this.perceptron.weights, this.perceptron.bias);
      } catch (error) {
        console.warn('[Frontier EDA] WebNN predictor fallback:', error);
        this.nativeGraph = null;
      }
    }
    if (probability == null) probability = this.perceptron.score(features);
    this.lastProbability = Number.isFinite(probability) ? probability : 0.5;
    return { taken: this.lastProbability >= 0.5, probability: this.lastProbability, backend: this.backend };
  }

  update(pc, target, taken, predictedTaken = null) {
    const features = this.featureVector(pc, target);
    const before = predictedTaken ?? (this.perceptron.score(features) >= 0.5);
    this.perceptron.update(features, taken ? 1 : 0);
    this.pcHistory[this.cursor] = pc >>> 0;
    this.outcomes[this.cursor] = taken ? 1 : -1;
    this.cursor = (this.cursor + 1) % this.historyLength;
    this.total++;
    if (before === Boolean(taken)) this.correct++;
    return this.metrics();
  }

  metrics() {
    return {
      backend: this.backend,
      predictions: this.total,
      correct: this.correct,
      accuracy: this.total ? this.correct / this.total : 0,
      lastProbability: this.lastProbability,
    };
  }
}

function candidateFeatures(netlist, duplicateCount, highFanoutCount) {
  const maxFanout = netlist.fanout.reduce((m, x) => Math.max(m, x), 0);
  const meanFanout = netlist.fanout.reduce((a, b) => a + b, 0) / Math.max(1, netlist.gateCount);
  return new Float32Array([
    Math.min(1, netlist.nandCount / 100000),
    Math.min(1, netlist.maxLevel / 256),
    Math.min(1, maxFanout / 64),
    Math.min(1, meanFanout / 8),
    Math.min(1, duplicateCount / Math.max(1, netlist.nandCount)),
    Math.min(1, highFanoutCount / Math.max(1, netlist.gateCount)),
    netlist.maxDelay / 8,
    1,
  ]);
}

let edaGraphPromise = null;
async function getEdaScorer() {
  if (!edaGraphPromise) {
    edaGraphPromise = createNativeWebNNLinear(
      8,
      new Float32Array([0.2, 0.35, 0.7, 0.25, 1.8, 0.8, 0.2, -0.4]),
      -0.15,
    );
  }
  return edaGraphPromise;
}

export async function optimizeNetlistAI(netlist) {
  const duplicatePairs = new Map();
  const duplicates = [];
  const highFanout = [];
  for (let i = 0; i < netlist.gateCount; i++) {
    if (netlist.kind[i] !== 3) continue;
    const a = netlist.inputA[i], b = netlist.inputB[i];
    const key = a <= b ? `${a}:${b}` : `${b}:${a}`;
    if (duplicatePairs.has(key)) duplicates.push({ gate: i, equivalentTo: duplicatePairs.get(key), reason: 'Common NAND subexpression' });
    else duplicatePairs.set(key, i);
    if (netlist.fanout[i] >= 8) highFanout.push({ gate: i, fanout: netlist.fanout[i], reason: 'High fan-out; consider buffering or factoring' });
  }

  const suggestions = [
    ...duplicates.slice(0, 64).map(d => ({ type: 'CSE', severity: 'high', ...d, estimatedSaving: 1 })),
    ...highFanout.slice(0, 64).map(d => ({ type: 'FANOUT', severity: d.fanout >= 16 ? 'high' : 'medium', ...d, estimatedSaving: 0 })),
  ];

  let neuralScore = null;
  let backend = 'Heuristic structural analysis';
  const scorer = await getEdaScorer();
  if (scorer) {
    neuralScore = await scorer.infer(candidateFeatures(netlist, duplicates.length, highFanout.length));
    backend = scorer.backend;
  }

  return {
    backend,
    neuralScore,
    suggestions,
    duplicateNands: duplicates.length,
    highFanoutNodes: highFanout.length,
    estimatedGateSavings: duplicates.length,
    estimatedOptimizedNands: Math.max(0, netlist.nandCount - duplicates.length),
  };
}
