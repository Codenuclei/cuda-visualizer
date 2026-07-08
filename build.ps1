# cuvis build script (Windows).
# Uses nvcc when available (CUDA 11-13), otherwise g++ for the
# analytical backend. Run from the repo root:  .\build.ps1
$ErrorActionPreference = "Stop"

$src = "src/main.cpp", "src/config_parser.cpp", "src/engine.cpp",
       "src/trace_reader.cpp", "src/json_export.cpp"

if (Get-Command nvcc -ErrorAction SilentlyContinue) {
    Write-Host "nvcc found - building GPU backend"
    nvcc -std=c++17 -Iinclude -O2 $src src/kernels.cu -o build/cuvis.exe
} else {
    Write-Host "no nvcc - building analytical backend with g++"
    g++ -std=c++17 -Iinclude -O2 -Wall $src -x c++ src/kernels.cu -o build/cuvis.exe
}
Write-Host "built build/cuvis.exe"
