param(
    [string] $OutputDirectory = (Join-Path $PSScriptRoot 'generated'),
    [ValidateRange(-10, 10)] [int] $Rate = 2,
    [string] $EpisodePath = (Join-Path $PSScriptRoot 'episode.json')
)

# Windows PowerShell 5.1, Microsoft Heami Desktop and ffprobe on PATH.
$ErrorActionPreference = 'Stop'
$target = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $target) { throw "Choose a new output directory: $target" }
$ffprobe = (Get-Command ffprobe.exe).Source
Add-Type -AssemblyName System.Speech

# Each bookmark precedes the phrase whose onset triggers the corresponding visual.
$episode = Get-Content -Raw -Encoding UTF8 -LiteralPath $EpisodePath | ConvertFrom-Json
$phrases = [ordered]@{}
foreach ($beat in $episode.beats) {
    if ([string]::IsNullOrWhiteSpace($beat.narration)) { throw "No narration for beat '$($beat.id)'." }
    $phrases.Add($beat.id, $beat.narration.Trim() + ' ')
}
if (($phrases.Keys -join '|') -ne 'hook|sorted|first|right|second|left|found|conclusion') {
    throw 'Unexpected sequence of binary search cues.'
}
$markedText = foreach ($id in $phrases.Keys) {
    '<mark name="{0}"/>{1}' -f $id, [Security.SecurityElement]::Escape($phrases[$id])
}
$ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">' + ($markedText -join '') + '</speak>'

$stage = $target + '.' + [Guid]::NewGuid().ToString('N')
$eventId = 'heami-' + [Guid]::NewGuid().ToString('N')
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $synth.SelectVoice('Microsoft Heami Desktop')
    $synth.Rate = $Rate
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $wav = Join-Path $stage 'narration.wav'
    # With this installed voice, 16 kHz keeps BookmarkReached offsets on the WAV clock.
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
    $marks = [ordered]@{}
    $previous = -1
    foreach ($event in @(Get-Event -SourceIdentifier $eventId -ErrorAction SilentlyContinue)) {
        $mark = $event.SourceEventArgs
        $time = $mark.AudioPosition.TotalSeconds
        if ($time -le $previous -or $time -gt $duration) {
            throw "Out-of-order bookmark $($mark.Bookmark) at $time after $previous, WAV duration $duration."
        }
        $marks.Add($mark.Bookmark, $time)
        $previous = $time
    }
    if (($marks.Keys -join '|') -ne ($phrases.Keys -join '|')) { throw 'Missing or reordered speech bookmarks.' }
    # Korean SAPI bookmarks can precede the onset of the marked word, particularly after punctuation.
    $words = @(Get-Event -SourceIdentifier "$eventId-words" | ForEach-Object { $_.SourceEventArgs })
    $ids = @($marks.Keys)
    $wordStarts = [ordered]@{}
    for ($i = 0; $i -lt $ids.Count; $i++) {
        $id = $ids[$i]
        $expectedWord = ($phrases[$id] -split ' ')[0].TrimEnd([char[]]'.,?!')
        $nextMark = if ($i + 1 -lt $ids.Count) { $marks[$ids[$i + 1]] } else { $duration }
        $word = $words | Where-Object {
            $_.Text -eq $expectedWord -and $_.AudioPosition.TotalSeconds -ge $marks[$id] -and
            $_.AudioPosition.TotalSeconds -lt $nextMark
        } | Select-Object -First 1
        if (!$word) { throw "Missing word onset '$expectedWord' for bookmark '$id'." }
        $wordStarts[$id] = $word.AudioPosition.TotalSeconds
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
