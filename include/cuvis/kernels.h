#pragma once
#include <vector>
#include "cuvis/model.h"

namespace cuvis {
// The built-in benchmark suite (8 kernels: vecAdd, saxpy, sgemmTiled,
// stencil2d, reduceSum, histogram256, transposeShared, streamCopy).
std::vector<KernelLaunch> builtinSuite();
}  // namespace cuvis
