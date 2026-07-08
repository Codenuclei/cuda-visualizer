cmake_minimum_required(VERSION 3.18)
project(cuvis LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- optional CUDA (11.0 .. 13.x) -----------------------------------------
# If nvcc is on PATH (or CUDACXX is set) the kernels compile as real CUDA
# and the binary profiles the physical GPU. Otherwise kernels.cu is built
# as plain C++ and the analytical accel-sim model is used.
include(CheckLanguage)
check_language(CUDA)

if(CMAKE_CUDA_COMPILER)
  enable_language(CUDA)
  if(CMAKE_CUDA_COMPILER_VERSION VERSION_LESS 11.0)
    message(FATAL_ERROR "cuvis requires CUDA 11.0+ (found ${CMAKE_CUDA_COMPILER_VERSION})")
  endif()
  message(STATUS "CUDA ${CMAKE_CUDA_COMPILER_VERSION} found — building GPU backend")
  set(CMAKE_CUDA_STANDARD 17)

  # Architectures per toolkit generation:
  #   CUDA 11.x : Pascal .. Ampere        (60;70;75;80;86)
  #   CUDA 12.x : + Ada, Hopper           (60;70;75;80;86;89;90)
  #   CUDA 13.x : Turing+ only, + Blackwell (75;80;86;89;90;100;120)
  if(CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 13.0)
    set(CMAKE_CUDA_ARCHITECTURES 75 80 86 89 90 100 120)
  elseif(CMAKE_CUDA_COMPILER_VERSION VERSION_GREATER_EQUAL 12.0)
    set(CMAKE_CUDA_ARCHITECTURES 60 70 75 80 86 89 90)
  else()
    set(CMAKE_CUDA_ARCHITECTURES 60 70 75 80 86)
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

if(MSVC)
  target_compile_options(cuvis PRIVATE /W3)
else()
  target_compile_options(cuvis PRIVATE $<$<COMPILE_LANGUAGE:CXX>:-Wall -Wextra>)
endif()
