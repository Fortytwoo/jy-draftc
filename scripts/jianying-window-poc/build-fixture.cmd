@echo off
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "POC_VS=%%i"
call "%POC_VS%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
pushd "%~dp0\..\.."
if not exist build\jianying-window-poc\fixture mkdir build\jianying-window-poc\fixture
cl /nologo /std:c++20 /utf-8 /EHsc /W4 /O2 /MT /D_WIN32_WINNT=0x0A00 /Fo:build\jianying-window-poc\fixture\fixture.obj /Fe:build\jianying-window-poc\fixture\JianyingPro.exe scripts\jianying-window-poc\native-fixture.cpp /link user32.lib
set "POC_RC=%ERRORLEVEL%"
popd
exit /b %POC_RC%
