(function (root, factory) {
  const catalog = factory();
  if (typeof module === "object" && module.exports) module.exports = catalog;
  root.LibraryCatalog = catalog;
})(typeof globalThis !== "undefined" ? globalThis : self, function () {
  "use strict";
  return {
    "libraries": [
      {
        "id": "pytorch",
        "title": "PyTorch",
        "version": "2.5.1",
        "language": "Python",
        "description": "Tensors, neural-network modules, and GPU-oriented operations with pinned upstream source."
      },
      {
        "id": "numpy",
        "title": "NumPy",
        "version": "2.1.3",
        "language": "Python",
        "description": "Array and numerical operations; softmax is shown as an explicit stable exp/sum composition."
      },
      {
        "id": "tensorflowjs",
        "title": "TensorFlow.js",
        "version": "4.22.0",
        "language": "JavaScript",
        "description": "Tensor operations and activations with browser-friendly pinned upstream source."
      }
    ],
    "operations": [
      {
        "id": "pytorch-linear",
        "library": "pytorch",
        "title": "Linear + ReLU",
        "api": "torch.nn.Linear + torch.nn.functional.relu",
        "language": "Python",
        "pack": "packs/pytorch-linear.json",
        "tags": [
          "linear",
          "ann",
          "relu",
          "pytorch"
        ]
      },
      {
        "id": "pytorch-conv1d",
        "library": "pytorch",
        "title": "Valid Conv1d",
        "api": "torch.nn.Conv1d",
        "language": "Python",
        "pack": "packs/pytorch-conv1d.json",
        "tags": [
          "convolution",
          "cnn",
          "pytorch"
        ]
      },
      {
        "id": "pytorch-attention",
        "library": "pytorch",
        "title": "Scaled dot-product attention",
        "api": "torch.nn.functional.scaled_dot_product_attention",
        "language": "Python",
        "pack": "packs/pytorch-attention.json",
        "tags": [
          "attention",
          "transformer",
          "softmax",
          "reduction",
          "pytorch"
        ]
      },
      {
        "id": "pytorch-layernorm",
        "library": "pytorch",
        "title": "LayerNorm",
        "api": "torch.nn.LayerNorm",
        "language": "Python",
        "pack": "packs/pytorch-layernorm.json",
        "tags": [
          "normalization",
          "transformer",
          "pytorch"
        ]
      },
      {
        "id": "numpy-matmul",
        "library": "numpy",
        "title": "Matrix multiplication",
        "api": "numpy.matmul (@)",
        "language": "Python",
        "pack": "packs/numpy-matmul.json",
        "tags": [
          "matrix",
          "linear-algebra",
          "reduction",
          "numpy"
        ]
      },
      {
        "id": "numpy-softmax",
        "library": "numpy",
        "title": "Stable softmax composition",
        "api": "numpy.exp + numpy.sum",
        "language": "Python",
        "pack": "packs/numpy-softmax.json",
        "tags": [
          "softmax",
          "normalization",
          "reduction",
          "numpy"
        ]
      },
      {
        "id": "tfjs-sigmoid",
        "library": "tensorflowjs",
        "title": "Sigmoid activation",
        "api": "tf.sigmoid",
        "language": "JavaScript",
        "pack": "packs/tfjs-sigmoid.json",
        "tags": [
          "activation",
          "elementwise",
          "tensorflowjs"
        ]
      },
      {
        "id": "tfjs-softmax",
        "library": "tensorflowjs",
        "title": "Softmax",
        "api": "tf.softmax",
        "language": "JavaScript",
        "pack": "packs/tfjs-softmax.json",
        "tags": [
          "softmax",
          "normalization",
          "reduction",
          "tensorflowjs"
        ]
      }
    ]
  };
});
