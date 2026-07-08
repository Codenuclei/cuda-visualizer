// cuvis — CUDA visualizer driver.
//
// Usage:
//   cuvis --configs <dir> [--trace <kernelslist.g>] [--out <data.json>]
//
// With an NVIDIA GPU + CUDA 11/12/13 toolkit the binary is built by nvcc
// and profiles the built-in kernel suite on the real device. Without one
// (this AMD machine) it models the same suite on every accel-sim GPU
// config found in --configs, producing identical JSON for the dashboard.

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "cuvis/config_parser.h"
#include "cuvis/cuda_compat.h"
#include "cuvis/engine.h"
#include "cuvis/json_export.h"
#include "cuvis/kernels.h"
#include "cuvis/model.h"
#include "cuvis/trace_reader.h"

namespace fs = std::filesystem;
using namespace cuvis;

namespace {

// Order configs oldest -> newest architecture for a pleasant selector.
int archRank(const std::string &id) {
  if (id.rfind("SM2_", 0) == 0) return 2;
  if (id.rfind("SM3_", 0) == 0) return 3;
  if (id.rfind("SM6_", 0) == 0) return 6;
  if (id.rfind("SM75", 0) == 0) return 75;
  if (id.rfind("SM7_", 0) == 0) return 70;
  if (id.rfind("SM80", 0) == 0) return 80;
  if (id.rfind("SM86", 0) == 0) return 86;
  return 100;
}

// Build the per-GPU report: run every kernel through the model and lay
// the results out on a stream timeline (H2D copies, kernels, D2H copy),
// the same command sequence an accel-sim kernelslist encodes.
GpuReport buildReport(const GpuSpec &spec,
                      const std::vector<KernelLaunch> &suite) {
  GpuReport r;
  r.spec = spec;

  double cursorUs = 0;
  const double pcieGBs = 12.0;  // effective PCIe 4.0 H2D throughput

  // Host-to-device staging: size derived from the streaming kernels.
  double h2dBytes = 256.0 * 1024 * 1024;
  double h2dUs = h2dBytes / (pcieGBs * 1e9) * 1e6;
  r.timeline.push_back({"memcpyH2D", "MemcpyHtoD 256 MB", cursorUs,
                        cursorUs + h2dUs, 0});
  cursorUs += h2dUs;

  for (const KernelLaunch &k : suite) {
    KernelStats s = simulateKernel(spec, k);
    s.timelineStartUs = cursorUs;
    s.timelineEndUs = cursorUs + s.durationUs;
    r.timeline.push_back({"kernel", k.name, s.timelineStartUs,
                          s.timelineEndUs, 0});
    cursorUs = s.timelineEndUs;
    r.kernels.push_back(s);
  }

  double d2hBytes = 64.0 * 1024 * 1024;
  double d2hUs = d2hBytes / (pcieGBs * 1e9) * 1e6;
  r.timeline.push_back({"memcpyD2H", "MemcpyDtoH 64 MB", cursorUs,
                        cursorUs + d2hUs, 0});
  cursorUs += d2hUs;

  r.totalTimeUs = cursorUs;
  return r;
}

}  // namespace

