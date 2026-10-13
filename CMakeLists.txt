cmake_minimum_required(VERSION 3.18)
project(cuvis LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(CTest)
include(cmake/CuvisCudaArchitectures.cmake)

# ---- optional CUDA (11.0 .. 13.x) -----------------------------------------
# If nvcc is on PATH (or CUDACXX is set) the kernels compile as real CUDA
# and the binary profiles the physical GPU. Otherwise kernels.cu is built
# as plain C++ and the analytical accel-sim model is used.
include(CheckLanguage)
check_language(CUDA)

if(CMAKE_CUDA_COMPILER)
  # Save user settings before enabling CUDA, which initializes this variable
  # to the compiler's own default when the user did not provide one.
  set(_cuvis_cuda_architectures_explicit FALSE)
  if(DEFINED CMAKE_CUDA_ARCHITECTURES)
    set(_cuvis_cuda_architectures_explicit TRUE)
    set(_cuvis_cuda_architectures_user "${CMAKE_CUDA_ARCHITECTURES}")
  endif()
  if(DEFINED ENV{CUDAARCHS})
    set(_cuvis_cuda_architectures_env "$ENV{CUDAARCHS}")
  endif()

  enable_language(CUDA)
  if(CMAKE_CUDA_COMPILER_VERSION VERSION_LESS 11.0)
    message(FATAL_ERROR "cuvis requires CUDA 11.0+ (found ${CMAKE_CUDA_COMPILER_VERSION})")
  endif()
  message(STATUS "CUDA ${CMAKE_CUDA_COMPILER_VERSION} found — building GPU backend")
  set(CMAKE_CUDA_STANDARD 17)

  cuvis_select_cuda_architectures(
    "${CMAKE_CUDA_COMPILER_ID}"
    "${CMAKE_CUDA_COMPILER_VERSION}"
    "${_cuvis_cuda_architectures_explicit}"
    "${_cuvis_cuda_architectures_user}"
    "${_cuvis_cuda_architectures_env}"
    _cuvis_cuda_architectures
  )
  if(NOT _cuvis_cuda_architectures_explicit
     AND "${_cuvis_cuda_architectures_env}" STREQUAL ""
     AND "${_cuvis_cuda_architectures}" STREQUAL "")
    message(FATAL_ERROR
      "No verified default CUDA architecture list for ${CMAKE_CUDA_COMPILER_ID} "
      "${CMAKE_CUDA_COMPILER_VERSION}. Set CMAKE_CUDA_ARCHITECTURES explicitly.")
  endif()
  set(CMAKE_CUDA_ARCHITECTURES "${_cuvis_cuda_architectures}")
  if(_cuvis_cuda_architectures_explicit)
    message(STATUS "Using explicit CMAKE_CUDA_ARCHITECTURES=${CMAKE_CUDA_ARCHITECTURES}")
  elseif(NOT "${_cuvis_cuda_architectures_env}" STREQUAL "")
    message(STATUS "Using CUDAARCHS=${CMAKE_CUDA_ARCHITECTURES}")
  else()
    message(STATUS "Using verified CUDA ${CMAKE_CUDA_COMPILER_VERSION} architecture targets: ${CMAKE_CUDA_ARCHITECTURES}")
  endif()
  set_source_files_properties(src/kernels.cu PROPERTIES LANGUAGE CUDA)
else()
  message(STATUS "No CUDA toolkit — building analytical (CPU) backend")
  set_source_files_properties(src/kernels.cu PROPERTIES LANGUAGE CXX)
  if(NOT MSVC)
    set_source_files_properties(src/kernels.cu PROPERTIES COMPILE_OPTIONS "-x;c++")
  endif()
endif()

add_executable(cuvis
  src/main.cpp
  src/config_parser.cpp
  src/engine.cpp
  src/trace_reader.cpp
  src/json_export.cpp
  src/kernels.cu
)
target_include_directories(cuvis PRIVATE include)

if(BUILD_TESTING)
  add_test(
    NAME cuda-architecture-selection
    COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/cuda-architectures.cmake"
  )
endif()

if(MSVC)
  target_compile_options(cuvis PRIVATE /W3)
else()
  target_compile_options(cuvis PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra>)
endif()
