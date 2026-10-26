@echo off
setlocal
pushd "%~dp0..\cherry-studio"
if not exist "out\main\main.js" (
  echo Build the desktop first. See desktop\README.md.
  popd
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
set "CS_DEV_PROFILE_ROOT=%LOCALAPPDATA%\YoyokingStudioDev"
node node_modules\electron\cli.js .
set "YOYOKING_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %YOYOKING_EXIT_CODE%
