// cuvis — JSON exporter. Writes the dashboard payload consumed by
// web/index.html (window.CUVIS_DATA when embedded, or fetch()ed).

#include "cuvis/json_export.h"

#include <cmath>
#include <fstream>
#include <sstream>

namespace cuvis {

namespace {

std::string esc(const std::string &s) {
  std::string r;
  for (char c : s) {
    if (c == '"' || c == '\\') { r += '\\'; r += c; }
    else if (c == '\n') r += "\\n";
    else r += c;
  }
  return r;
}

std::string num(double v) {
  if (!std::isfinite(v)) return "0";
  std::ostringstream ss;
  ss.precision(6);
  ss << v;
  return ss.str();
}

void writeSpec(std::ostream &o, const GpuSpec &g) {
  o << "{\"id\":\"" << esc(g.id) << "\",\"name\":\"" << esc(g.name)
    << "\",\"cc\":\"" << g.ccMajor << "." << g.ccMinor << "\""
    << ",\"numSMs\":" << g.numSMs
    << ",\"warpSize\":" << g.warpSize
    << ",\"maxThreadsPerSM\":" << g.maxThreadsPerSM
    << ",\"maxBlocksPerSM\":" << g.maxBlocksPerSM
    << ",\"maxWarpsPerSM\":" << g.maxWarpsPerSM()
    << ",\"regsPerSM\":" << g.regsPerSM
    << ",\"shmemPerSM\":" << g.shmemPerSM
    << ",\"coreClockMHz\":" << num(g.coreClockMHz)
    << ",\"dramClockMHz\":" << num(g.dramClockMHz)
    << ",\"memChannels\":" << g.memChannels
    << ",\"memBandwidthGBs\":" << num(g.memBandwidthGBs)
    << ",\"l1SizeKB\":" << num(g.l1SizeBytes / 1024.0)
    << ",\"l2SizeMB\":" << num(g.l2SizeBytes / 1048576.0)
    << ",\"l1Latency\":" << g.l1LatencyCycles
    << ",\"smemLatency\":" << g.smemLatencyCycles
    << ",\"dramLatency\":" << g.dramLatencyCycles
    << ",\"schedulersPerSM\":" << g.schedulersPerSM
    << ",\"tensorCores\":" << (g.tensorCores ? "true" : "false")
    << ",\"peakGflopsFp32\":" << num(g.peakGflopsFp32())
    << ",\"fp32CoresPerSM\":" << g.fp32CoresPerSM
    << "}";
}

void writeKernel(std::ostream &o, const KernelStats &s) {
  const KernelLaunch &k = s.launch;
  o << "{\"name\":\"" << esc(k.name) << "\",\"mangled\":\"" << esc(k.mangled)
    << "\",\"category\":\"" << esc(k.category) << "\""
    << ",\"grid\":[" << k.gridX << "," << k.gridY << "," << k.gridZ << "]"
    << ",\"block\":[" << k.blockX << "," << k.blockY << "," << k.blockZ << "]"
    << ",\"regsPerThread\":" << k.regsPerThread
    << ",\"shmemPerBlock\":" << k.staticShmem
    << ",\"threads\":" << k.threadsTotal()
    << ",\"blocks\":" << k.blocksTotal()
    << ",\"occupancy\":{"
    <<   "\"theoretical\":" << num(s.occ.occupancy)
    <<   ",\"achieved\":" << num(s.achievedOccupancy)
    <<   ",\"activeBlocksPerSM\":" << s.occ.activeBlocksPerSM
    <<   ",\"activeWarpsPerSM\":" << s.occ.activeWarpsPerSM
    <<   ",\"limiter\":\"" << esc(s.occ.limiter) << "\""
    <<   ",\"limits\":{\"warps\":" << s.occ.limitWarps
    <<     ",\"blocks\":" << s.occ.limitBlocks
    <<     ",\"registers\":" << s.occ.limitRegs
    <<     ",\"sharedmem\":" << s.occ.limitShmem << "}"
    << "}"
    << ",\"durationUs\":" << num(s.durationUs)
    << ",\"cycles\":" << num(s.gpuTotSimCycle)
    << ",\"instructions\":" << num(s.gpuTotSimInsn)
    << ",\"ipc\":" << num(s.gpuIpc)
    << ",\"gflops\":" << num(s.gflops)
    << ",\"dramReads\":" << num(s.dramReads)
    << ",\"dramWrites\":" << num(s.dramWrites)
    << ",\"l1HitRate\":" << num(s.l1HitRate)
    << ",\"l2HitRate\":" << num(s.l2HitRate)
    << ",\"l2BwGBs\":" << num(s.l2BwGBs)
    << ",\"memThroughputGBs\":" << num(s.memThroughputGBs)
    << ",\"smEfficiency\":" << num(s.smEfficiency)
    << ",\"waves\":" << num(s.waves)
    << ",\"arithmeticIntensity\":" << num(s.aiFlopPerByte)
    << ",\"bound\":\"" << esc(s.bound) << "\""
    << ",\"start\":" << num(s.timelineStartUs)
    << ",\"end\":" << num(s.timelineEndUs)
    << "}";
}

}  // namespace

namespace {
void writePayload(std::ostream &o, const std::vector<GpuReport> &reports,
                  const std::string &generator);
}

bool exportJson(const std::vector<GpuReport> &reports,
                const std::string &generator, const std::string &outPath) {
  {
    std::ofstream o(outPath);
    if (!o) return false;
    writePayload(o, reports, generator);
  }
  // Sibling data.js so the dashboard also works when opened via file://
  // (where fetch() of local JSON is blocked by the browser).
  std::string jsPath = outPath;
  size_t dot = jsPath.find_last_of('.');
  if (dot != std::string::npos) jsPath = jsPath.substr(0, dot);
  jsPath += ".js";
  std::ofstream j(jsPath);
  if (j) {
    j << "window.CUVIS_DATA = ";
    writePayload(j, reports, generator);
    j << ";\n";
  }
  return true;
}

namespace {
void writePayload(std::ostream &o, const std::vector<GpuReport> &reports,
                  const std::string &generator) {
  o << "{\"generator\":\"" << esc(generator) << "\",\"gpus\":[";
  for (size_t gi = 0; gi < reports.size(); ++gi) {
    const GpuReport &r = reports[gi];
    if (gi) o << ",";
    o << "{\"spec\":";
    writeSpec(o, r.spec);
    o << ",\"totalTimeUs\":" << num(r.totalTimeUs) << ",\"kernels\":[";
    for (size_t ki = 0; ki < r.kernels.size(); ++ki) {
      if (ki) o << ",";
      writeKernel(o, r.kernels[ki]);
    }
    o << "],\"timeline\":[";
    for (size_t ti = 0; ti < r.timeline.size(); ++ti) {
      const TimelineEvent &e = r.timeline[ti];
      if (ti) o << ",";
      o << "{\"kind\":\"" << esc(e.kind) << "\",\"label\":\"" << esc(e.label)
        << "\",\"start\":" << num(e.startUs) << ",\"end\":" << num(e.endUs)
        << ",\"lane\":" << e.lane << "}";
    }
    o << "]}";
  }
  o << "]}";
}
}  // namespace

}  // namespace cuvis
