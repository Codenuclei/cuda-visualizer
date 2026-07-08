// cuvis — occupancy calculator + analytical performance model.
//
// The occupancy math replicates cudaOccupancyMaxActiveBlocksPerMultiprocessor
// (CUDA occupancy calculator rules: warp limit, block limit, register file
// limit with per-warp register allocation granularity, shared memory limit).
//
// The performance model is a roofline-style estimator informed by the
// GPGPU-Sim latencies parsed from gpgpusim.config: kernels are classified
// as compute-, memory- or latency-bound, and duration / IPC / DRAM sector
// counts / cache hit rates are derived analytically. Stat names follow
// accel-sim's vocabulary (gpu_tot_sim_cycle, gpu_ipc, gpu_occupancy,
// L2_BW, total dram reads/writes) so results can be compared 1:1 with
// real simulator output.

#include "cuvis/engine.h"

#include <algorithm>
#include <cmath>

namespace cuvis {

namespace {
int roundUp(int v, int g) { return ((v + g - 1) / g) * g; }
}  // namespace

OccupancyInfo computeOccupancy(const GpuSpec &g, const KernelLaunch &k) {
  OccupancyInfo o;
  int tpb = (int)k.threadsPerBlock();
  if (tpb == 0) return o;

  int warpsPerBlock = (tpb + g.warpSize - 1) / g.warpSize;
  int maxWarps = g.maxWarpsPerSM();

  // 1) Warp / thread limit.
  o.limitWarps = std::max(1, maxWarps / warpsPerBlock);

  // 2) Hardware block slots.
  o.limitBlocks = g.maxBlocksPerSM;

  // 3) Register file. CUDA allocates registers per warp with a
  //    granularity of 256 registers (Maxwell+).
  if (k.regsPerThread > 0) {
    int regsPerWarp = roundUp((int)k.regsPerThread * g.warpSize, 256);
    int warpsByRegs = g.regsPerSM / std::max(1, regsPerWarp);
    o.limitRegs = std::max(0, warpsByRegs / warpsPerBlock);
  } else {
    o.limitRegs = o.limitBlocks;
  }

  // 4) Shared memory (256B allocation granularity).
  if (k.staticShmem > 0) {
    int shmemPerBlock = roundUp((int)k.staticShmem, 256);
    o.limitShmem = (int)(g.shmemPerSM / shmemPerBlock);
  } else {
    o.limitShmem = o.limitBlocks;
  }

  o.activeBlocksPerSM = std::min(std::min(o.limitWarps, o.limitBlocks),
                                 std::min(o.limitRegs, o.limitShmem));
  o.activeBlocksPerSM = std::max(0, o.activeBlocksPerSM);
  o.activeWarpsPerSM = o.activeBlocksPerSM * warpsPerBlock;
  o.occupancy = maxWarps > 0 ? (double)o.activeWarpsPerSM / maxWarps : 0.0;

  int m = o.activeBlocksPerSM;
  if (m == o.limitRegs && m < std::min(o.limitWarps, o.limitBlocks))
    o.limiter = "registers";
  else if (m == o.limitShmem && m < std::min(o.limitWarps, o.limitBlocks))
    o.limiter = "shared memory";
  else if (m == o.limitBlocks && m < o.limitWarps)
    o.limiter = "block slots";
  else
    o.limiter = "warps";
  return o;
}

KernelStats simulateKernel(const GpuSpec &g, const KernelLaunch &k) {
  KernelStats s;
  s.launch = k;
  s.occ = computeOccupancy(g, k);

  const double threads = (double)k.threadsTotal();
  const double blocks = (double)k.blocksTotal();
  const double coreHz = g.coreClockMHz * 1e6;

  // ---- wave analysis -------------------------------------------------
  double blocksPerWave =
      std::max(1.0, (double)s.occ.activeBlocksPerSM * g.numSMs);
  s.waves = blocks / blocksPerWave;
  double fullWaves = std::floor(s.waves);
  double tailFraction = s.waves - fullWaves;
  // "Tail effect": a partial last wave still costs nearly a full wave.
  double effectiveWaves = fullWaves + (tailFraction > 0 ? 1.0 : 0.0);
  double waveUtilization =
      s.waves / std::max(1e-9, effectiveWaves);  // <=1, worse for small grids

  s.smEfficiency = std::min(1.0, blocks / (double)g.numSMs);

  // ---- compute time --------------------------------------------------
  double totalFlops = k.flopsPerThread * threads;
  double totalInsts = k.instPerThread * threads;
  s.gpuTotSimInsn = totalInsts;

  double peakFlopsPerSec = g.peakGflopsFp32() * 1e9;
  // Low occupancy cannot hide ALU latency: scale achievable compute
  // throughput by a latency-hiding factor (saturates around 40% occupancy,
  // per the classic Volkov model).
  double latencyHiding = std::min(1.0, s.occ.occupancy / 0.40);
  double computeSec =
      totalFlops / std::max(1.0, peakFlopsPerSec * latencyHiding *
                                     waveUtilization *
                                     (1.0 - 0.5 * k.branchDivergence));

  // ---- memory time ---------------------------------------------------
  double bytesRequested = k.bytesPerThread * threads;
  s.l1HitRate = k.l1HitRate;
  s.l2HitRate = k.l2HitRate;
  double toL2 = bytesRequested * (1.0 - k.l1HitRate);
  double toDram = toL2 * (1.0 - k.l2HitRate);

  double peakBw = g.memBandwidthGBs * 1e9;
  // ~85% of peak DRAM bandwidth is achievable with good coalescing.
  double memSec = toDram / std::max(1.0, peakBw * 0.85 * latencyHiding);

  // Shared-memory bank conflicts serialize accesses.
  if (k.shmemBankConflictRate > 0) {
    double smemAccesses = totalInsts * 0.15;  // share of smem instructions
    double conflictCycles =
        smemAccesses * k.shmemBankConflictRate * (g.smemLatencyCycles * 0.25);
    computeSec += conflictCycles / (g.numSMs * coreHz);
  }

  // ---- latency floor ---------------------------------------------------
  // Even tiny kernels pay launch latency + one memory round trip.
  double launchSec = g.kernelLaunchLatencyCycles / coreHz;
  double latencyFloorSec =
      launchSec + (double)g.dramLatencyCycles / coreHz;

  double execSec = std::max(computeSec, memSec);
  double totalSec = std::max(execSec, latencyFloorSec) + launchSec;

  // ---- classify -------------------------------------------------------
  s.aiFlopPerByte =
      totalFlops / std::max(1.0, toDram);
  if (execSec <= latencyFloorSec * 1.05)
    s.bound = "Latency bound";
  else if (memSec > computeSec * 1.15)
    s.bound = "Memory bound";
  else if (computeSec > memSec * 1.15)
    s.bound = "Compute bound";
  else
    s.bound = "Balanced";

  // ---- derived stats ---------------------------------------------------
  s.durationUs = totalSec * 1e6;
  s.gpuTotSimCycle = totalSec * coreHz;
  s.gpuIpc = s.gpuTotSimInsn /
             std::max(1.0, s.gpuTotSimCycle);  // whole-GPU IPC
  s.achievedOccupancy =
      s.occ.occupancy * waveUtilization * std::min(1.0, s.smEfficiency);
  s.gflops = totalFlops / std::max(1e-9, totalSec) / 1e9;

  // DRAM traffic in 32-byte sectors, accel-sim style.
  double readShare = k.category == "memory" ? 0.7 : 0.6;
  s.dramReads = toDram * readShare / 32.0;
  s.dramWrites = toDram * (1.0 - readShare) / 32.0;
  s.memThroughputGBs = toDram / std::max(1e-9, totalSec) / 1e9;
  s.l2BwGBs = toL2 / std::max(1e-9, totalSec) / 1e9;

  return s;
}

}  // namespace cuvis
