# NVIDIA CUDA support

cuvis supports two distinct build paths:

- **CUDA build:** when CMake finds a CUDA compiler at version 11.0 or newer,
  `src/kernels.cu` is compiled as CUDA. For NVIDIA's CUDA compiler (nvcc),
  CMake selects a conservative set of device-code targets according to the
  toolkit release, or uses an explicit user selection. Other CUDA compiler
  frontends need explicit targets. The target list is not a claim that this
  workspace or every target has been compiled or run on a physical GPU.
- **CPU/analytical build:** when no CUDA compiler is found, the `.cu` file is
  compiled as host C++; CUDA kernels are excluded and the analytical GPU model
  is used. This path does not measure or execute GPU kernels. The host C++
  compiler and its target ABI are separate from `CMAKE_CUDA_ARCHITECTURES`.

## Default CUDA architecture targets

The default list is selected from the exact toolkit minor-version bands below.
Numeric values target the corresponding baseline `sm_XX` code; the compiler
may also emit its matching virtual code according to CMake's CUDA architecture
property behavior.

| CUDA toolkit | Default architecture targets |
| --- | --- |
| 11.0.x | 60, 70, 75, 80 |
| 11.1.x–11.3.x | 60, 70, 75, 80, 86 |
| 11.4.x–11.7.x | 60, 70, 75, 80, 86, 87 |
| 11.8.x | 60, 70, 75, 80, 86, 87, 89, 90 |
| 12.0.x–12.7.x | 60, 70, 75, 80, 86, 87, 89, 90 |
| 12.8.x | 60, 70, 75, 80, 86, 87, 89, 90, 100, 101, 120 |
| 12.9.x | 60, 70, 75, 80, 86, 87, 89, 90, 100, 101, 103, 120, 121 |
| 13.0.x–13.3.x | 75, 80, 86, 87, 89, 90, 100, 103, 110, 120, 121 |
| 13.4.x | 75, 80, 86, 87, 88, 89, 90, 100, 103, 107, 110, 120, 121 |

Older CUDA 11.x toolkits do not receive newer targets such as SM 8.6, 8.7,
8.9/9.0, or Blackwell. Blackwell targets first appear in CUDA 12.8 (SM 10.0,
10.1, and 12.0); CUDA 12.9 adds SM 10.3 and 12.1. CUDA 13.0 removes offline
compilation for pre-Turing architectures and changes the former SM 10.1 code
target to SM 11.0. CUDA 13.4's compiler guide lists SM 8.8 and preview SM 10.7
targets; cuvis does not claim a shipping GPU mapping for SM 8.8 or production
readiness for the SM 10.7 preview.

The NVIDIA compute-capability table maps, among other products, Jetson Orin to
SM 8.7, Ada GPUs to SM 8.9, Hopper to SM 9.0, current Blackwell products to
SM 10.0/10.3 and SM 12.0/12.1, and Jetson T-series devices to SM 11.0. A
toolkit's ability to emit a target does not establish that a particular device,
driver, host compiler, operating system, or deployment image is supported.

Unlisted toolkit minor versions and non-NVIDIA compiler frontends intentionally
receive no automatic list. Set an architecture list explicitly for them.

## Selecting architectures and Jetson builds

Set `CMAKE_CUDA_ARCHITECTURES` to keep only the targets you need. It takes
precedence over the `CUDAARCHS` environment variable; otherwise `CUDAARCHS` is
honored before the project default. For example, this requests Orin, Ada,
Hopper, and baseline Blackwell targets supported by CUDA 12.8 or newer:

```sh
cmake -S . -B build -DCMAKE_CUDA_ARCHITECTURES='87;89;90;100;101;120'
cmake --build build
```

Remove targets unsupported by your installed toolkit. A smaller list reduces
compile time and binary size; do not pass a target that the selected compiler
does not support. CMake's explicit value is passed through unchanged.

Jetson CUDA toolkits are tied to the JetPack/Jetson Linux release and its
supported host or cross-compilation environment. Install and select the CUDA
compiler from NVIDIA's matching Jetson development stack; do not assume a
desktop CUDA toolkit or host compiler is a valid Jetson toolchain. Follow the
Jetson Linux cross-platform environment guidance when building on a separate
host.

## Scope and validation

Architecture selection controls compilation targets only. The built-in CUDA
suite contains general-purpose kernels; it does not implement multi-GPU
execution/orchestration, NVLink operations or measurements, or tensor-core
instructions/tuning. The analytical model may carry device capability data,
but that is not execution support for those features.

The architecture-selection CMake test runs without CUDA. A CPU build verifies
the fallback only. CUDA compilation must be validated separately with the
target toolkit and hardware; this project workspace has not validated these
targets on devices or measured performance across them.

## NVIDIA references

- [CUDA GPU compute capability](https://developer.nvidia.com/cuda/gpus) —
  capability-to-product mapping.
- [CUDA 11.1 release notes](https://docs.nvidia.com/cuda/archive/11.1.1/cuda-toolkit-release-notes/index.html)
  and [CUDA 11.4 release notes](https://docs.nvidia.com/cuda/archive/11.4.4/cuda-toolkit-release-notes/index.html)
  — toolkit release support context for Ampere and Orin-era Jetson software.
- [CUDA 11.8 release notes](https://docs.nvidia.com/cuda/archive/11.8.0/cuda-toolkit-release-notes/index.html)
  — Ada/Hopper-era toolkit support.
- [CUDA 12.8 features](https://docs.nvidia.com/cuda/archive/12.8.2/cuda-features-archive/index.html)
  and [CUDA 12.9 features](https://docs.nvidia.com/cuda/archive/12.9.2/cuda-features-archive/index.html)
  — Blackwell target additions.
- [CUDA 13.0 release notes](https://docs.nvidia.com/cuda/archive/13.0.0/cuda-toolkit-release-notes/)
  — pre-Turing offline compilation removal and architecture naming changes.
- [CUDA Compiler Driver (NVCC) 13.4](https://docs.nvidia.com/cuda/cuda-compiler-driver-nvcc/index.html)
  — current listed GPU code targets, including SM 8.8 and SM 10.7.
- [CUDA Toolkit 13.4 announcement](https://developer.nvidia.com/blog/cuda-toolkit-13-4-adds-windows-on-arm-support-and-greater-control-over-shared-gpus/)
  — preview functional support for Rubin / SM 10.7.
- [Jetson Linux Developer Guide](https://docs.nvidia.com/jetson/archives/)
  — Jetson release and cross-platform toolchain guidance.
- [Jetson Orin SM 8.7 compiler-target guidance](https://forums.developer.nvidia.com/t/how-do-i-install-previous-version-of-cuda-toolkit-on-jetson-agx-orin/239068/2)
  — NVIDIA Developer Forums.
