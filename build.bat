@echo off
rem jy-draftc build (MSVC x64).
rem /MT is mandatory: videoeditor.dll is built against the CRT shipped next to it
rem (msvcp140 14.29 / vcruntime140 14.29). A /MD exe drags System32's newer CRT into
rem the process, the engine reuses it, its lazy statics break, and Logger::getLogger
rem returns garbage - setAlogFunction then writes into the read-only .text page.
setlocal
pushd "%~dp0"

rem Define VS_ROOT to point at your Visual Studio directory; otherwise vswhere locates it.
if exist "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" goto have_vs
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto no_vs
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VS_ROOT=%%i"
if not exist "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" goto no_vs

:have_vs
call "%VS_ROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 goto no_vs

set "SRC=src\11.6.0.14552"
if not exist build mkdir build

cl /nologo /std:c++20 /O2 /Oi /GL /Gy /Gw /GR- /MT /EHsc /GS /guard:cf /DNDEBUG /utf-8 /W4 /permissive- ^
   /Fo:build\ /Fe:build\jy-draftc.exe ^
   "%SRC%\main.cpp" "%SRC%\draft_crypto.cpp" "%SRC%\video_export.cpp" "%SRC%\draft_convert.cpp" ^
   "%SRC%\batch.cpp" ^
   /link /LTCG /INCREMENTAL:NO /SUBSYSTEM:CONSOLE /OPT:REF /OPT:ICF /DYNAMICBASE /HIGHENTROPYVA ^
   /NXCOMPAT /guard:cf bcrypt.lib

set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto failed
echo [build] build\jy-draftc.exe ok
popd
exit /b 0

:no_vs
echo [build] vcvars64.bat not found; set VS_ROOT to your Visual Studio directory.
popd
exit /b 1

:failed
echo [build] compile failed with code %RC%
popd
exit /b %RC%
