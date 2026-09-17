# opencode-unity GPU guard: Unity process probe for Windows (spec section 7.2). Read-only: it lists
# processes and reads their CPU time; it never starts, stops or changes anything.
#
# processes-win32.js pipes this text to `powershell.exe -NoProfile -NonInteractive -Command -`. It
# removes blank and comment-only lines, prepends these single-line assignments and ends the text
# with a blank line, without which PowerShell reads the block but never runs it:
#   $ocuSampleMs = <integer>; $ocuSampleCpu = $true | $false; $ocuPatterns = @(<base64 UTF-8>, ...)
# Everything below is one script block that prints exactly one JSON line. On any failure it prints
# {"schema":1,"error":"..."} and exits 1.
#
# Output: { schema, probePid, ancestors, sampleMs, elapsedMs, processes: [ { pid, parentPid, name,
# commandLine, hasWindow, first, second } ] }. commandLine is null when Windows does not expose it.
# first and second are CPU readings { state: ok | exited | error, seconds, startMs, error } taken
# $ocuSampleMs apart, or null when CPU time is not sampled.
& {
  $ErrorActionPreference = 'Stop'
  try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $all = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, CreationDate)
    $byId = @{}
    foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }
    # The probe's own parent chain (the guard's process tree) may name an import log in its command
    # lines; the caller skips it. A parent created after its child is an unrelated process that
    # reused the pid, so the walk stops there.
    $ancestors = [Collections.Generic.List[int]]::new()
    $current = $byId[[int]$PID]
    while ($null -ne $current -and $ancestors.Count -lt 64) {
      $parentId = [int]$current.ParentProcessId
      $parent = $byId[$parentId]
      if ($null -eq $parent -or $parentId -eq [int]$current.ProcessId -or $ancestors.Contains($parentId)) { break }
      if ($null -ne $parent.CreationDate -and $null -ne $current.CreationDate -and $parent.CreationDate -gt $current.CreationDate) { break }
      $ancestors.Add($parentId)
      $current = $parent
    }
    # Patterns match anywhere in the name or command line, case-insensitively; * and ? are wildcards.
    $regexes = @(foreach ($encoded in @($ocuPatterns)) {
      $pattern = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]$encoded))
      $expression = [regex]::Escape($pattern).Replace('\*', '.*').Replace('\?', '.')
      [regex]::new($expression, [Text.RegularExpressions.RegexOptions]'IgnoreCase, CultureInvariant')
    })
    $candidates = @(foreach ($item in $all) {
      $id = [int]$item.ProcessId
      if ($id -eq $PID) { continue }
      $name = [string]$item.Name
      $commandLine = [string]$item.CommandLine
      $baseName = if ($name -match '\.exe$') { $name.Substring(0, $name.Length - 4) } else { $name }
      $matched = ($baseName -eq 'Unity') -or ($baseName -eq 'UnityShaderCompiler')
      if (-not $matched) {
        foreach ($regex in $regexes) {
          if ($regex.IsMatch($name) -or $regex.IsMatch($commandLine)) { $matched = $true; break }
        }
      }
      if ($matched) { $item }
    })
    $windows = @{}
    foreach ($process in @(Get-Process -Name Unity -ErrorAction SilentlyContinue)) {
      try { if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $windows[[int]$process.Id] = $true } } catch { }
    }
    $readCpu = {
      $readings = @{}
      foreach ($item in $candidates) {
        $id = [int]$item.ProcessId
        $reading = [ordered]@{ state = 'ok'; seconds = $null; startMs = $null; error = $null }
        $process = $null
        try { $process = [Diagnostics.Process]::GetProcessById($id) } catch { $reading.state = 'exited' }
        if ($null -ne $process) {
          try {
            $reading.seconds = $process.TotalProcessorTime.TotalSeconds
            $reading.startMs = [DateTimeOffset]::new($process.StartTime).ToUnixTimeMilliseconds()
          }
          catch {
            $gone = $false
            try { $gone = $process.HasExited } catch { }
            if ($gone) { $reading.state = 'exited'; $reading.seconds = $null } else { $reading.state = 'error'; $reading.seconds = $null; $reading.error = [string]$_.Exception.Message }
          }
          finally { $process.Dispose() }
        }
        $readings[$id] = $reading
      }
      return $readings
    }
    $first = @{}
    $second = @{}
    $elapsedMs = $null
    if ($ocuSampleCpu -and $candidates.Count -gt 0) {
      # The window is measured between the midpoints of the two reading passes.
      $watch = [Diagnostics.Stopwatch]::StartNew()
      $first = & $readCpu
      $firstMidMs = $watch.Elapsed.TotalMilliseconds / 2
      Start-Sleep -Milliseconds ([int]$ocuSampleMs)
      $secondStartMs = $watch.Elapsed.TotalMilliseconds
      $second = & $readCpu
      $elapsedMs = ($secondStartMs + $watch.Elapsed.TotalMilliseconds) / 2 - $firstMidMs
    }
    $list = @(foreach ($item in $candidates) {
      $id = [int]$item.ProcessId
      [ordered]@{
        pid = $id
        parentPid = [int]$item.ParentProcessId
        name = [string]$item.Name
        commandLine = $item.CommandLine
        hasWindow = $windows.ContainsKey($id)
        first = $first[$id]
        second = $second[$id]
      }
    })
    $result = [ordered]@{
      schema = 1
      probePid = [int]$PID
      ancestors = @($ancestors)
      sampleMs = [int]$ocuSampleMs
      elapsedMs = $elapsedMs
      processes = $list
    }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 6 -InputObject $result))
  }
  catch {
    $failure = [ordered]@{ schema = 1; error = [string]$_.Exception.Message }
    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject $failure))
    exit 1
  }
}
