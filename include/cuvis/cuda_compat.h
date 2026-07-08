// cuvis — CUDA 11/12/13 compatibility layer.
//
// When compiled with nvcc (CUDA 11.0 through 13.x) this header maps the
// small runtime surface cuvis needs onto the real CUDA runtime, papering
// over the API differences between major versions:
//
//   * CUDA 11: cudaDeviceProp::clockRate / memoryClockRate are present.
//   * CUDA 12: texture reference APIs removed (we never used them);
//              cudaOccupancyMaxActiveBlocksPerMultiprocessor unchanged.
//   * CUDA 13 (release 12.9+ transition / 13.0): clockRate,
//              memoryClockRate and kernelExecTimeoutEnabled were removed
//              from cudaDeviceProp; clocks must be queried through
//              cudaDeviceGetAttribute(cudaDevAttrClockRate /
//              cudaDevAttrMemoryClockRate).
//
// When compiled with a plain host compiler (no NVIDIA GPU, e.g. this AMD
// machine) CUVIS_HAVE_CUDA stays undefined and the engine falls back to
// the accel-sim-derived analytical device model — same structs, same
// call sites, no #ifdef soup outside this header.
#pragma once

#if defined(__CUDACC__) || defined(CUVIS_FORCE_CUDA)
#define CUVIS_HAVE_CUDA 1
#include <cuda_runtime.h>

#if !defined(CUDART_VERSION)
#error "cuda_runtime.h did not define CUDART_VERSION"
#endif

#if CUDART_VERSION < 11000
#error "cuvis requires CUDA 11.0 or newer (11.x, 12.x and 13.x are supported)"
#endif

#include <cstdio>
#include <cstdlib>

namespace cuvis {

#define CUVIS_CHECK(call)                                                  \
  do {                                                                     \
    cudaError_t err__ = (call);                                            \
    if (err__ != cudaSuccess) {                                            \
      std::fprintf(stderr, "CUDA error %s at %s:%d — %s\n",                \
                   cudaGetErrorName(err__), __FILE__, __LINE__,            \
                   cudaGetErrorString(err__));                             \
      std::exit(1);                                                        \
    }                                                                      \
  } while (0)

// Core clock in kHz. cudaDeviceProp::clockRate was removed in CUDA 13.
inline int deviceClockRateKHz(int device) {
#if CUDART_VERSION >= 13000
  int v = 0;
  CUVIS_CHECK(cudaDeviceGetAttribute(&v, cudaDevAttrClockRate, device));
  return v;
#else
  cudaDeviceProp p;
  CUVIS_CHECK(cudaGetDeviceProperties(&p, device));
  return p.clockRate;
#endif
}

// Memory clock in kHz. Removed from cudaDeviceProp in CUDA 13.
inline int deviceMemoryClockRateKHz(int device) {
#if CUDART_VERSION >= 13000
  int v = 0;
  CUVIS_CHECK(cudaDeviceGetAttribute(&v, cudaDevAttrMemoryClockRate, device));
  return v;
#else
  cudaDeviceProp p;
  CUVIS_CHECK(cudaGetDeviceProperties(&p, device));
  return p.memoryClockRate;
#endif
}

inline const char *runtimeVersionString() {
  static char buf[32];
  int v = 0;
  cudaRuntimeGetVersion(&v);
  std::snprintf(buf, sizeof buf, "%d.%d", v / 1000, (v % 1000) / 10);
  return buf;
}

}  // namespace cuvis

#else  // ---------------------------------------------------------------
// Host-only build: no CUDA toolkit present. The engine uses the
// analytical device model sourced from accel-sim gpgpusim.config files.
#undef CUVIS_HAVE_CUDA

namespace cuvis {
inline const char *runtimeVersionString() { return "none (analytical model)"; }
}  // namespace cuvis

#endif
