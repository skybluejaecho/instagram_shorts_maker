$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    # Enumeration only: do not select a voice, synthesize speech or write files.
    $voices = @($synth.GetInstalledVoices() | ForEach-Object {
        [pscustomobject]@{
            name = $_.VoiceInfo.Name
            culture = $_.VoiceInfo.Culture.Name
            enabled = [bool]$_.Enabled
        }
    })
    ConvertTo-Json -InputObject $voices -Depth 4 -Compress
}
finally {
    $synth.Dispose()
}
