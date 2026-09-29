# Frontier EDA model directory

The application works without external weights by using a trainable online perceptron and small native WebNN graphs.

Optional ONNX models can be placed here:

- `branch_predictor.onnx` — input tensor `features` `[1, 32]`, scalar/probability output.
- `eda_optimizer.onnx` — input tensor `features` `[N, 8]`, one score per candidate.

The UI attempts WebNN (`deviceType: npu`) through ONNX Runtime Web first, then WebGPU, then WASM. Models are intentionally not shipped as fabricated "trained" research results.
