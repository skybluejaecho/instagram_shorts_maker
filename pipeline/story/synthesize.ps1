param(
    [Parameter(Mandatory = $true)] [string] $EpisodePath,
    [Parameter(Mandatory = $true)] [string] $OutputDirectory,
    [ValidateRange(-10, 10)] [int] $Rate = 2,
    [string] $Voice = 'Microsoft Heami Desktop'
)

$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw "Choose a new output directory: $target" }
$episode = Get-Content -Raw -Encoding UTF8 -LiteralPath $EpisodePath | ConvertFrom-Json
if (!$PSBoundParameters.ContainsKey('Rate') -and $null -ne $episode.rate) {
    $requestedRate = [double]$episode.rate
    if ([double]::IsNaN($requestedRate) -or [double]::IsInfinity($requestedRate) -or
        $requestedRate -ne [Math]::Truncate($requestedRate) -or $requestedRate -lt -10 -or $requestedRate -gt 10) {
        throw 'Speech rate must be an integer from -10 to 10.'
    }
    $Rate = [int]$requestedRate
}
if (!$PSBoundParameters.ContainsKey('Voice') -and $null -ne $episode.voice) { $Voice = $episode.voice }
if ([string]::IsNullOrWhiteSpace($Voice)) { throw 'A voice name is required.' }

$phrases = [ordered]@{}
foreach ($beat in $episode.beats) {
    if ($beat.id -isnot [string] -or $beat.id -cnotmatch '^[a-z0-9][a-z0-9_-]*$' -or $phrases.Contains($beat.id)) {
        throw "Invalid or duplicate speech cue '$($beat.id)'."
    }
    if ($beat.narration -isnot [string] -or $beat.narration -notmatch '[\p{L}\p{N}]') {
        throw "No spoken text for cue '$($beat.id)'."
    }
    $phrases.Add($beat.id, $beat.narration.Trim() + ' ')
}
if (!$phrases.Count) { throw 'At least one speech cue is required.' }
$markedText = foreach ($id in $phrases.Keys) {
    '<mark name="{0}"/>{1}' -f $id, [Security.SecurityElement]::Escape($phrases[$id])
}
$ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">' + ($markedText -join '') + '</speak>'
$ffprobe = (Get-Command ffprobe.exe).Source
Add-Type -AssemblyName System.Speech

$stage = $target + '.' + [Guid]::NewGuid().ToString('N')
$eventId = 'story-speech-' + [Guid]::NewGuid().ToString('N')
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice($Voice)
    if ($synth.Voice.Culture.Name -ne 'ko-KR') { throw 'This speech adapter requires an installed Korean voice.' }
    $synth.Rate = $Rate
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $wav = Join-Path $stage 'narration.wav'
    # The tested Heami voice uses the 16 kHz WAV clock for these speech events.
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono)
    Register-ObjectEvent $synth BookmarkReached -SourceIdentifier $eventId
    Register-ObjectEvent $synth SpeakProgress -SourceIdentifier "$eventId-words"
    $synth.SetOutputToWaveFile($wav, $format)
    $synth.SpeakSsml($ssml)
    $synth.SetOutputToNull()

    $length = & $ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 $wav
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect WAV.' }
    $duration = [double]::Parse($length, [Globalization.CultureInfo]::InvariantCulture)
    if ([double]::IsNaN($duration) -or [double]::IsInfinity($duration) -or $duration -le 0) { throw 'Invalid speech duration.' }
    $marks = [ordered]@{}
    $previous = -1
    foreach ($event in @(Get-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue)) {
        $mark = $event.SourceEventArgs
        $time = $mark.AudioPosition.TotalSeconds
        if ($time -le $previous -or $time -ge $duration) { throw "Invalid bookmark '$($mark.Bookmark)' at $time." }
        $marks.Add($mark.Bookmark, $time)
        $previous = $time
    }
    if (($marks.Keys -join '|') -cne ($phrases.Keys -join '|')) { throw 'Missing or reordered speech bookmarks.' }

    # A bookmark may fall in the preceding pause. The first spoken word after it
    # provides the actual cue onset; the next bookmark excludes other phrases.
    $words = @(Get-Event -SourceIdentifier "$eventId-words" -ErrorAction SilentlyContinue | ForEach-Object { $_.SourceEventArgs })
    $ids = @($marks.Keys)
    $wordStarts = [ordered]@{}
    $previous = -1
    for ($i = 0; $i -lt $ids.Count; $i++) {
        $id = $ids[$i]
        $nextMark = if ($i + 1 -lt $ids.Count) { $marks[$ids[$i + 1]] } else { $duration }
        $word = $words | Where-Object {
            $_.Text -match '[\p{L}\p{N}]' -and $_.AudioPosition.TotalSeconds -ge $marks[$id] -and
            $_.AudioPosition.TotalSeconds -lt $nextMark
        } | Select-Object -First 1
        if (!$word) { throw "Missing first spoken word for cue '$id'." }
        $onset = $word.AudioPosition.TotalSeconds
        if ($onset -le $previous) { throw "Out-of-order word onset for cue '$id'." }
        $wordStarts[$id] = $onset
        $previous = $onset
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $audioHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($wav))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    $timing = [ordered]@{
        text = ($phrases.Values -join '').TrimEnd(); voice = $synth.Voice.Name; rate = $Rate
        durationSeconds = $duration; audioSha256 = $audioHash
        marks = $marks; wordStarts = $wordStarts
    }
    $json = $timing | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $stage 'timing.json'), $json)
    [IO.Directory]::Move($stage, $target)
    $json
} finally {
    Unregister-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue
    Unregister-Event -SourceIdentifier "$eventId-words" -ErrorAction SilentlyContinue
    Remove-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue
    Remove-Event -SourceIdentifier "$eventId-words" -ErrorAction SilentlyContinue
    $synth.Dispose()
    if (Test-Path -LiteralPath $stage) {
        [IO.File]::Delete((Join-Path $stage 'narration.wav'))
        [IO.File]::Delete((Join-Path $stage 'timing.json'))
        [IO.Directory]::Delete($stage)
    }
}