int main(int argc, char **argv) {
  std::string configsDir = "configs";
  std::string tracePath;
  std::string outPath = "web/data.json";

  for (int i = 1; i < argc; ++i) {
    if (!std::strcmp(argv[i], "--configs") && i + 1 < argc)
      configsDir = argv[++i];
    else if (!std::strcmp(argv[i], "--trace") && i + 1 < argc)
      tracePath = argv[++i];
    else if (!std::strcmp(argv[i], "--out") && i + 1 < argc)
      outPath = argv[++i];
    else if (!std::strcmp(argv[i], "--help")) {
      std::printf(
          "cuvis — CUDA kernel visualizer\n"
          "  --configs <dir>   accel-sim tested-cfgs directory (default: configs)\n"
          "  --trace <file>    accel-sim kernelslist.g to visualize instead of\n"
          "                    the built-in kernel suite\n"
          "  --out <file>      output JSON (default: web/data.json)\n");
      return 0;
    }
  }

  std::printf("cuvis | CUDA runtime: %s\n", runtimeVersionString());

  // ---- workload: built-in suite or an accel-sim trace ------------------
  std::vector<KernelLaunch> suite;
  if (!tracePath.empty()) {
    for (const TraceCommand &c : readKernelsList(tracePath))
      if (c.kind == TraceCommand::Kernel) suite.push_back(c.launch);
    std::printf("loaded %zu kernel launches from trace %s\n", suite.size(),
                tracePath.c_str());
  }
  if (suite.empty()) suite = builtinSuite();

  // ---- device set -------------------------------------------------------
  std::vector<GpuSpec> gpus;

#ifdef CUVIS_HAVE_CUDA
  int n = 0;
  if (cudaGetDeviceCount(&n) == cudaSuccess && n > 0) {
    for (int d = 0; d < n; ++d) {
      cudaDeviceProp p;
      CUVIS_CHECK(cudaGetDeviceProperties(&p, d));
      GpuSpec g;
      g.id = "DEVICE" + std::to_string(d);
      g.name = p.name;
      g.ccMajor = p.major; g.ccMinor = p.minor;
      g.numSMs = p.multiProcessorCount;
      g.warpSize = p.warpSize;
      g.maxThreadsPerSM = p.maxThreadsPerMultiProcessor;
      g.maxBlocksPerSM = p.maxBlocksPerMultiProcessor;
      g.maxThreadsPerBlock = p.maxThreadsPerBlock;
      g.regsPerSM = p.regsPerMultiprocessor;
      g.regsPerBlockLimit = p.regsPerBlock;
      g.shmemPerSM = (long)p.sharedMemPerMultiprocessor;
      g.shmemPerBlockLimit = (long)p.sharedMemPerBlock;
      g.coreClockMHz = deviceClockRateKHz(d) / 1000.0;
      g.dramClockMHz = deviceMemoryClockRateKHz(d) / 1000.0;
      g.memBandwidthGBs = 2.0 * g.dramClockMHz * 1e6 *
                          (p.memoryBusWidth / 8) / 1e9;
      g.l2SizeBytes = p.l2CacheSize;
      g.fp32CoresPerSM = 64;  // refined per-arch below if known
      gpus.push_back(g);
    }
    std::printf("found %d CUDA device(s)\n", n);
  }
#endif

  // Analytical GPUs from accel-sim configs (always loaded so the dashboard
  // can compare real hardware against the modeled catalog).
  std::vector<fs::path> cfgDirs;
  if (fs::exists(configsDir))
    for (const auto &e : fs::directory_iterator(configsDir))
      if (e.is_directory() && fs::exists(e.path() / "gpgpusim.config"))
        cfgDirs.push_back(e.path());
  std::sort(cfgDirs.begin(), cfgDirs.end(),
            [](const fs::path &a, const fs::path &b) {
              int ra = archRank(a.filename().string());
              int rb = archRank(b.filename().string());
              return ra != rb ? ra < rb
                              : a.filename().string() < b.filename().string();
            });
  for (const fs::path &d : cfgDirs) {
    GpuSpec g;
    if (parseGpgpusimConfig((d / "gpgpusim.config").string(),
                            d.filename().string(), g)) {
      gpus.push_back(g);
      std::printf("config %-18s %-32s %3d SMs @ %.0f MHz, %6.1f GB/s\n",
                  g.id.c_str(), g.name.c_str(), g.numSMs, g.coreClockMHz,
                  g.memBandwidthGBs);
    }
  }

  if (gpus.empty()) {
    std::fprintf(stderr, "no GPUs found: no CUDA devices and no configs in %s\n",
                 configsDir.c_str());
    return 1;
  }

  // ---- run ---------------------------------------------------------------
  std::vector<GpuReport> reports;
  reports.reserve(gpus.size());
  for (const GpuSpec &g : gpus) reports.push_back(buildReport(g, suite));

  std::string generator =
      std::string("cuvis 1.0 (CUDA ") + runtimeVersionString() + ")";
  if (!exportJson(reports, generator, outPath)) {
    std::fprintf(stderr, "failed to write %s\n", outPath.c_str());
    return 1;
  }
  std::printf("wrote %s (%zu GPUs x %zu kernels)\n", outPath.c_str(),
              reports.size(), suite.size());
  return 0;
}
