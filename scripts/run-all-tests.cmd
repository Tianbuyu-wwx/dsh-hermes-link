@echo off
REM scripts/run-all-tests.cmd
REM Run the full hermes-link v0.2.3 test suite (12 node scripts, 197 checks,
REM plus a Python syntax sanity for the Hermes-side reference implementation).
REM Each node script prints its own "Total: T  Passed: P  Failed: F" line.
REM Exit code = number of scripts that failed.
REM
REM Usage: cmd /c scripts\run-all-tests.cmd   (from the repo root)
REM Or:    cmd /c E:\项目\dsh-hermes\scripts\run-all-tests.cmd

setlocal
set "REPO=%~dp0.."
pushd "%REPO%" >nul

set "FAIL=0"
set "RAN=0"

for %%S in (
  scripts\smoke-test.mjs
  scripts\test-request-dump.mjs
  scripts\test-dispatch-schema.mjs
  scripts\test-consult-client.mjs
  scripts\test-services.mjs
  scripts\test-amend-security.mjs
  scripts\test-consult-security.mjs
  scripts\test-foundation-policy.mjs
  scripts\test-mirror-opt-in.mjs
  scripts\test-v0.2.3-hardening.mjs
  scripts\import-check.mjs
  scripts\verify-install.mjs
) do (
  set /a "RAN+=1"
  echo.
  echo ============================================================
  echo === [%%RAN^/12] %%~nxS
  echo ============================================================
  node "%%S"
  if errorlevel 1 set /a "FAIL+=1"
)

REM Python reference implementation syntax sanity (Hermes-side gateway).
set /a "RAN+=1"
echo.
echo ============================================================
echo === [%%RAN^/13] hermes-gateway-demo.py (python -m py_compile)
echo ============================================================
where python >nul 2>&1
if %ERRORLEVEL% equ 0 (
  python -m py_compile scripts\hermes-gateway-demo.py
  if errorlevel 1 set /a "FAIL+=1"
) else (
  echo (python not on PATH; skipping Hermes-side Python syntax check)
)

popd >nul
echo.
echo ============================================================
echo Ran %%RAN^/13 scripts. Failures: %%FAIL^.
if %%FAIL^ equ 0 (
  echo ALL GREEN.
) else (
  echo !!! %%FAIL^ SCRIPT^(S^) FAILED - re-run individually to inspect.
)
endlocal & exit /b %FAIL%