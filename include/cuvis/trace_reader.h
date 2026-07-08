#pragma once
#include <string>
#include <vector>
#include "cuvis/model.h"

namespace cuvis {

// One command from an accel-sim kernelslist(.g) file.
struct TraceCommand {
  enum Kind { Kernel, MemcpyH2D, MemcpyD2H } kind = Kernel;
  std::string path;              // kernel trace file (Kind::Kernel)
  KernelLaunch launch;           // parsed header (Kind::Kernel)
  unsigned long long bytes = 0;  // memcpy size (Kind::Memcpy*)
};

// Parse the header block of a kernel-N.trace / .traceg file.
bool parseTraceKernelHeader(const std::string &path, KernelLaunch &k);

// Parse a kernelslist / kernelslist.g command stream.
std::vector<TraceCommand> readKernelsList(const std::string &listPath);

}  // namespace cuvis
