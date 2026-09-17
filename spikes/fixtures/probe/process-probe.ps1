# Spike I probe: the transport shape the guard plans to use (spec 7.2). It is read-only: it lists
# processes, reads their CPU time and reports main-window flags.
#
# The caller prepends two single-line assignments before piping this text on stdin:
#   $ocuMarker = '<string that must appear in the command line>'; $ocuSampleMs = <integer>
#
# Output is exactly one JSON line:
#   { schema, probePid, sampleMs, elapsedMs, processes: [ { pid, parentPid, name, hasWindow,
#     matched, firstSeconds, secondSeconds } ] }
# The command line itself is never printed: the spike only needs to know that the field was readable.
& {
  $ErrorActionPreference = 'Stop'
  try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

    $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine)
    $candidates = @(foreach ($item in $all) {
      if ([string]$item.CommandLine -like "*$ocuMarker*" -and [int]$item.ProcessId -ne $PID) { $item }
    })

    $windows = @{}
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
      try { if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windows[[int]$process.Id] = $true } } catch { }
    }

    $readCpu = {
      $readings = @{}
      foreach ($item in $candidates) {
        $id = [int]$item.ProcessId
        try { $readings[$id] = [Diagnostics.Process]::GetProcessById($id).TotalProcessorTime.TotalSeconds }
        catch { $readings[$id] = $null }
      }
      return $readings
    }

    $watch = [Diagnostics.Stopwatch]::StartNew()
    $first = & $readCpu
    Start-Sleep -Milliseconds ([int]$ocuSampleMs)
    $startedSecond = $watch.Elapsed.TotalMilliseconds
    $second = & $readCpu
    $elapsedMs = ($startedSecond + $watch.Elapsed.TotalMilliseconds) / 2

    $list = @(foreach ($item in $candidates) {
      $id = [int]$item.ProcessId
      [ordered]@{
        pid = $id
        parentPid = [int]$item.ParentProcessId
        name = [string]$item.Name
        hasWindow = $windows.ContainsKey($id)
        commandLineReadable = -not [string]::IsNullOrEmpty([string]$item.CommandLine)
        firstSeconds = $first[$id]
        secondSeconds = $second[$id]
      }
    })

    $result = [ordered]@{
      schema = 1
      probePid = [int]$PID
      sampleMs = [int]$ocuSampleMs
      elapsedMs = $elapsedMs
      processes = $list
    }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 5 -InputObject $result))
  }
  catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ schema = 1; error = [string]$_.Exception.Message })))
    exit 1
  }
}
