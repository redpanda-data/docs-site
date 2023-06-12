@echo off

rem Get the latest Redpanda Console version
set CONSOLE_VERSION=node start-scripts\getLatestConsoleVersion.js

for /f %%i in ('%CONSOLE_VERSION%') do set CONSOLE_VERSION=%%i

rem Set the latest-console-version attribute
if not "%CONSOLE_VERSION%"=="" (
  set attribute=--attribute latest-console-version=%CONSOLE_VERSION%
) else (
  set attribute=
)

rem Build the site
antora --to-dir docs %attribute% --fetch antora-playbook.yml
