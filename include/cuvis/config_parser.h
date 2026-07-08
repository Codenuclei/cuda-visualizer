#pragma once
#include <string>
#include "cuvis/model.h"

namespace cuvis {
// Parse an accel-sim / GPGPU-Sim gpgpusim.config file into a GpuSpec.
// `id` is the config directory name, e.g. "SM86_RTX3070".
bool parseGpgpusimConfig(const std::string &path, const std::string &id,
                         GpuSpec &out);
}  // namespace cuvis
