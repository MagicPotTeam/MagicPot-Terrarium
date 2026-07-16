@echo off
chcp 65001 >nul
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
set PYTHONUNBUFFERED=1
set TQDM_DISABLE=True
.\python_embeded\python.exe -s ComfyUI\main.py --cpu --windows-standalone-build
pause
