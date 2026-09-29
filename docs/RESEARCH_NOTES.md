# Frontier EDA v4 — Research Notes

## WebGPU fabric

The compute engine represents every logic node using SoA `Uint32Array` buffers: `inputA`, `inputB`, `kind`, `delayTicks`, `level`, state and switching activity. Two GPU state buffers alternate on every propagation tick. Every thread therefore reads only from the immutable previous tick and writes exactly one node in the next tick, removing inter-gate write races.

The delay model is inertial: a NAND output change is scheduled into `pending_state` with a per-gate countdown. If the desired output changes again before the countdown expires, the event is replaced. This exposes transient settling behavior without pretending to be an analog SPICE simulator.

## Edge AI

The branch predictor always has a functional online perceptron fallback. On hosts exposing WebNN, the same feature vector is evaluated by a native WebNN linear/sigmoid graph. If a compatible ONNX model is supplied, ONNX Runtime Web tries WebNN with NPU preference, then WebNN GPU, WebGPU, and WASM.

The EDA optimizer does not claim trained-model savings when no trained model is present. Structural common-subexpression and fan-out analysis are deterministic; a lightweight WebNN scoring graph can rank the optimization pressure.

## GitHub Pages isolation

GitHub Pages cannot emit COOP/COEP response headers directly. `public/coi-serviceworker.js` registers at page scope, reloads once, and wraps same-origin responses with the isolation headers. Local Vite and `server.mjs` emit the headers at the HTTP layer.
