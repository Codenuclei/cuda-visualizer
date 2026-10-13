(function (root, factory) {
  const library = factory();
  if (typeof module === "object" && module.exports) module.exports = library;
  root.KernelLibrary = library;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";

  const floats = (length, valueAt) => {
    const values = new Float32Array(length);
    for (let i = 0; i < length; i++) values[i] = valueAt(i);
    return values;
  };

  const vectorAdd = {
    id: "vector-add",
    title: "Vector addition",
    shortName: "Vector add",
    category: "fundamentals",
    description: "Adds two 128-element vectors, assigning one output element to each thread.",
    filename: "vector_add.cu",
    code: `__global__ void vector_add(const float *a, const float *b, float *out) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < 256) {
    out[i] = a[i] + b[i];
  }
}`,
    grid: [4, 1],
    block: [64, 1],
    n: 256,
    sharedBytes: 0,
    buffers: n => ({
      a: floats(n, i => (i % 17 - 8) / 4),
      b: floats(n, i => (i % 11 - 5) / 8),
      out: new Float32Array(n),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Elementwise work", detail: "Each thread computes one independent sum." },
      { label: "Bounds check", detail: "The guard prevents threads beyond the vector length from accessing memory." },
    ],
    stages: [
      { label: "Index", detail: "Combine the block and thread indices into a global element index." },
      { label: "Load and add", detail: "Read matching elements from a and b, then add them." },
      { label: "Store", detail: "Write the sum to the same output index." },
    ],
    expected: (n, buffers) => floats(n, i => buffers.a[i] + buffers.b[i]),
  };

  const reduction = {
    id: "reduction",
    title: "Shared-memory reduction",
    shortName: "Reduction",
    category: "shared-memory",
    description: "Sums 64 values in one block using a tree reduction; every thread reaches every barrier.",
    filename: "reduction.cu",
    code: `__global__ void reduce_sum(const float *input, float *out) {
  __shared__ float partial[64];
  int tid = threadIdx.x;
  partial[tid] = input[tid];
  __syncthreads();

  for (int stride = blockDim.x / 2; stride > 0; stride /= 2) {
    if (tid < stride) {
      partial[tid] += partial[tid + stride];
    }
    __syncthreads();
  }

  if (tid == 0) {
    out[0] = partial[0];
  }
}`,
    grid: [1, 1],
    block: [64, 1],
    n: 64,
    sharedBytes: 64 * Float32Array.BYTES_PER_ELEMENT,
    buffers: n => ({
      input: floats(n, i => ((i * 7) % 19 - 9) / 8),
      out: new Float32Array(1),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Tree reduction", detail: "At each stride, the lower-index half combines values from the upper-index half." },
      { label: "Block barrier", detail: "Each stage is separated by a block-wide synchronization point." },
    ],
    stages: [
      { label: "Stage input", detail: "Each thread copies one input value into its shared-memory slot." },
      { label: "Combine", detail: "Threads with tid below the current stride add a partner value." },
      { label: "Synchronize", detail: "All 64 threads reach the barrier before the next stride." },
      { label: "Write result", detail: "Thread zero stores the final block sum." },
    ],
    expected: (n, buffers) => {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += buffers.input[i];
      return new Float32Array([sum]);
    },
  };

  const matmul = {
    id: "matmul",
    title: "Square matrix multiplication",
    shortName: "Matmul",
    category: "linear-algebra",
    description: "Multiplies two 8 × 8 row-major matrices; each thread computes one output cell.",
    filename: "matmul.cu",
    code: `__global__ void matmul(const float *left, const float *right, float *out) {
  int row = blockIdx.y * blockDim.y + threadIdx.y;
  int col = blockIdx.x * blockDim.x + threadIdx.x;
  if (row < 8 && col < 8) {
    float sum = 0.0f;
    for (int k = 0; k < 8; k++) {
      sum += left[row * 8 + k] * right[k * 8 + col];
    }
    out[row * 8 + col] = sum;
  }
}`,
    grid: [1, 1],
    block: [8, 8],
    n: 8,
    sharedBytes: 0,
    buffers: n => ({
      left: floats(n * n, i => (i % 13 - 6) / 8),
      right: floats(n * n, i => (i % 9 - 4) / 7),
      out: new Float32Array(n * n),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Dot product", detail: "Each output cell is the dot product of one row of left and one column of right." },
      { label: "Two-dimensional launch", detail: "The x and y thread coordinates identify output column and row." },
    ],
    stages: [
      { label: "Map coordinates", detail: "Thread coordinates select a row and column in the output matrix." },
      { label: "Accumulate", detail: "The loop accumulates products across the shared inner dimension." },
      { label: "Store cell", detail: "Write the completed dot product to the row-major output." },
    ],
    expected: (n, buffers) => {
      const out = new Float32Array(n * n);
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          let sum = 0;
          for (let k = 0; k < n; k++) sum += buffers.left[row * n + k] * buffers.right[k * n + col];
          out[row * n + col] = sum;
        }
      }
      return out;
    },
  };

  const mlp = {
    id: "mlp-linear-relu",
    title: "MLP linear layer + ReLU",
    shortName: "Linear + ReLU",
    category: "machine-learning",
    description: "Computes an 8-input, 8-output fully connected layer followed by ReLU.",
    filename: "mlp_linear_relu.cu",
    code: `__global__ void linear_relu(const float *input, const float *weights,
                              const float *bias, float *out) {
  int neuron = blockIdx.x * blockDim.x + threadIdx.x;
  if (neuron < 8) {
    float sum = bias[neuron];
    for (int i = 0; i < 8; i++) {
      sum += weights[neuron * 8 + i] * input[i];
    }
    if (sum < 0.0f) {
      sum = 0.0f;
    }
    out[neuron] = sum;
  }
}`,
    grid: [1, 1],
    block: [32, 1],
    n: 8,
    sharedBytes: 0,
    buffers: n => ({
      input: floats(n, i => (i - 3) / 4),
      weights: floats(n * n, i => ((i * 5) % 17 - 8) / 16),
      bias: floats(n, i => (i - 4) / 4),
      out: new Float32Array(n),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Linear transform", detail: "Each output neuron computes a weighted sum plus its bias." },
      { label: "ReLU", detail: "Negative sums are replaced with zero; non-negative sums are unchanged." },
    ],
    stages: [
      { label: "Select neuron", detail: "A thread index identifies one output neuron." },
      { label: "Dot product and bias", detail: "Accumulate the neuron's row of weights against the input and add its bias." },
      { label: "Activate", detail: "Apply the ReLU function to the scalar sum." },
    ],
    expected: (n, buffers) => {
      const out = new Float32Array(n);
      for (let neuron = 0; neuron < n; neuron++) {
        let sum = buffers.bias[neuron];
        for (let i = 0; i < n; i++) sum += buffers.weights[neuron * n + i] * buffers.input[i];
        out[neuron] = Math.max(0, sum);
      }
      return out;
    },
  };

  const cnn = {
    id: "cnn-valid-conv1d",
    title: "CNN valid 1D convolution",
    shortName: "1D convolution",
    category: "machine-learning",
    description: "Applies a five-element filter to a 32-element input, producing 28 valid window outputs.",
    filename: "cnn_valid_conv1d.cu",
    code: `__global__ void conv1d_valid(const float *input, const float *filter,
                               float *out) {
  int position = blockIdx.x * blockDim.x + threadIdx.x;
  if (position < 28) {
    float sum = 0.0f;
    for (int k = 0; k < 5; k++) {
      sum += input[position + k] * filter[k];
    }
    out[position] = sum;
  }
}`,
    grid: [1, 1],
    block: [32, 1],
    n: 32,
    sharedBytes: 0,
    buffers: n => ({
      input: floats(n, i => (i % 11 - 5) / 4),
      filter: floats(5, i => (i - 2) / 5),
      out: new Float32Array(n - 4),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Valid windows", detail: "Only filter positions fully contained in the input produce outputs." },
      { label: "CNN cross-correlation", detail: "The filter is applied in its stored order, as in common CNN convolution layers." },
    ],
    stages: [
      { label: "Choose window", detail: "Each active thread identifies a starting position in the input." },
      { label: "Accumulate filter", detail: "Multiply five input values by the corresponding filter values and sum them." },
      { label: "Write output", detail: "Store one result for the selected valid window." },
    ],
    expected: (n, buffers) => {
      const out = new Float32Array(n - 4);
      for (let position = 0; position < n - 4; position++) {
        let sum = 0;
        for (let k = 0; k < 5; k++) sum += buffers.input[position + k] * buffers.filter[k];
        out[position] = sum;
      }
      return out;
    },
  };

  const lmHead = {
    id: "lm-head",
    title: "Language-model vocabulary projection",
    shortName: "LM head",
    category: "machine-learning",
    description: "Projects an 8-value hidden vector to 16 vocabulary logits with a matrix-vector product.",
    filename: "lm_head.cu",
    code: `__global__ void lm_head(const float *hidden, const float *weights,
                           float *logits) {
  int token = blockIdx.x * blockDim.x + threadIdx.x;
  if (token < 16) {
    float score = 0.0f;
    for (int i = 0; i < 8; i++) {
      score += weights[token * 8 + i] * hidden[i];
    }
    logits[token] = score;
  }
}`,
    grid: [1, 1],
    block: [32, 1],
    n: 16,
    sharedBytes: 0,
    buffers: n => ({
      hidden: floats(8, i => (i - 3) / 4),
      weights: floats(n * 8, i => ((i * 3) % 23 - 11) / 32),
      logits: new Float32Array(n),
    }),
    outputBuffer: "logits",
    concepts: [
      { label: "Vocabulary projection", detail: "Each vocabulary row maps the hidden vector to one scalar score (logit)." },
      { label: "Matrix-vector product", detail: "The hidden width is eight and the vocabulary dimension is the preset size n." },
    ],
    stages: [
      { label: "Select token row", detail: "A thread index identifies one row of the projection matrix." },
      { label: "Accumulate score", detail: "Multiply the row's eight weights by the hidden vector and sum the products." },
      { label: "Store logit", detail: "Write the score at the corresponding vocabulary index." },
    ],
    expected: (n, buffers) => {
      const out = new Float32Array(n);
      for (let token = 0; token < n; token++) {
        let score = 0;
        for (let i = 0; i < 8; i++) score += buffers.weights[token * 8 + i] * buffers.hidden[i];
        out[token] = score;
      }
      return out;
    },
  };

  const strided = {
    id: "strided-access",
    title: "Strided input access",
    shortName: "Strided access",
    category: "memory-access",
    description: "Reads every second input element into a contiguous 32-element output.",
    filename: "strided_access.cu",
    code: `__global__ void strided_access(const float *input, float *out) {
  int i = threadIdx.x;
  if (i < 32) {
    out[i] = input[i * 2];
  }
}`,
    grid: [1, 1],
    block: [32, 1],
    n: 64,
    sharedBytes: 0,
    buffers: n => ({
      input: floats(n, i => i + 0.5),
      out: new Float32Array(n / 2),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Stride", detail: "Adjacent threads read addresses separated by two float elements." },
      { label: "Contiguous output", detail: "Each thread writes to its own consecutive output index." },
    ],
    stages: [
      { label: "Select source", detail: "Thread i reads input element 2 × i." },
      { label: "Copy", detail: "Store the selected value at output element i." },
    ],
    expected: (n, buffers) => floats(n / 2, i => buffers.input[i * 2]),
  };

  const divergence = {
    id: "divergent-branches",
    title: "Divergent branches",
    shortName: "Divergence",
    category: "control-flow",
    description: "Splits one warp into two branches based on whether the lane index is below 16.",
    filename: "divergent_branches.cu",
    code: `__global__ void divergent_branches(const float *input, float *out) {
  int i = threadIdx.x;
  if (i < 16) {
    out[i] = input[i] * 2.0f;
  } else {
    out[i] = input[i] + 1.0f;
  }
}`,
    grid: [1, 1],
    block: [32, 1],
    n: 32,
    sharedBytes: 0,
    buffers: n => ({
      input: floats(n, i => (i - 16) / 4),
      out: new Float32Array(n),
    }),
    outputBuffer: "out",
    concepts: [
      { label: "Warp branch", detail: "Lanes in the same warp take different sides of the index comparison." },
      { label: "Per-lane result", detail: "Each branch writes exactly one value for its own lane." },
    ],
    stages: [
      { label: "Compare lane index", detail: "Each thread checks whether its index is below 16." },
      { label: "Compute branch result", detail: "Lower indices are doubled; the other indices have one added." },
      { label: "Store", detail: "Each thread writes its result to its matching output index." },
    ],
    expected: (n, buffers) => floats(n, i => i < 16 ? buffers.input[i] * 2 : buffers.input[i] + 1),
  };

  return [vectorAdd, reduction, matmul, mlp, cnn, lmHead, strided, divergence];
});
