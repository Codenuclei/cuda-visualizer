// cuvis — reader for accel-sim NVBit trace output.
//
// Understands the on-disk format produced by util/tracer_nvbit and
// consumed by gpu-simulator/trace-parser/trace_parser.cc:
//
//   kernelslist(.g)          one command per line:
//                              kernel-<id>[-ctx_0x...].trace[g][.xz]
//                              MemcpyHtoD,0x<addr>,<bytes>
//                              MemcpyDtoH,0x<addr>,<bytes>
//   kernel-N.trace(.g)       header lines:
//                              -kernel name = <mangled>
//                              -grid dim = (X,Y,Z)
//                              -block dim = (X,Y,Z)
//                              -shmem = <bytes>
//                              -nregs = <int>
//                              -cuda stream id = <uint64>
//
// From the header alone we can characterize the launch and hand it to the
// analytical model, so real accel-sim traces visualize without a GPU.

#include "cuvis/trace_reader.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

namespace cuvis {

namespace {

std::string dirOf(const std::string &p) {
  size_t s = p.find_last_of("/\\");
  return s == std::string::npos ? std::string(".") : p.substr(0, s);
}

std::string trim(const std::string &s) {
  size_t a = s.find_first_not_of(" \t\r\n");
  size_t b = s.find_last_not_of(" \t\r\n");
  return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

// Demangle just enough for display: _Z6vecAddPKfS0_Pfi -> vecAdd.
std::string prettyName(const std::string &mangled) {
  if (mangled.rfind("_Z", 0) != 0) return mangled;
  size_t i = 2;
  int len = 0;
  while (i < mangled.size() && isdigit((unsigned char)mangled[i])) {
    len = len * 10 + (mangled[i] - '0');
    ++i;
  }
  if (len > 0 && i + len <= mangled.size()) return mangled.substr(i, len);
  return mangled;
}

}  // namespace

bool parseTraceKernelHeader(const std::string &path, KernelLaunch &k) {
  std::ifstream in(path);
  if (!in) return false;
  std::string line;
  bool sawName = false;
  while (std::getline(in, line)) {
    line = trim(line);
    if (line.empty()) continue;
    if (line[0] != '-') {
      if (sawName) break;  // header ends at first non "-key = value" line
      continue;
    }
    size_t eq = line.find('=');
    if (eq == std::string::npos) continue;
    std::string key = trim(line.substr(1, eq - 1));
    std::string val = trim(line.substr(eq + 1));

    if (key == "kernel name") {
      k.mangled = val;
      k.name = prettyName(val);
      sawName = true;
    } else if (key == "grid dim") {
      std::sscanf(val.c_str(), "(%u,%u,%u)", &k.gridX, &k.gridY, &k.gridZ);
    } else if (key == "block dim") {
      std::sscanf(val.c_str(), "(%u,%u,%u)", &k.blockX, &k.blockY, &k.blockZ);
    } else if (key == "shmem") {
      k.staticShmem = (unsigned)std::atoi(val.c_str());
    } else if (key == "nregs") {
      k.regsPerThread = (unsigned)std::atoi(val.c_str());
    } else if (key == "cuda stream id") {
      k.streamId = std::strtoull(val.c_str(), nullptr, 10);
    }
  }
  if (!sawName) return false;

  // Traces carry no workload characterization; assume a balanced profile
  // scaled to something plausible so the model has inputs.
  k.flopsPerThread = 24;
  k.bytesPerThread = 32;
  k.instPerThread = 64;
  k.l1HitRate = 0.35;
  k.l2HitRate = 0.40;
  k.category = "mixed";
  return true;
}

std::vector<TraceCommand> readKernelsList(const std::string &listPath) {
  std::vector<TraceCommand> cmds;
  std::ifstream in(listPath);
  if (!in) return cmds;
  const std::string base = dirOf(listPath);
  std::string line;
  while (std::getline(in, line)) {
    line = trim(line);
    if (line.empty() || line[0] == '#') continue;
    TraceCommand c;
    if (line.rfind("kernel", 0) == 0) {
      c.kind = TraceCommand::Kernel;
      c.path = base + "/" + line;
      if (!parseTraceKernelHeader(c.path, c.launch)) continue;
    } else if (line.rfind("Memcpy", 0) == 0) {
      c.kind = line.rfind("MemcpyHtoD", 0) == 0 ? TraceCommand::MemcpyH2D
                                                : TraceCommand::MemcpyD2H;
      // MemcpyHtoD,0x7f...,4194304
      size_t last = line.find_last_of(',');
      if (last != std::string::npos)
        c.bytes = std::strtoull(line.c_str() + last + 1, nullptr, 10);
    } else {
      continue;
    }
    cmds.push_back(c);
  }
  return cmds;
}

}  // namespace cuvis
