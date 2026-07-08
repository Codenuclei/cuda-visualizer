#pragma once
#include <string>
#include <vector>
#include "cuvis/model.h"

namespace cuvis {
bool exportJson(const std::vector<GpuReport> &reports,
                const std::string &generator, const std::string &outPath);
}  // namespace cuvis
