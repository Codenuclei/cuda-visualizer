// cuvis — CUDA visualizer core data model
// Structures shared between the config parser, the occupancy calculator,
// the analytical performance model and the JSON exporter.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace cuvis {

// Hardware description of one GPU. Populated either from a real CUDA
// device (nvcc / CUDA 11-13 path) or from an accel-sim / GPGPU-Sim
// gpgpusim.config file (CPU path).
struct GpuSpec {
  std::string id;          // e.g. "SM86_RTX3070"
  std::string name;        // e.g. "GeForce RTX 3070"
  int ccMajor = 0;         // compute capability
  int ccMinor = 0;

  int numSMs = 0;
  int warpSize = 32;
  int maxThreadsPerSM = 0;
  int maxBlocksPerSM = 0;
  int maxThreadsPerBlock = 1024;
  int regsPerSM = 0;
  int regsPerBlockLimit = 0;
  long shmemPerSM = 0;         // bytes
  long shmemPerBlockLimit = 0; // bytes
  int fp32CoresPerSM = 0;

  double coreClockMHz = 0;
  double dramClockMHz = 0;

  int memChannels = 0;
  int dramBusWidthBytes = 0;   // per channel
  int dramCmdFreqRatio = 2;
  double memBandwidthGBs = 0;  // derived

  long l1SizeBytes = 0;        // per SM
  long l2SizeBytes = 0;        // total
  int l1LatencyCycles = 0;
  int smemLatencyCycles = 0;
  int dramLatencyCycles = 0;
  int kernelLaunchLatencyCycles = 0;

  int schedulersPerSM = 4;
  bool tensorCores = false;

  double peakGflopsFp32() const {
    return numSMs * fp32CoresPerSM * 2.0 * coreClockMHz / 1000.0;
  }
  int maxWarpsPerSM() const { return maxThreadsPerSM / warpSize; }
};

// A kernel launch: either a built-in workload or one parsed from an
// accel-sim SASS trace (kernelslist.g).
struct KernelLaunch {
  std::string name;
  std::string mangled;
  unsigned gridX = 1, gridY = 1, gridZ = 1;
  unsigned blockX = 1, blockY = 1, blockZ = 1;
  unsigned regsPerThread = 32;
  unsigned staticShmem = 0;         // bytes per block
  unsigned long long streamId = 0;

  // Workload characterization used by the analytical model.
  double flopsPerThread = 0;
  double bytesPerThread = 0;        // DRAM-visible bytes if caches missed
  double instPerThread = 0;
  double l1HitRate = 0.0;           // characteristic locality
  double l2HitRate = 0.0;
  double branchDivergence = 0.0;    // 0..1 penalty
  double shmemBankConflictRate = 0.0;
  std::string category;             // "memory", "compute", "mixed"

  unsigned long long threadsTotal() const {
    return (unsigned long long)gridX * gridY * gridZ * blockX * blockY * blockZ;
  }
  unsigned threadsPerBlock() const { return blockX * blockY * blockZ; }
  unsigned long long blocksTotal() const {
    return (unsigned long long)gridX * gridY * gridZ;
  }
};

// Occupancy analysis result (mirrors cudaOccupancyMaxActiveBlocksPerMultiprocessor).
struct OccupancyInfo {
  int activeBlocksPerSM = 0;
  int activeWarpsPerSM = 0;
  double occupancy = 0;         // activeWarps / maxWarps
  std::string limiter;          // "warps" | "blocks" | "registers" | "sharedmem"
  int limitWarps = 0, limitBlocks = 0, limitRegs = 0, limitShmem = 0;
};

// Full simulated / measured statistics for one kernel on one GPU.
// Field names follow accel-sim's stat vocabulary (example_stats.yml).
struct KernelStats {
  KernelLaunch launch;
  OccupancyInfo occ;

  double durationUs = 0;
  double gpuTotSimCycle = 0;     // gpu_tot_sim_cycle
  double gpuTotSimInsn = 0;      // gpu_tot_sim_insn
  double gpuIpc = 0;             // gpu_ipc
  double achievedOccupancy = 0;  // gpu_occupancy (runtime, <= theoretical)
  double gflops = 0;
  double dramReads = 0;          // 32B sectors
  double dramWrites = 0;
  double l1HitRate = 0;
  double l2HitRate = 0;
  double l2BwGBs = 0;            // L2_BW
  double memThroughputGBs = 0;
  double smEfficiency = 0;       // fraction of SMs with work
  double waves = 0;              // block waves per SM
  double aiFlopPerByte = 0;      // arithmetic intensity (roofline x-axis)
  std::string bound;             // "Memory bound" | "Compute bound" | "Latency bound"
  double timelineStartUs = 0;
  double timelineEndUs = 0;
};

// Timeline event: kernels plus memcpys, matching accel-sim's
// kernelslist command stream (kernel-N.traceg / MemcpyHtoD lines).
struct TimelineEvent {
  std::string kind;   // "kernel" | "memcpyH2D" | "memcpyD2H"
  std::string label;
  double startUs = 0;
  double endUs = 0;
  int lane = 0;       // stream lane
};

struct GpuReport {
  GpuSpec spec;
  std::vector<KernelStats> kernels;
  std::vector<TimelineEvent> timeline;
  double totalTimeUs = 0;
};

}  // namespace cuvis
