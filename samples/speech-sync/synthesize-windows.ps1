param(
    [string] $OutputDirectory = (Join-Path $PSScriptRoot 'generated/windows-heami'),
    [ValidateRange(-10, 10)]
    [int] $Rate = 0
)

# Run with Windows PowerShell 5.1 and ffprobe on PATH.
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw "Choose a new output directory: $target" }
$probe = (Get-Command ffprobe.exe).Source
Add-Type -AssemblyName System.Speech

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$eventId = 'heami-bookmarks-' + [Guid]::NewGuid().ToString('N')
$ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">백에서 이십 퍼센트 <mark name="rise-start"/>오르면, <mark name="rise-end"/>백이십.</speak>'
$marks = @{}
$staging = $target + '.' + [Guid]::NewGuid().ToString('N')
[IO.Directory]::CreateDirectory($staging) | Out-Null
try {
    $synth.SelectVoice('Microsoft Heami Desktop')
    $synth.Rate = $Rate
    $voice = $synth.Voice.Name
    $wav = Join-Path $staging 'narration.wav'
    # Heami's bookmark clock matches the output WAV at 16 kHz on this host.
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    Register-ObjectEvent $synth BookmarkReached -SourceIdentifier $eventId
    Register-ObjectEvent $synth SpeakProgress -SourceIdentifier "$eventId-words"
    $synth.SetOutputToWaveFile($wav, $format)
    $synth.SpeakSsml($ssml)
    $synth.SetOutputToNull()
    foreach ($record in @(Get-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue)) {
        $mark = $record.SourceEventArgs
        $marks.Add($mark.Bookmark, $mark.AudioPosition.TotalSeconds)
    }
    $length = & $probe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $wav
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect synthesized WAV.' }
    $duration = [double]::Parse($length, [Globalization.CultureInfo]::InvariantCulture)
    if ($marks.Count -ne 2 -or !$marks.ContainsKey('rise-start') -or !$marks.ContainsKey('rise-end') -or
        $marks['rise-start'] -lt 0 -or $marks['rise-start'] -ge $marks['rise-end'] -or
        $marks['rise-end'] -gt $duration) { throw 'Expected two ordered bookmarks within the WAV.' }
    $words = @(Get-Event -SourceIdentifier "$eventId-words" | ForEach-Object { $_.SourceEventArgs })
    $wordStarts = [ordered]@{}
    foreach ($id in @('rise-start','rise-end')) {
        $expectedWord = if ($id -eq 'rise-start') { '오르면' } else { '백이십' }
        $limit = if ($id -eq 'rise-start') { $marks['rise-end'] } else { $duration }
        $match = $words | Where-Object {
            $_.Text -eq $expectedWord -and $_.AudioPosition.TotalSeconds -ge $marks[$id] -and
            $_.AudioPosition.TotalSeconds -lt $limit
        } | Select-Object -First 1
        if (!$match) { throw "Missing '$expectedWord' word onset for '$id'." }
        $wordStarts[$id] = $match.AudioPosition.TotalSeconds
    }
    $timing = [ordered]@{
        text = '백에서 이십 퍼센트 오르면, 백이십.'
        voice = $voice
        rate = $synth.Rate
        marks = [ordered]@{ 'rise-start' = $marks['rise-start']; 'rise-end' = $marks['rise-end'] }
        wordStarts = $wordStarts
        startSeconds = $wordStarts['rise-start']
        endSeconds = $wordStarts['rise-end']
        durationSeconds = $duration
        audioSha256 = (Get-FileHash -LiteralPath $wav -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $json = $timing | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $staging 'timing.json'), $json)
    [IO.Directory]::Move($staging, $target)
    Write-Output $json
} finally {
    Unregister-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier "$eventId-words" -ErrorAction SilentlyContinue
    Remove-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue
    Remove-Event -SourceIdentifier "$eventId-words" -ErrorAction SilentlyContinue
    $synth.Dispose()
    if (Test-Path -LiteralPath $staging) {
        foreach ($name in @('narration.wav','timing.json')) {
            [IO.File]::Delete((Join-Path $staging $name))
        }
        [IO.Directory]::Delete($staging)
    }
}
