// Frontier EDA v4 — race-free NAND fabric kernel.
// Ping-pong state buffers provide deterministic "tic-tac" propagation.

struct Params {
  gate_count: u32,
  tick: u32,
  max_level: u32,
  topological_mode: u32,
};

@group(0) @binding(0) var<storage, read> input_a: array<u32>;
@group(0) @binding(1) var<storage, read> input_b: array<u32>;
@group(0) @binding(2) var<storage, read> kind: array<u32>;
@group(0) @binding(3) var<storage, read> delay_ticks: array<u32>;
@group(0) @binding(4) var<storage, read> level: array<u32>;
@group(0) @binding(5) var<storage, read> state_in: array<u32>;
@group(0) @binding(6) var<storage, read_write> state_out: array<u32>;
@group(0) @binding(7) var<storage, read_write> pending_state: array<u32>;
@group(0) @binding(8) var<storage, read_write> countdown: array<u32>;
@group(0) @binding(9) var<storage, read_write> activity: array<atomic<u32>>;
@group(0) @binding(10) var<uniform> params: Params;

const INPUT_NODE: u32 = 0u;
const CONST_ZERO: u32 = 1u;
const CONST_ONE: u32 = 2u;
const NAND_GATE: u32 = 3u;

@compute @workgroup_size(256)
fn evaluate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.gate_count) { return; }

  let node_kind = kind[i];
  if (node_kind == INPUT_NODE) {
    state_out[i] = state_in[i];
    return;
  }
  if (node_kind == CONST_ZERO) {
    state_out[i] = 0u;
    return;
  }
  if (node_kind == CONST_ONE) {
    state_out[i] = 1u;
    return;
  }

  // In topological mode, a node only becomes eligible when the simulated
  // propagation wave has reached its level. This makes combinational delay
  // visible while preserving the fully parallel dispatch model.
  if (params.topological_mode == 1u && level[i] > params.tick) {
    state_out[i] = state_in[i];
    return;
  }

  if (node_kind != NAND_GATE) {
    state_out[i] = state_in[i];
    return;
  }

  let a = state_in[input_a[i]] & 1u;
  let b = state_in[input_b[i]] & 1u;
  let desired = 1u - (a & b);
  var current = state_in[i] & 1u;
  var wait = countdown[i];
  var pending = pending_state[i] & 1u;

  if (desired == current) {
    wait = 0u;
    pending = current;
  } else {
    // Inertial delay: a changed desired value restarts the countdown.
    if (pending != desired || wait == 0u) {
      pending = desired;
      wait = max(delay_ticks[i], 1u);
    } else if (wait > 1u) {
      wait = wait - 1u;
    } else {
      current = pending;
      wait = 0u;
      atomicAdd(&activity[i], 1u);
    }
  }

  pending_state[i] = pending;
  countdown[i] = wait;
  state_out[i] = current;
}
