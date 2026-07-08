// cuvis — built-in kernel suite.
//
// This translation unit is valid CUDA C++ *and* valid plain C++:
//   * under nvcc (CUDA 11-13) the __global__ kernels compile and are
//     launched + timed with cudaEvent, giving real measurements;
//   * under a host compiler the kernels are compiled out and only the
//     workload characterizations remain, feeding the analytical model.
//
// The suite mirrors classic GPGPU benchmarks used by accel-sim's
// gpu-app-collection (vectoradd, sgemm tiling, stencil, reduction,
// histogram, transpose, streaming copy).

#include "cuvis/kernels.h"
#include "cuvis/cuda_compat.h"

#ifdef CUVIS_HAVE_CUDA

namespace cuvis_kernels {

constexpr int TILE = 32;

__global__ void vecAdd(const float *a, const float *b, float *c, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) c[i] = a[i] + b[i];
}

__global__ void saxpy(float alpha, const float *x, float *y, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) y[i] = alpha * x[i] + y[i];
}

__global__ void sgemmTiled(const float *A, const float *B, float *C, int N) {
  __shared__ float As[TILE][TILE];
  __shared__ float Bs[TILE][TILE];
  int row = blockIdx.y * TILE + threadIdx.y;
  int col = blockIdx.x * TILE + threadIdx.x;
  float acc = 0.f;
  for (int t = 0; t < N / TILE; ++t) {
    As[threadIdx.y][threadIdx.x] = A[row * N + t * TILE + threadIdx.x];
    Bs[threadIdx.y][threadIdx.x] = B[(t * TILE + threadIdx.y) * N + col];
    __syncthreads();
#pragma unroll
    for (int k = 0; k < TILE; ++k) acc += As[threadIdx.y][k] * Bs[k][threadIdx.x];
    __syncthreads();
  }
  if (row < N && col < N) C[row * N + col] = acc;
}

__global__ void stencil2d(const float *in, float *out, int w, int h) {
  int x = blockIdx.x * blockDim.x + threadIdx.x;
  int y = blockIdx.y * blockDim.y + threadIdx.y;
  if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
    out[y * w + x] = 0.2f * (in[y * w + x] + in[y * w + x - 1] +
                             in[y * w + x + 1] + in[(y - 1) * w + x] +
                             in[(y + 1) * w + x]);
  }
}

__global__ void reduceSum(const float *in, float *out, int n) {
  extern __shared__ float sdata[];
  unsigned tid = threadIdx.x;
  unsigned i = blockIdx.x * blockDim.x * 2 + threadIdx.x;
  sdata[tid] = (i < (unsigned)n ? in[i] : 0.f) +
               (i + blockDim.x < (unsigned)n ? in[i + blockDim.x] : 0.f);
  __syncthreads();
  for (unsigned s = blockDim.x / 2; s > 0; s >>= 1) {
    if (tid < s) sdata[tid] += sdata[tid + s];
    __syncthreads();
  }
  if (tid == 0) out[blockIdx.x] = sdata[0];
}

__global__ void histogram256(const unsigned char *data, unsigned *bins, int n) {
  __shared__ unsigned local[256];
  if (threadIdx.x < 256) local[threadIdx.x] = 0;
  __syncthreads();
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  int stride = gridDim.x * blockDim.x;
  for (; i < n; i += stride) atomicAdd(&local[data[i]], 1u);
  __syncthreads();
  if (threadIdx.x < 256) atomicAdd(&bins[threadIdx.x], local[threadIdx.x]);
}

__global__ void transposeShared(const float *in, float *out, int w, int h) {
  __shared__ float tile[TILE][TILE + 1];  // +1 avoids bank conflicts
  int x = blockIdx.x * TILE + threadIdx.x;
  int y = blockIdx.y * TILE + threadIdx.y;
  if (x < w && y < h) tile[threadIdx.y][threadIdx.x] = in[y * w + x];
  __syncthreads();
  x = blockIdx.y * TILE + threadIdx.x;
  y = blockIdx.x * TILE + threadIdx.y;
  if (x < h && y < w) out[y * h + x] = tile[threadIdx.x][threadIdx.y];
}

__global__ void streamCopy(const float *src, float *dst, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  int stride = gridDim.x * blockDim.x;
  for (; i < n; i += stride) dst[i] = src[i];
}

}  // namespace cuvis_kernels
#endif  // CUVIS_HAVE_CUDA

