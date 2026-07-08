#pragma once
#include "cuvis/model.h"

namespace cuvis {

// CUDA-occupancy-calculator-accurate occupancy analysis
// (mirrors cudaOccupancyMaxActiveBlocksPerMultiprocessor).
OccupancyInfo computeOccupancy(const GpuSpec &g, const KernelLaunch &k);

// Analytical (roofline + latency) performance model for one kernel launch.
KernelStats simulateKernel(const GpuSpec &g, const KernelLaunch &k);

}  // namespace cuvis
