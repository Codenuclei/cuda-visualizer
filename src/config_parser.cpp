// cuvis — parser for GPGPU-Sim / accel-sim `gpgpusim.config` files.
// Reads the same key set the simulator consumes (gpgpu_n_clusters,
// gpgpu_clock_domains, gpgpu_shader_core_pipeline, ...) and derives
// user-facing numbers such as peak memory bandwidth.

#include "cuvis/config_parser.h"

#include <cmath>
#include <fstream>
#include <map>
#include <sstream>

namespace cuvis {

namespace {

// Strip trailing comments and whitespace.
std::string clean(const std::string &s) {
  std::string r = s;
  size_t h = r.find('#');
  if (h != std::string::npos) r = r.substr(0, h);
  size_t a = r.find_first_not_of(" \t\r\n");
  size_t b = r.find_last_not_of(" \t\r\n");
  if (a == std::string::npos) return "";
  return r.substr(a, b - a + 1);
}

// FP32 lanes per SM by compute capability (CUDA C programming guide,
// table "Arithmetic Instructions"; used for peak-GFLOPS estimates).
int fp32LanesForCC(int major, int minor) {
  if (major == 2) return 32;
  if (major == 3) return 192;
  if (major == 5) return 128;
  if (major == 6) return minor == 0 ? 64 : 128;
  if (major == 7) return 64;              // Volta / Turing
  if (major == 8) return minor == 0 ? 64 : 128;  // A100 : Ampere consumer
  if (major == 9) return 128;             // Hopper
  if (major >= 10) return 128;            // Blackwell-class
  return 64;
}

// Friendly names for the accel-sim tested configs.
std::string friendlyName(const std::string &id) {
  static const std::map<std::string, std::string> names = {
      {"SM2_GTX480", "GeForce GTX 480 (Fermi)"},
      {"SM3_KEPLER_TITAN", "GTX TITAN (Kepler)"},
      {"SM6_TITANX", "TITAN X (Pascal)"},
      {"SM7_QV100", "Tesla V100 (Volta)"},
      {"SM7_GV100", "Quadro GV100 (Volta)"},
      {"SM7_TITANV", "TITAN V (Volta)"},
      {"SM75_RTX2060", "GeForce RTX 2060 (Turing)"},
      {"SM75_RTX2060_S", "GeForce RTX 2060 SUPER (Turing)"},
      {"SM80_A100", "NVIDIA A100 (Ampere)"},
      {"SM86_RTX3070", "GeForce RTX 3070 (Ampere)"},
  };
  auto it = names.find(id);
  return it == names.end() ? id : it->second;
}

// Total L2 size from a GPGPU-Sim cache config string
// "S:<nsets>:<bsize>:<assoc>,..." multiplied by number of sub-partitions.
long l2SizeFromCacheString(const std::string &cfg, int subPartitions) {
  // cfg example: S:64:128:16,L:B:m:L:P,A:192:4,32:0,32
  long nsets = 0, bsize = 0, assoc = 0;
  char sector;
  if (std::sscanf(cfg.c_str(), "%c:%ld:%ld:%ld", &sector, &nsets, &bsize,
                  &assoc) == 4) {
    return nsets * bsize * assoc * subPartitions;
  }
  return 0;
}

}  // namespace

bool parseGpgpusimConfig(const std::string &path, const std::string &id,
                         GpuSpec &out) {
  std::ifstream in(path);
  if (!in) return false;

  std::map<std::string, std::string> kv;
  std::string line;
  while (std::getline(in, line)) {
    line = clean(line);
    if (line.empty() || line[0] != '-') continue;
    std::istringstream ss(line);
    std::string key, value;
    ss >> key;
    std::getline(ss, value);
    kv[key.substr(1)] = clean(value);
  }

  auto geti = [&](const char *k, int d = 0) {
    auto it = kv.find(k);
    return it == kv.end() ? d : std::atoi(it->second.c_str());
  };
  auto gets = [&](const char *k) {
    auto it = kv.find(k);
    return it == kv.end() ? std::string() : it->second;
  };

  out.id = id;
  out.name = friendlyName(id);
  out.ccMajor = geti("gpgpu_compute_capability_major", 7);
  out.ccMinor = geti("gpgpu_compute_capability_minor", 0);

  out.numSMs = geti("gpgpu_n_clusters", 1) *
               geti("gpgpu_n_cores_per_cluster", 1);
  out.maxBlocksPerSM = geti("gpgpu_shader_cta", 32);
  out.regsPerSM = geti("gpgpu_shader_registers", 65536);
  out.regsPerBlockLimit = geti("gpgpu_registers_per_block", out.regsPerSM);
  out.shmemPerSM = geti("gpgpu_shmem_size", 98304);
  out.shmemPerBlockLimit = geti("gpgpu_shmem_per_block", 49152);

  // "-gpgpu_shader_core_pipeline 1536:32" = maxThreadsPerSM : warpSize
  {
    std::string v = gets("gpgpu_shader_core_pipeline");
    int a = 2048, b = 32;
    std::sscanf(v.c_str(), "%d:%d", &a, &b);
    out.maxThreadsPerSM = a;
    out.warpSize = b;
  }

  // "-gpgpu_clock_domains core:icnt:l2:dram" in MHz.
  {
    std::string v = gets("gpgpu_clock_domains");
    double c = 0, i = 0, l2 = 0, d = 0;
    std::sscanf(v.c_str(), "%lf:%lf:%lf:%lf", &c, &i, &l2, &d);
    out.coreClockMHz = c;
    out.dramClockMHz = d;
  }

  out.memChannels = geti("gpgpu_n_mem", 8);
  out.dramBusWidthBytes = geti("gpgpu_dram_buswidth", 4);
  out.dramCmdFreqRatio = geti("dram_data_command_freq_ratio", 2);

  // Peak DRAM bandwidth = channels * buswidth * dramClock * dataRate.
  out.memBandwidthGBs = out.memChannels * out.dramBusWidthBytes *
                        out.dramClockMHz * 1e6 * out.dramCmdFreqRatio / 1e9;

  out.l1SizeBytes = (long)geti("gpgpu_unified_l1d_size", 0) * 1024;
  if (out.l1SizeBytes == 0) {
    // Older configs: derive from -gpgpu_cache:dl1.
    out.l1SizeBytes =
        l2SizeFromCacheString(gets("gpgpu_cache:dl1"), 1);
  }
  {
    int subParts = geti("gpgpu_n_mem", 8) *
                   geti("gpgpu_n_sub_partition_per_mchannel", 2);
    out.l2SizeBytes = l2SizeFromCacheString(gets("gpgpu_cache:dl2"), subParts);
  }

  out.l1LatencyCycles = geti("gpgpu_l1_latency", 32);
  out.smemLatencyCycles = geti("gpgpu_smem_latency", 24);
  out.dramLatencyCycles = geti("dram_latency", 100) +
                          geti("gpgpu_l2_rop_latency", 120);
  out.kernelLaunchLatencyCycles = geti("gpgpu_kernel_launch_latency", 5000);

  out.schedulersPerSM = geti("gpgpu_num_sched_per_core", 4);
  out.tensorCores = geti("gpgpu_tensor_core_avail", 0) != 0;
  out.fp32CoresPerSM = fp32LanesForCC(out.ccMajor, out.ccMinor);
  out.maxThreadsPerBlock = out.ccMajor >= 2 ? 1024 : 512;

  return out.numSMs > 0 && out.coreClockMHz > 0;
}

}  // namespace cuvis
