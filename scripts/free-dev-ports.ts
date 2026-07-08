import { execFileSync } from 'node:child_process'

const ports = [5174, 5175]
const cwd = process.cwd().toLowerCase()

if (process.env.SKIP_FREE_DEV_PORTS === '1') {
  process.exit(0)
}

if (process.platform === 'win32') {
  const powerShell = `
    $ports = @(${ports.join(',')})
    $cwd = '${cwd.replace(/'/g, "''")}'
    $connections = Get-NetTCPConnection -LocalPort $ports -State Listen -ErrorAction SilentlyContinue
    foreach ($connection in $connections) {
      $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($connection.OwningProcess)" -ErrorAction SilentlyContinue
      if ($process -and $process.CommandLine -and $process.CommandLine.ToLower().Contains($cwd)) {
        Write-Host "Stopping stale sourceBudgeting dev process $($process.ProcessId) on port $($connection.LocalPort)"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
      }
    }
    $staleProcesses = Get-CimInstance Win32_Process -Filter "name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
      $_.CommandLine -and
      $_.CommandLine.ToLower().Contains($cwd) -and
      (
        $_.CommandLine.Contains('concurrently') -or
        $_.CommandLine.Contains('vite') -or
        $_.CommandLine.Contains('server/index.ts')
      )
    }
    foreach ($process in $staleProcesses) {
      Write-Host "Stopping stale sourceBudgeting dev process $($process.ProcessId)"
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
  `

  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powerShell], {
    stdio: 'inherit',
  })
} else {
  for (const port of ports) {
    try {
      execFileSync('sh', ['-c', `lsof -ti tcp:${port} | xargs -r ps -o pid= -o command= -p | grep "${cwd}" | awk '{print $1}' | xargs -r kill`], {
        stdio: 'inherit',
      })
    } catch {
      // Best effort only; Vite/Express will still report the occupied port if cleanup fails.
    }
  }
}