namespace cuvis {

// Workload characterizations. regs/shmem match what nvcc typically emits
// for the kernels above (checked with --ptxas-options=-v); flops/bytes are
// exact per the algorithm. These drive the analytical model when no
// NVIDIA GPU is present, and label real runs when one is.
std::vector<KernelLaunch> builtinSuite() {
  std::vector<KernelLaunch> v;
  const int N = 1 << 24;         // 16M elements for streaming kernels
  const int MAT = 2048;          // sgemm 2048x2048
  const int IMG = 4096;          // stencil / transpose 4096x4096

  {
    KernelLaunch k;
    k.name = "vecAdd";
    k.mangled = "_Z6vecAddPKfS0_Pfi";
    k.gridX = (N + 255) / 256; k.blockX = 256;
    k.regsPerThread = 16; k.staticShmem = 0;
    k.flopsPerThread = 1; k.bytesPerThread = 12; k.instPerThread = 10;
    k.l1HitRate = 0.02; k.l2HitRate = 0.10;
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "saxpy";
    k.mangled = "_Z5saxpyfPKfPfi";
    k.gridX = (N + 255) / 256; k.blockX = 256;
    k.regsPerThread = 18; k.staticShmem = 0;
    k.flopsPerThread = 2; k.bytesPerThread = 12; k.instPerThread = 11;
    k.l1HitRate = 0.02; k.l2HitRate = 0.10;
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "sgemmTiled";
    k.mangled = "_Z10sgemmTiledPKfS0_Pfi";
    k.gridX = MAT / 32; k.gridY = MAT / 32;
    k.blockX = 32; k.blockY = 32;
    k.regsPerThread = 38;
    k.staticShmem = 2 * 32 * 32 * 4;  // As + Bs tiles
    k.flopsPerThread = 2.0 * MAT;     // one FMA per k-step
    k.bytesPerThread = 2.0 * MAT * 4 / 32;  // tile reuse: 1/TILE of naive
    k.instPerThread = 3.5 * MAT;
    k.l1HitRate = 0.55; k.l2HitRate = 0.60;
    k.category = "compute";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "stencil2d";
    k.mangled = "_Z9stencil2dPKfPfii";
    k.gridX = IMG / 32; k.gridY = IMG / 8;
    k.blockX = 32; k.blockY = 8;
    k.regsPerThread = 22; k.staticShmem = 0;
    k.flopsPerThread = 5; k.bytesPerThread = 24; k.instPerThread = 22;
    k.l1HitRate = 0.62; k.l2HitRate = 0.35;  // 5-point halo reuse
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "reduceSum";
    k.mangled = "_Z9reduceSumPKfPfi";
    k.gridX = (N + 511) / 512; k.blockX = 256;
    k.regsPerThread = 20;
    k.staticShmem = 256 * 4;
    k.flopsPerThread = 2 + 8;          // 2 loads-adds + log2 tree share
    k.bytesPerThread = 8.03;           // 2 floats in, tiny out
    k.instPerThread = 42;              // sync-heavy tree
    k.l1HitRate = 0.05; k.l2HitRate = 0.12;
    k.branchDivergence = 0.25;         // tail of the tree idles lanes
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "histogram256";
    k.mangled = "_Z12histogram256PKhPji";
    k.gridX = 1024; k.blockX = 256;
    k.regsPerThread = 24;
    k.staticShmem = 256 * 4;
    k.flopsPerThread = 0;
    k.bytesPerThread = 64;             // grid-stride over 16M bytes
    k.instPerThread = 160;
    k.l1HitRate = 0.10; k.l2HitRate = 0.25;
    k.shmemBankConflictRate = 0.35;    // atomics contend on hot bins
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "transposeShared";
    k.mangled = "_Z15transposeSharedPKfPfii";
    k.gridX = IMG / 32; k.gridY = IMG / 32;
    k.blockX = 32; k.blockY = 32;
    k.regsPerThread = 25;
    k.staticShmem = 32 * 33 * 4;       // padded tile
    k.flopsPerThread = 0; k.bytesPerThread = 8; k.instPerThread = 18;
    k.l1HitRate = 0.08; k.l2HitRate = 0.20;
    k.category = "memory";
    v.push_back(k);
  }
  {
    KernelLaunch k;
    k.name = "streamCopy";
    k.mangled = "_Z10streamCopyPKfPfi";
    k.gridX = 2048; k.blockX = 256;
    k.regsPerThread = 14; k.staticShmem = 0;
    k.flopsPerThread = 0;
    k.bytesPerThread = 256;            // grid-stride, 16M floats * 8B / 512K threads
    k.instPerThread = 220;
    k.l1HitRate = 0.02; k.l2HitRate = 0.08;
    k.category = "memory";
    v.push_back(k);
  }
  return v;
}

}  // namespace cuvis
