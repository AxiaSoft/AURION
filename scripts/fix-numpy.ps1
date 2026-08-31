# Repair AURION's Python stack on Windows CPUs that do not support x86-64-v2.
# Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File D:\aurion\scripts\fix-numpy.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "AURION: removing NumPy 2.x (X86_V2) and reinstalling a compatible stack..."

python -m pip uninstall -y numpy pandas scipy scikit-learn 2>$null

python -m pip install --no-cache-dir --force-reinstall `
  "numpy==1.26.4" `
  "pandas==2.2.3" `
  "scipy==1.14.1" `
  "scikit-learn==1.5.2" `
  "joblib==1.4.2"

python -m pip install -r engine\requirements.txt
python -m pip install "MetaTrader5>=5.0.4874"

Write-Host ""
Write-Host "Verifying NumPy..."
python -c "import numpy; print('numpy', numpy.__version__, 'OK')"
python -c "import pandas, sklearn, scipy; print('pandas/sklearn/scipy OK')"

Write-Host ""
Write-Host "Done. Start the engine with:"
Write-Host "  python engine\main.py --host 127.0.0.1 --port 18765"
